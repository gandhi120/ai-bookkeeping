// Integration test against the REAL database, exercising the REAL functions.
// Creates two throwaway shopkeepers, runs the udhaar scenarios, then deletes
// everything it created. Existing data is never touched.

import "dotenv/config";

import { pool } from "../src/database/pool.js";
import { findOrCreateUser } from "../src/database/users.js";
import { createWorkspace, setActiveWorkspace } from "../src/database/workspaces.js";
import {
  confirmMessageTransaction,
  getTransactionsByDate,
} from "../src/database/transactions.js";
import {
  createMessage,
  updateMessageStatus,
  updateMessageTransactionData,
} from "../src/database/messages.js";
import {
  getCustomerByName,
  getCustomerBalance,
  getCustomerTransactions,
  getAllOutstanding,
} from "../src/database/customers.js";

const A_TG = 999000001;
const B_TG = 999000002;
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// Pushes one transaction all the way through the real confirmation flow.
// typeOverride simulates the shopkeeper tapping a clarification button.
async function submitAndConfirm(user, msgId, transaction, typeOverride = null) {
  let saved = await createMessage({
    user_id: user.id,
    workspace_id: SHOP[user.id].id,
    telegram_message_id: msgId,
    message_text: transaction.description,
    status: "RECEIVED",
  });
  await updateMessageStatus(saved.id, "PROCESSING");
  await updateMessageTransactionData(saved.id, { ...transaction, telegram_message_id: msgId });
  await updateMessageStatus(saved.id, "PENDING_CONFIRMATION");
  return { saved, result: await confirmMessageTransaction(saved.id, user.id, typeOverride) };
}

function txn(type, person, amount, description) {
  return {
    transaction_type: type,
    description,
    category: "udhaar",
    quantity: 1,
    amount,
    person,
    transaction_date: TODAY,
    notes: null,
  };
}

const userA = await findOrCreateUser({ telegram_user_id: A_TG, telegram_chat_id: A_TG, first_name: "ShopA", username: "shop_a" });
const userB = await findOrCreateUser({ telegram_user_id: B_TG, telegram_chat_id: B_TG, first_name: "ShopB", username: "shop_b" });

// Every shopkeeper now writes into a workspace. These tests are all about the
// shop ledger, so both users get one shop workspace and stay in it —
// workspace switching is covered in workspace.integration.js.
const SHOP = {};

for (const u of [userA, userB]) {
  SHOP[u.id] = await createWorkspace(u.id, "My Shop", "shopkeeper");
  await setActiveWorkspace(u.id, SHOP[u.id].id);
}

