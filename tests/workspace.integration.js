// Integration test against the REAL database, exercising the REAL functions.
//
//   node tests/workspace.integration.js
//
// Creates one throwaway user with a shop AND a household, proves the two
// ledgers cannot see each other, then deletes everything it created.
// Existing data is never touched. Needs DATABASE_URL. No AI key.

import "dotenv/config";

import {
  pool,
  findOrCreateUser,
  createMessage,
  updateMessageStatus,
  updateMessageTransactionData,
  confirmMessageTransaction,
  getCustomerByName,
  getTransactionsByDate,
  getWorkspaces,
  getActiveWorkspace,
  createWorkspace,
  setActiveWorkspace,
} from "../src/database/postgres.js";

import { getDailySummary } from "../src/services/summary.service.js";

const U_TG = 999000003;
const OTHER_TG = 999000004;
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// Pushes one transaction through the real confirmation flow, into whichever
// workspace the message is stamped with.
async function submitAndConfirm(user, workspace, msgId, transaction) {
  const saved = await createMessage({
    user_id: user.id,
    workspace_id: workspace.id,
    telegram_message_id: msgId,
    message_text: transaction.description,
    status: "RECEIVED",
  });
  await updateMessageStatus(saved.id, "PROCESSING");
  await updateMessageTransactionData(saved.id, { ...transaction, telegram_message_id: msgId });
  await updateMessageStatus(saved.id, "PENDING_CONFIRMATION");
  return { saved, result: await confirmMessageTransaction(saved.id, user.id) };
}

function txn(type, amount, description, category, person = null) {
  return {
    transaction_type: type,
    description,
    category,
    quantity: 1,
    amount,
    person,
    transaction_date: TODAY,
    notes: null,
  };
}

const user = await findOrCreateUser({ telegram_user_id: U_TG, telegram_chat_id: U_TG, first_name: "Both", username: "both" });
const other = await findOrCreateUser({ telegram_user_id: OTHER_TG, telegram_chat_id: OTHER_TG, first_name: "Other", username: "other" });

