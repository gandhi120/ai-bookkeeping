// Integration test against the REAL database, exercising the REAL functions.
//
//   node tests/workspace.integration.js
//
// Creates one throwaway user with a shop AND a household, proves the two
// ledgers cannot see each other, then deletes everything it created.
// Existing data is never touched. Needs DATABASE_URL. No AI key.

import "dotenv/config";

import { pool } from "../src/database/pool.js";
import { findOrCreateUser } from "../src/database/users.js";
import {
  getWorkspaces,
  getActiveWorkspace,
  createWorkspace,
  setActiveWorkspace,
} from "../src/database/workspaces.js";
import {
  confirmMessageTransaction,
  getTransactionsByDate,
  getTransactionsByMonth,
} from "../src/database/transactions.js";
import {
  createMessage,
  updateMessageStatus,
  updateMessageTransactionData,
} from "../src/database/messages.js";
import {
  getCustomerByName,
  getCustomerBalance,
  getAllOutstanding,
} from "../src/database/customers.js";

import { getDailySummary } from "../src/services/summary.service.js";
import {
  getMonthlySummary,
  getMonthlySummaryAll,
} from "../src/services/monthly-summary.service.js";
import { owedDelta } from "../src/schemas/transaction.schema.js";

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

// The AI answers DIRECTION now, not a type name. `type` here is just the label
// it writes in the user's language — nothing branches on it.
function txn(cash, udhaar, amount, description, category, person = null) {
  return {
    transaction_type: description,
    cash,
    udhaar,
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
  console.log("\n--- Creating ledgers the user named themselves ---");
  const shop = await createWorkspace(user.id, "🏪", "Kirana Store");
  const home = await createWorkspace(user.id, "🏠", "Ghar");
  // A THIRD ledger, which the old UNIQUE (user_id, type) made impossible.
  const bike = await createWorkspace(user.id, "🏍️", "Bike");
  check("the emoji is stored on the row", shop.emoji, "🏪");
  check("the name is what the user typed", shop.name, "Kirana Store");
  check("a third ledger is allowed now", bike.name, "Bike");
  check("user has 3 ledgers", (await getWorkspaces(user.id)).length, 3);

  console.log("\n--- Adding the same ledger twice is idempotent ---");
  // "+ New ledger" is a button, and buttons get double-tapped. Identity is the
  // NAME now, and the index is on lower(name).
  const homeAgain = await createWorkspace(user.id, "🏠", "Ghar");
  check("second add returns the SAME ledger", homeAgain.id, home.id);
  check("a different case is the same ledger", (await createWorkspace(user.id, "🏠", "GHAR")).id, home.id);
  check("still exactly 3 ledgers", (await getWorkspaces(user.id)).length, 3);

  console.log("\n--- Switching ---");
  await setActiveWorkspace(user.id, shop.id);
  check("active is the shop", (await getActiveWorkspace(user.id)).id, shop.id);
  await setActiveWorkspace(user.id, home.id);
  check("active is the home", (await getActiveWorkspace(user.id)).id, home.id);

  console.log("\n--- A forged workspace id cannot be switched into ---");
  // callback_data comes from the user's Telegram client, so `ws:<uuid>` is
  // something anyone can send. Pointing it at someone else's workspace must
  // change nothing.
  const otherShop = await createWorkspace(other.id, "🏪", "Kirana Store");
  const stolen = await setActiveWorkspace(user.id, otherShop.id);
  check("switch to another user's workspace refused", stolen, undefined);
  check("active workspace unchanged", (await getActiveWorkspace(user.id)).id, home.id);

  console.log("\n--- Recording into each ledger ---");
  await submitAndConfirm(user, shop, 6001, txn("none", "they_owe_more", 2000, "goods on udhaar", "udhaar", "Raj"));
  await submitAndConfirm(user, shop, 6002, txn("in", "none", 1000, "sold shirts", "clothing"));
  await submitAndConfirm(user, home, 6003, txn("out", "none", 500, "groceries", "groceries"));
  await submitAndConfirm(user, home, 6004, txn("in", "none", 65000, "salary", "salary"));
  await submitAndConfirm(user, home, 6005, txn("out", "none", 2400, "electricity bill", "electricity"));
  await submitAndConfirm(user, bike, 6010, txn("out", "none", 300, "petrol", "transport"));

  console.log("\n--- ISOLATION: neither ledger sees the other ---");
  const shopRows = await getTransactionsByDate(user.id, shop.id, TODAY);
  const homeRows = await getTransactionsByDate(user.id, home.id, TODAY);
  check("shop sees only its 2 rows", shopRows.length, 2);
  check("home sees only its 3 rows", homeRows.length, 3);
  const bikeRows = await getTransactionsByDate(user.id, bike.id, TODAY);
  check("bike sees only its 1 row", bikeRows.length, 1);
  check("no home row leaks into the shop", shopRows.every(r => r.workspace_id === shop.id), true);
  check("no shop row leaks into the home", homeRows.every(r => r.workspace_id === home.id), true);
  check("no other ledger leaks into the bike", bikeRows.every(r => r.workspace_id === bike.id), true);
  check("groceries are not in the shop", shopRows.some(r => r.category === "groceries"), false);
  check("udhaar is not in the home", homeRows.some(r => r.udhaar !== "none"), false);
  check("petrol is only in the bike", shopRows.concat(homeRows).some(r => r.category === "transport"), false);

  console.log("\n--- Summaries are scoped to one ledger ---");
  const shopSummary = await getDailySummary(user.id, shop.id, TODAY);
  check("shop money in is the cash sale only", shopSummary.moneyIn, 1000);
  check("the udhaar sale is NOT counted as cash", shopSummary.onUdhaar, 2000);
  check("shop money out excludes the household bill", shopSummary.moneyOut, 0);

  const homeSummary = await getDailySummary(user.id, home.id, TODAY);
  check("home money in", homeSummary.moneyIn, 65000);
  check("home money out", homeSummary.moneyOut, 2900);
  check("home net", homeSummary.net, 62100);
  check("home has no udhaar", homeSummary.onUdhaar, 0);
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
  await updateMessageTransactionData(pending.id, { ...txn("in", "none", 750, "sold rice", "grain"), telegram_message_id: 6006 });
  await updateMessageStatus(pending.id, "PENDING_CONFIRMATION");

  // ... user switches to the household here, then taps Confirm ...
  await setActiveWorkspace(user.id, home.id);
  const confirmed = await confirmMessageTransaction(pending.id, user.id);

  check("confirm succeeded", confirmed.success, true);
  check("transaction filed in the SHOP, not the active home", confirmed.transactions[0].workspace_id, shop.id);
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
  check("month view: home has no udhaar", monthHome.some(r => r.udhaar !== "none"), false);

  const monthlyHome = await getMonthlySummary(user.id, home.id, YEAR, MONTH);
  check("monthly household in", monthlyHome.moneyIn, 65000);
  check("monthly household out", monthlyHome.moneyOut, 2900);
  check("monthly household breakdown is ordered", monthlyHome.byCategory.map(c => c.category), ["electricity", "groceries"]);

  const monthlyShop = await getMonthlySummary(user.id, shop.id, YEAR, MONTH);
  check("monthly shop out excludes the household entirely", monthlyShop.moneyOut, 0);

  console.log("\n--- The all-ledgers view crosses ledgers, and only this user ---");
  const all = await getMonthlySummaryAll(user.id, YEAR, MONTH);
  check("all three ledgers appear", all.ledgers.map(l => l.name).sort(), ["Bike", "Ghar", "Kirana Store"]);
  check("ledgers come back in creation order", all.ledgers.map(l => l.name), ["Kirana Store", "Ghar", "Bike"]);
  check("the grand total nets every ledger", all.total.net, 1750 + 62100 - 300);
  check("the grand total carries the udhaar line", all.total.onUdhaar, 2000);
  check("the other user is nowhere in it", all.ledgers.some(l => l.name === "Their Home"), false);

  const theirAll = await getMonthlySummaryAll(other.id, YEAR, MONTH);
  check("the other user's view is their own", theirAll.ledgers.every(l => l.name !== "Ghar"), true);

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
  const otherHome = await createWorkspace(other.id, "🏠", "Their Home");
  await setActiveWorkspace(other.id, otherHome.id);
  await submitAndConfirm(other, otherHome, 6200, txn("out", "none", 111, "their groceries", "groceries"));

  check("other user's home has its own row", (await getTransactionsByDate(other.id, otherHome.id, TODAY)).length, 1);
  check("our home is unchanged by theirs", (await getTransactionsByDate(user.id, home.id, TODAY)).length, 3);
  check("we cannot read their home with our user id", (await getTransactionsByDate(user.id, otherHome.id, TODAY)).length, 0);
  check("they cannot read our home with their user id", (await getTransactionsByDate(other.id, home.id, TODAY)).length, 0);

  console.log("\n--- Both users may own a ledger of the same NAME ---");
  // The unique index is (user_id, lower(name)). If the user_id half were ever
  // dropped, the second user's "Kirana Store" would collide with the first's —
  // and now that the name is user-supplied, a collision is likely rather than
  // theoretical: half of India would name it the same thing.
  check("their Kirana Store is a different row from ours", otherShop.id !== shop.id, true);
  check("same name, two users, two ledgers", otherShop.name === shop.name, true);

  console.log("\n--- Cancel in a household creates nothing ---");
  const homeCancel = await createMessage({
    user_id: user.id,
    workspace_id: home.id,
    telegram_message_id: 6300,
    message_text: "cancel this",
    status: "RECEIVED",
  });
  await updateMessageTransactionData(homeCancel.id, { ...txn("out", "none", 999, "cancelled snack", "food"), telegram_message_id: 6300 });
  await updateMessageStatus(homeCancel.id, "PENDING_CONFIRMATION");
  await updateMessageStatus(homeCancel.id, "CANCELLED");
  const homeCancelled = await confirmMessageTransaction(homeCancel.id, user.id);
  check("confirm after cancel is refused at home too", homeCancelled.reason, "ALREADY_PROCESSED");
  check("home still has 3 rows after the cancel", (await getTransactionsByDate(user.id, home.id, TODAY)).length, 3);

  console.log("\n--- A name in a household entry is just a note ---");
  // `person` is a free string the AI can populate ("gave Ramesh 500"). At
  // home it must stay a note and never resolve into a khata.
  await submitAndConfirm(user, home, 6400, txn("out", "none", 250, "lunch with Ramesh", "food", "Ramesh"));
  check("no customer named Ramesh was created", !!(await getCustomerByName(user.id, "Ramesh")), false);
  const rameshRow = (await pool.query(
    "SELECT person, customer_id FROM transactions WHERE user_id=$1 AND telegram_message_id='6400'", [user.id]
  )).rows[0];
  check("the name is still recorded on the row", rameshRow.person, "Ramesh");
  check("but it is linked to no khata", rameshRow.customer_id, null);

  console.log("\n--- The khata is signed, and covers both directions ---");
  // getAllOutstanding and getCustomerBalance are user-scoped, not
  // workspace-scoped, because a person owes the USER — Raj does not owe the
  // Kirana ledger. Rows in any ledger can carry a customer_id now.
  const raj = await getCustomerByName(user.id, "Raj");
  check("Raj owes the udhaar, positive", await getCustomerBalance(user.id, raj.id), 2000);

  // Money the USER borrowed. The old enum could not record this at all.
  await submitAndConfirm(user, home, 6500, txn("in", "i_owe_more", 10000, "loan from Mama", "loan", "Mama"));
  const mama = await getCustomerByName(user.id, "Mama");
  check("a borrowed amount reads NEGATIVE", await getCustomerBalance(user.id, mama.id), -10000);

  await submitAndConfirm(user, home, 6501, txn("out", "i_owe_less", 4000, "paid Mama back", "loan", "Mama"));
  check("paying back moves it toward zero", await getCustomerBalance(user.id, mama.id), -6000);

  console.log("\n--- owed_delta is computed by the DATABASE ---");
  // Nothing in JS writes this column, so it needs a real Postgres round trip.
  // owedDelta() in the schema mirrors it for the not-yet-saved preview on the
  // confirmation card; this is what proves the two agree.
  const deltas = (await pool.query(
    `SELECT udhaar, amount, owed_delta FROM transactions
     WHERE user_id=$1 AND udhaar <> 'none' ORDER BY telegram_message_id`, [user.id]
  )).rows;
  check("every udhaar row got a delta", deltas.length, 3);
  check(
    "the sign matches the direction",
    deltas.map(r => [r.udhaar, Number(r.owed_delta)]),
    [["they_owe_more", 2000], ["i_owe_more", -10000], ["i_owe_less", 4000]]
  );
  check(
    "owedDelta() agrees with the generated column",
    deltas.map(r => owedDelta(r) === Number(r.owed_delta)),
    [true, true, true]
  );

  console.log("\n--- Settled khatas drop off the list ---");
  const owing = await getAllOutstanding(user.id);
  check("two people have an open balance", owing.length, 2);
  check("biggest owed-to-user first", Number(owing[0].outstanding), 2000);
  check("and the one the user owes is last", Number(owing.at(-1).outstanding), -6000);
  check("Ramesh never opened a khata", owing.some(c => c.name === "Ramesh"), false);

  // Raj pays up. He should vanish, not sit at zero forever.
  await submitAndConfirm(user, shop, 6600, txn("in", "they_owe_less", 2000, "Raj cleared", "udhaar", "Raj"));
  check("Raj is settled", await getCustomerBalance(user.id, raj.id), 0);
  const afterSettle = await getAllOutstanding(user.id);
  check("a settled customer leaves the list", afterSettle.some(c => c.id === raj.id), false);
  check("only the user's own debt is left", afterSettle.length, 1);

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
