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
  getCustomerBalance,
  getAllOutstanding,
  getTransactionsByDate,
  getTransactionsByMonth,
  getWorkspaces,
  getActiveWorkspace,
  createWorkspace,
  setActiveWorkspace,
} from "../src/database/postgres.js";

import { getDailySummary } from "../src/services/summary.service.js";
import { getMonthlySummary } from "../src/services/monthly-summary.service.js";

const U_TG = 999000003;
const OTHER_TG = 999000004;
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
// The month TODAY falls in, so the /monthly checks look at the rows we just
// created rather than at whatever month the wall clock happens to be in.
const [YEAR, MONTH] = TODAY.split("-").map(Number);

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

  console.log("\n--- /monthly is workspace-scoped too ---");
  // Only getTransactionsByDate was covered before, which left the entire
  // /monthly data path unverified — the command most likely to leak the
  // groceries into the shop, because it spans more days than /summary.
  const monthShop = await getTransactionsByMonth(user.id, shop.id, YEAR, MONTH);
  const monthHome = await getTransactionsByMonth(user.id, home.id, YEAR, MONTH);
  check("month view: no home row in the shop", monthShop.every(r => r.workspace_id === shop.id), true);
  check("month view: no shop row in the home", monthHome.every(r => r.workspace_id === home.id), true);
  check("month view: shop has no groceries", monthShop.some(r => r.category === "groceries"), false);
  check("month view: home has no udhaar", monthHome.some(r => r.transaction_type === "credit_sale"), false);

  const monthlyHome = await getMonthlySummary(user.id, home.id, YEAR, MONTH, "household");
  check("monthly household income", monthlyHome.totalIncome, 65000);
  check("monthly household expenses", monthlyHome.totalExpenses, 2900);
  check("monthly household breakdown is ordered", monthlyHome.byCategory.map(c => c.category), ["electricity", "groceries"]);

  const monthlyShop = await getMonthlySummary(user.id, shop.id, YEAR, MONTH, "shopkeeper");
  check("monthly shop total excludes the household entirely", monthlyShop.totalExpenses, 0);

  console.log("\n--- The database itself refuses an unfiled message ---");
  // App code always stamps workspace_id, but a future caller might forget.
  // This proves the NOT NULL from migration 002 is real, not just respected.
  let rejected = false;
  try {
    await pool.query(
      "INSERT INTO messages (user_id, telegram_message_id, message_text, status) VALUES ($1,$2,$3,$4)",
      [user.id, 6100, "no workspace", "RECEIVED"]
    );
  } catch {
    rejected = true;
  }
  check("a message with no workspace_id cannot be inserted", rejected, true);

  console.log("\n--- Two users, two households, no leaking ---");
  // Isolation was proven WITHIN one user. This proves it across the tenant
  // boundary, where the workspace ids differ AND the user ids differ.
  const otherHome = await createWorkspace(other.id, "My Home", "household");
  await setActiveWorkspace(other.id, otherHome.id);
  await submitAndConfirm(other, otherHome, 6200, txn("expense", 111, "their groceries", "groceries"));

  check("other user's home has its own row", (await getTransactionsByDate(other.id, otherHome.id, TODAY)).length, 1);
  check("our home is unchanged by theirs", (await getTransactionsByDate(user.id, home.id, TODAY)).length, 3);
  check("we cannot read their home with our user id", (await getTransactionsByDate(user.id, otherHome.id, TODAY)).length, 0);
  check("they cannot read our home with their user id", (await getTransactionsByDate(other.id, home.id, TODAY)).length, 0);

  console.log("\n--- Both users may own a workspace of the same type ---");
  // The unique index is (user_id, type). If the user_id half were ever
  // dropped, the second user's shop would collide with the first user's.
  check("their shop is a different row from ours", otherShop.id !== shop.id, true);
  check("their home is a different row from ours", otherHome.id !== home.id, true);

  console.log("\n--- Cancel in a household creates nothing ---");
  const homeCancel = await createMessage({
    user_id: user.id,
    workspace_id: home.id,
    telegram_message_id: 6300,
    message_text: "cancel this",
    status: "RECEIVED",
  });
  await updateMessageTransactionData(homeCancel.id, { ...txn("expense", 999, "cancelled snack", "food"), telegram_message_id: 6300 });
  await updateMessageStatus(homeCancel.id, "PENDING_CONFIRMATION");
  await updateMessageStatus(homeCancel.id, "CANCELLED");
  const homeCancelled = await confirmMessageTransaction(homeCancel.id, user.id);
  check("confirm after cancel is refused at home too", homeCancelled.reason, "ALREADY_PROCESSED");
  check("home still has 3 rows after the cancel", (await getTransactionsByDate(user.id, home.id, TODAY)).length, 3);

  console.log("\n--- A name in a household entry is just a note ---");
  // `person` is a free string the AI can populate ("gave Ramesh 500"). At
  // home it must stay a note and never resolve into a khata.
  await submitAndConfirm(user, home, 6400, txn("expense", 250, "lunch with Ramesh", "food", "Ramesh"));
  check("no customer named Ramesh was created", !!(await getCustomerByName(user.id, "Ramesh")), false);
  const rameshRow = (await pool.query(
    "SELECT person, customer_id FROM transactions WHERE user_id=$1 AND telegram_message_id='6400'", [user.id]
  )).rows[0];
  check("the name is still recorded on the row", rameshRow.person, "Ramesh");
  check("but it is linked to no khata", rameshRow.customer_id, null);

  console.log("\n--- Khata totals ignore household spending ---");
  // getAllOutstanding and getCustomerBalance are user-scoped, not
  // workspace-scoped, because customers belong to the user. That is only
  // safe as long as household rows can never carry a customer_id.
  const raj = await getCustomerByName(user.id, "Raj");
  check("Raj still owes exactly the credit sale", await getCustomerBalance(user.id, raj.id), 2000);
  const owing = await getAllOutstanding(user.id);
  check("only one customer owes anything", owing.length, 1);
  check("and the amount is untouched by groceries", Number(owing[0].outstanding), 2000);

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
  // Count the workspaces THIS TEST could have left behind, not every row in
  // the table — a real user's own workspaces live here too, and reporting the
  // raw total makes a healthy run look like a leak.
  const leaked = (await pool.query(
    `SELECT COUNT(*)::int c FROM workspaces w
     JOIN users u ON u.id = w.user_id
     WHERE u.telegram_user_id IN ($1,$2)`,
    [U_TG, OTHER_TG]
  )).rows[0].c;
  console.log(`  test workspaces leaked: ${leaked} (should be 0)`);
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