try {
  console.log("\n--- Creating workspaces ---");
  const shop = await createWorkspace(user.id, "My Shop", "shopkeeper");
  const home = await createWorkspace(user.id, "My Home", "household");
  check("shop workspace created", shop.type, "shopkeeper");
  check("home workspace created", home.type, "household");
  check("user has exactly 2 workspaces", (await getWorkspaces(user.id)).length, 2);

  console.log("\n--- Adding the same workspace twice is idempotent ---");
  // "+ Add Household" is a button, and buttons get double-tapped.
  const homeAgain = await createWorkspace(user.id, "My Home", "household");
  check("second add returns the SAME workspace", homeAgain.id, home.id);
  check("still exactly 2 workspaces", (await getWorkspaces(user.id)).length, 2);

  console.log("\n--- Switching ---");
  await setActiveWorkspace(user.id, shop.id);
  check("active is the shop", (await getActiveWorkspace(user.id)).id, shop.id);
  await setActiveWorkspace(user.id, home.id);
  check("active is the home", (await getActiveWorkspace(user.id)).id, home.id);

  console.log("\n--- A forged workspace id cannot be switched into ---");
  // callback_data comes from the user's Telegram client, so `ws:<uuid>` is
  // something anyone can send. Pointing it at someone else's workspace must
  // change nothing.
  const otherShop = await createWorkspace(other.id, "My Shop", "shopkeeper");
  const stolen = await setActiveWorkspace(user.id, otherShop.id);
  check("switch to another user's workspace refused", stolen, undefined);
  check("active workspace unchanged", (await getActiveWorkspace(user.id)).id, home.id);

  console.log("\n--- Recording into each ledger ---");
  await submitAndConfirm(user, shop, 6001, txn("credit_sale", 2000, "goods on udhaar", "udhaar", "Raj"));
  await submitAndConfirm(user, shop, 6002, txn("sale", 1000, "sold shirts", "clothing"));
  await submitAndConfirm(user, home, 6003, txn("expense", 500, "groceries", "groceries"));
  await submitAndConfirm(user, home, 6004, txn("income", 65000, "salary", "salary"));
  await submitAndConfirm(user, home, 6005, txn("expense", 2400, "electricity bill", "electricity"));

  console.log("\n--- ISOLATION: neither ledger sees the other ---");
  const shopRows = await getTransactionsByDate(user.id, shop.id, TODAY);
  const homeRows = await getTransactionsByDate(user.id, home.id, TODAY);
  check("shop sees only its 2 rows", shopRows.length, 2);
  check("home sees only its 3 rows", homeRows.length, 3);
  check("no home row leaks into the shop", shopRows.every(r => r.workspace_id === shop.id), true);
  check("no shop row leaks into the home", homeRows.every(r => r.workspace_id === home.id), true);
  check("groceries are not in the shop", shopRows.some(r => r.category === "groceries"), false);
  check("udhaar is not in the home", homeRows.some(r => r.transaction_type === "credit_sale"), false);

  console.log("\n--- Summaries are workspace-shaped ---");
  const shopSummary = await getDailySummary(user.id, shop.id, TODAY, "shopkeeper");
  check("shop sales include the credit sale", shopSummary.totalSales, 3000);
  check("shop expenses exclude the household bill", shopSummary.totalExpenses, 0);

  const homeSummary = await getDailySummary(user.id, home.id, TODAY, "household");
  check("home income", homeSummary.totalIncome, 65000);
  check("home expenses", homeSummary.totalExpenses, 2900);
  check("home balance", homeSummary.balance, 62100);
  check("home sees no sales figure at all", "totalSales" in homeSummary, false);
  check(
    "biggest household category first",
    homeSummary.byCategory.map(c => [c.category, c.total]),
    [["electricity", 2400], ["groceries", 500]]
  );

  console.log("\n--- A household entry never opens a khata ---");
  check("no customer row created by household spending", !!(await getCustomerByName(user.id, "groceries")), false);
  const homeCustomerLinks = (await pool.query(
    "SELECT COUNT(*)::int c FROM transactions WHERE workspace_id=$1 AND customer_id IS NOT NULL", [home.id]
  )).rows[0].c;
  check("no household transaction is linked to a customer", homeCustomerLinks, 0);

  console.log("\n--- Switching workspace before tapping Confirm ---");
  // The real hazard: the message arrives in the shop, the user switches to
  // the home, THEN taps Confirm. The transaction must follow the message,
  // not the user's current setting.
  await setActiveWorkspace(user.id, shop.id);
  const pending = await createMessage({
    user_id: user.id,
    workspace_id: shop.id,
    telegram_message_id: 6006,
    message_text: "sold rice",
    status: "RECEIVED",
  });
  await updateMessageTransactionData(pending.id, { ...txn("sale", 750, "sold rice", "grain"), telegram_message_id: 6006 });
  await updateMessageStatus(pending.id, "PENDING_CONFIRMATION");

  // ... user switches to the household here, then taps Confirm ...
  await setActiveWorkspace(user.id, home.id);
  const confirmed = await confirmMessageTransaction(pending.id, user.id);

  check("confirm succeeded", confirmed.success, true);
  check("transaction filed in the SHOP, not the active home", confirmed.transaction.workspace_id, shop.id);
  check("shop now has 3 rows", (await getTransactionsByDate(user.id, shop.id, TODAY)).length, 3);
  check("home still has 3 rows", (await getTransactionsByDate(user.id, home.id, TODAY)).length, 3);

} finally {
  console.log("\n--- CLEANUP ---");
  for (const u of [user, other]) {
    await pool.query("DELETE FROM transactions WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM messages WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM customers WHERE user_id=$1", [u.id]);
    // users.active_workspace_id points AT workspaces, so it has to let go
    // before the workspace row can be deleted.
    await pool.query("UPDATE users SET active_workspace_id=NULL WHERE id=$1", [u.id]);
    await pool.query("DELETE FROM workspaces WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [u.id]);
  }
  const left = (await pool.query(
    "SELECT COUNT(*)::int c FROM users WHERE telegram_user_id IN ($1,$2)", [U_TG, OTHER_TG]
  )).rows[0].c;
  console.log(`  test users remaining: ${left} (should be 0)`);
  const orphanWorkspaces = (await pool.query("SELECT COUNT(*)::int c FROM workspaces")).rows[0].c;
  console.log(`  workspaces table now: ${orphanWorkspaces} rows`);
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