try {
  console.log("\n--- Test 4: credit sale creates customer + balance ---");
  await submitAndConfirm(userA, 5001, txn("credit_sale", "Raj", 2000, "goods on udhaar"));
  let rajA = await getCustomerByName(userA.id, "Raj");
  check("customer Raj created for shop A", !!rajA, true);
  check("Raj owes 2000", await getCustomerBalance(userA.id, rajA.id), 2000);

  console.log("\n--- Test 5: partial repayment ---");
  await submitAndConfirm(userA, 5002, txn("repayment", "Raj", 1000, "part payment"));
  check("Raj owes 1000 after paying 1000", await getCustomerBalance(userA.id, rajA.id), 1000);

  console.log("\n--- Test 6: full repayment ---");
  await submitAndConfirm(userA, 5003, txn("repayment", "Raj", 1000, "cleared"));
  check("Raj owes 0 after clearing", await getCustomerBalance(userA.id, rajA.id), 0);

  console.log("\n--- Case-insensitive name resolves to same khata ---");
  await submitAndConfirm(userA, 5004, txn("credit_sale", "RAJ", 500, "uppercase name"));
  const customersA = (await pool.query("SELECT * FROM customers WHERE user_id=$1", [userA.id])).rows;
  check("still only ONE Raj row for shop A", customersA.length, 1);
  check("Raj owes 500 (uppercase merged)", await getCustomerBalance(userA.id, rajA.id), 500);

  console.log("\n--- Test 9: SAME NAME, DIFFERENT SHOPKEEPER (isolation) ---");
  await submitAndConfirm(userB, 5001, txn("credit_sale", "Raj", 500, "B's Raj"));
  const rajB = await getCustomerByName(userB.id, "Raj");
  check("shop B has its own Raj row", rajB.id !== rajA.id, true);
  check("B's Raj owes 500", await getCustomerBalance(userB.id, rajB.id), 500);
  check("A's Raj still owes 500 (unaffected)", await getCustomerBalance(userA.id, rajA.id), 500);
  check("A cannot read B's Raj balance", await getCustomerBalance(userA.id, rajB.id), 0);
  check("B cannot read A's Raj balance", await getCustomerBalance(userB.id, rajA.id), 0);

  console.log("\n--- Bug A fix: same telegram_message_id 5001 for BOTH shopkeepers ---");
  const bothRows = (await pool.query(
    "SELECT user_id FROM transactions WHERE telegram_message_id='5001'"
  )).rows;
  check("both shopkeepers stored message id 5001", bothRows.length, 2);

  console.log("\n--- Test 10: double confirm ---");
  const { saved, result: first } = await submitAndConfirm(userA, 5005, txn("credit_sale", "Amit", 300, "double tap"));
  const second = await confirmMessageTransaction(saved.id, userA.id);
  check("first confirm succeeds", first.success, true);
  check("second confirm refused", second.reason, "ALREADY_PROCESSED");
  const amitRows = (await pool.query(
    "SELECT COUNT(*)::int c FROM transactions WHERE user_id=$1 AND telegram_message_id='5005'", [userA.id]
  )).rows[0].c;
  check("exactly ONE transaction row created", amitRows, 1);

  console.log("\n--- Test 11: cancel creates nothing ---");
  const cancelMsg = await createMessage({ user_id: userA.id, workspace_id: SHOP[userA.id].id, telegram_message_id: 5006, message_text: "cancel me", status: "RECEIVED" });
  await updateMessageTransactionData(cancelMsg.id, { ...txn("credit_sale", "Vijay", 900, "cancelled"), telegram_message_id: 5006 });
  await updateMessageStatus(cancelMsg.id, "PENDING_CONFIRMATION");
  await updateMessageStatus(cancelMsg.id, "CANCELLED");
  const cancelled = await confirmMessageTransaction(cancelMsg.id, userA.id);
  check("confirm after cancel is refused", cancelled.reason, "ALREADY_PROCESSED");
  check("no Vijay customer created", !!(await getCustomerByName(userA.id, "Vijay")), false);

  console.log("\n--- ANSWERED status is accepted ---");
  const qMsg = await createMessage({ user_id: userA.id, workspace_id: SHOP[userA.id].id, telegram_message_id: 5007, message_text: "how much does Raj owe", status: "RECEIVED" });
  const answered = await updateMessageStatus(qMsg.id, "ANSWERED");
  check("message marked ANSWERED", answered.status, "ANSWERED");

  console.log("\n--- Test 8: customer history ---");
  const history = await getCustomerTransactions(userA.id, rajA.id);
  check("Raj has 4 khata entries", history.length, 4);

  console.log("\n--- /udhaar overview ---");
  const outstanding = await getAllOutstanding(userA.id);
  check("shop A has 2 customers owing money", outstanding.length, 2);
  check("sorted largest first: Raj 500", [outstanding[0].name, Number(outstanding[0].outstanding)], ["Raj", 500]);

  console.log("\n--- Bug B fix: /transactions is user-scoped ---");
  const aToday = await getTransactionsByDate(userA.id, SHOP[userA.id].id, TODAY);
  const bToday = await getTransactionsByDate(userB.id, SHOP[userB.id].id, TODAY);
  check("shop A sees only its own 5 rows", aToday.length, 5);
  check("shop B sees only its own 1 row", bToday.length, 1);
  check("no row of B leaks into A", aToday.every(r => r.user_id === userA.id), true);

  console.log("\n--- Non-customer transaction has no customer_id ---");
  await submitAndConfirm(userA, 5008, { ...txn("payment_sent", null, 3000, "paid supplier"), person: null });
  const supplier = (await pool.query(
    "SELECT customer_id FROM transactions WHERE user_id=$1 AND telegram_message_id='5008'", [userA.id]
  )).rows[0];
  check("supplier payment has NULL customer_id", supplier.customer_id, null);

  // The blocker fix: "Received 5000 from Raj" arrives as payment_received and
  // the shopkeeper's button decides what it really was. Both answers are
  // driven from the SAME stored transaction_data, so the override is what
  // must reach the database — not the AI's original guess.
  console.log("\n--- Ambiguous payment clarified as UDHAAR REPAYMENT ---");
  const before = await getCustomerBalance(userA.id, rajA.id);
  await submitAndConfirm(
    userA, 5009, txn("payment_received", "Raj", 200, "received from Raj"), "repayment"
  );
  const repaid = (await pool.query(
    "SELECT transaction_type, customer_id FROM transactions WHERE user_id=$1 AND telegram_message_id='5009'", [userA.id]
  )).rows[0];
  check("stored as repayment, not the AI's payment_received", repaid.transaction_type, "repayment");
  check("linked to Raj's khata", repaid.customer_id, rajA.id);
  check("balance dropped by 200", await getCustomerBalance(userA.id, rajA.id), before - 200);

  console.log("\n--- Ambiguous payment clarified as NORMAL PAYMENT ---");
  const beforeIncome = await getCustomerBalance(userA.id, rajA.id);
  await submitAndConfirm(
    userA, 5010, txn("payment_received", "Raj", 700, "received from Raj"), "payment_received"
  );
  const income = (await pool.query(
    "SELECT transaction_type, customer_id, person FROM transactions WHERE user_id=$1 AND telegram_message_id='5010'", [userA.id]
  )).rows[0];
  check("stored as payment_received", income.transaction_type, "payment_received");
  check("NOT linked to a khata", income.customer_id, null);
  check("person is still recorded", income.person, "Raj");
  check("balance unmoved", await getCustomerBalance(userA.id, rajA.id), beforeIncome);

  console.log("\n--- Double tap on a clarification button ---");
  const { saved: clarifySaved, result: firstTap } = await submitAndConfirm(
    userA, 5011, txn("payment_received", "Raj", 100, "double tapped"), "repayment"
  );
  const secondTap = await confirmMessageTransaction(clarifySaved.id, userA.id, "payment_received");
  check("first tap succeeds", firstTap.success, true);
  check("second tap refused", secondTap.reason, "ALREADY_PROCESSED");
  const tapRows = (await pool.query(
    "SELECT COUNT(*)::int c FROM transactions WHERE user_id=$1 AND telegram_message_id='5011'", [userA.id]
  )).rows[0].c;
  check("exactly ONE row despite two different answers", tapRows, 1);

  // ------------------------------------------------------------------
  // SEVERAL ENTRIES FROM ONE MESSAGE
  // ------------------------------------------------------------------
  //
  // Until migration 005 the database physically refused this: a UNIQUE
  // (user_id, telegram_message_id) meant one message could hold one
  // transaction, and the ON CONFLICT DO NOTHING in the insert would have
  // swallowed entries 2..N while still reporting success.
  console.log("\n--- SEVERAL ENTRIES FROM ONE MESSAGE ---");

  const batchMsgId = 990001;

  let batchSaved = await createMessage({
    user_id: userA.id,
    workspace_id: SHOP[userA.id].id,
    telegram_message_id: batchMsgId,
    message_text: "dudh 400, sabu 300, chokha 600",
    status: "RECEIVED",
  });

  await updateMessageStatus(batchSaved.id, "PROCESSING");
  await updateMessageTransactionData(
    batchSaved.id,
    [
      { ...txn("purchase", null, 400, "dudh"), telegram_message_id: batchMsgId, seq: 0 },
      { ...txn("purchase", null, 300, "sabu"), telegram_message_id: batchMsgId, seq: 1 },
      { ...txn("credit_sale", "BatchRaj", 600, "chokha"), telegram_message_id: batchMsgId, seq: 2 },
    ]
  );
  await updateMessageStatus(batchSaved.id, "PENDING_CONFIRMATION");

  const batch = await confirmMessageTransaction(batchSaved.id, userA.id);

  check("three entries confirm in one tap", batch.transactions.length, 3);
  check("they come back in order", batch.transactions.map((t) => t.seq), [0, 1, 2]);
  check("amounts survive intact", batch.transactions.map((t) => Number(t.amount)), [400, 300, 600]);

  const batchRows = (await pool.query(
    "SELECT COUNT(*)::int c FROM transactions WHERE user_id=$1 AND telegram_message_id=$2",
    [userA.id, String(batchMsgId)]
  )).rows[0].c;

  check("all three actually reached the table", batchRows, 3);

  // The khata entry inside the batch still opened a customer ledger.
  const batchCustomer = await getCustomerByName(userA.id, "BatchRaj");

  check("the udhaar entry in the batch still opened a khata", Boolean(batchCustomer), true);
  check("and its balance is right", await getCustomerBalance(userA.id, batchCustomer.id), 600);

  // The message is CONFIRMED, so a second tap must add nothing. This is the
  // guard that replaced the old per-message unique constraint.
  const batchAgain = await confirmMessageTransaction(batchSaved.id, userA.id);

  check("a second tap is refused", batchAgain.reason, "ALREADY_PROCESSED");

  const batchRowsAfter = (await pool.query(
    "SELECT COUNT(*)::int c FROM transactions WHERE user_id=$1 AND telegram_message_id=$2",
    [userA.id, String(batchMsgId)]
  )).rows[0].c;

  check("still three rows, not six", batchRowsAfter, 3);

  // ALL OR NOTHING. One bad entry must leave the whole message unwritten —
  // that is what the single Confirm button promises.
  const badMsgId = 990002;

  let badSaved = await createMessage({
    user_id: userA.id,
    workspace_id: SHOP[userA.id].id,
    telegram_message_id: badMsgId,
    message_text: "one good, one impossible",
    status: "RECEIVED",
  });

  await updateMessageStatus(badSaved.id, "PROCESSING");
  await updateMessageTransactionData(
    badSaved.id,
    [
      { ...txn("purchase", null, 100, "fine"), telegram_message_id: badMsgId, seq: 0 },
      // Every column in `transactions` is nullable, so a null cannot be used
      // to force a failure. A string that will not cast can: the insert binds
      // this as $9::date and Postgres rejects it outright. That is a genuine
      // database-level failure partway through the batch, which is what the
      // all-or-nothing promise has to survive.
      { ...txn("purchase", null, 200, "broken"), transaction_date: "not-a-date", telegram_message_id: badMsgId, seq: 1 },
    ]
  );
  await updateMessageStatus(badSaved.id, "PENDING_CONFIRMATION");

  let threw = false;

  try {
    await confirmMessageTransaction(badSaved.id, userA.id);
  } catch {
    threw = true;
  }

  check("a batch with an unwritable entry throws", threw, true);

  const badRows = (await pool.query(
    "SELECT COUNT(*)::int c FROM transactions WHERE user_id=$1 AND telegram_message_id=$2",
    [userA.id, String(badMsgId)]
  )).rows[0].c;

  check("and writes NOTHING, not even the good entry", badRows, 0);

  const badStatus = (await pool.query(
    "SELECT status FROM messages WHERE id=$1", [badSaved.id]
  )).rows[0].status;

  check("the message is left pending, not falsely confirmed", badStatus, "PENDING_CONFIRMATION");

} finally {
  console.log("\n--- CLEANUP ---");
  for (const u of [userA, userB]) {
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
    "SELECT COUNT(*)::int c FROM users WHERE telegram_user_id IN ($1,$2)", [A_TG, B_TG]
  )).rows[0].c;
  console.log(`  test users remaining: ${left} (should be 0)`);
  const total = (await pool.query("SELECT COUNT(*)::int c FROM transactions")).rows[0].c;
  console.log(`  transactions table back to: ${total} rows`);
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
