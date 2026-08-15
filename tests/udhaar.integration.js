// Integration test against the REAL database, exercising the REAL functions.
// Creates two throwaway shopkeepers, runs the udhaar scenarios, then deletes
// everything it created. Existing data is never touched.

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
  getCustomerTransactions,
  getAllOutstanding,
  getTransactionsByDate,
} from "../src/database/postgres.js";

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
async function submitAndConfirm(user, msgId, transaction) {
  let saved = await createMessage({
    user_id: user.id,
    telegram_message_id: msgId,
    message_text: transaction.description,
    status: "RECEIVED",
  });
  await updateMessageStatus(saved.id, "PROCESSING");
  await updateMessageTransactionData(saved.id, { ...transaction, telegram_message_id: msgId });
  await updateMessageStatus(saved.id, "PENDING_CONFIRMATION");
  return { saved, result: await confirmMessageTransaction(saved.id, user.id) };
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
  const cancelMsg = await createMessage({ user_id: userA.id, telegram_message_id: 5006, message_text: "cancel me", status: "RECEIVED" });
  await updateMessageTransactionData(cancelMsg.id, { ...txn("credit_sale", "Vijay", 900, "cancelled"), telegram_message_id: 5006 });
  await updateMessageStatus(cancelMsg.id, "PENDING_CONFIRMATION");
  await updateMessageStatus(cancelMsg.id, "CANCELLED");
  const cancelled = await confirmMessageTransaction(cancelMsg.id, userA.id);
  check("confirm after cancel is refused", cancelled.reason, "ALREADY_PROCESSED");
  check("no Vijay customer created", !!(await getCustomerByName(userA.id, "Vijay")), false);

  console.log("\n--- ANSWERED status is accepted ---");
  const qMsg = await createMessage({ user_id: userA.id, telegram_message_id: 5007, message_text: "how much does Raj owe", status: "RECEIVED" });
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
  const aToday = await getTransactionsByDate(userA.id, TODAY);
  const bToday = await getTransactionsByDate(userB.id, TODAY);
  check("shop A sees only its own 5 rows", aToday.length, 5);
  check("shop B sees only its own 1 row", bToday.length, 1);
  check("no row of B leaks into A", aToday.every(r => r.user_id === userA.id), true);

  console.log("\n--- Non-customer transaction has no customer_id ---");
  await submitAndConfirm(userA, 5008, { ...txn("payment_sent", null, 3000, "paid supplier"), person: null });
  const supplier = (await pool.query(
    "SELECT customer_id FROM transactions WHERE user_id=$1 AND telegram_message_id='5008'", [userA.id]
  )).rows[0];
  check("supplier payment has NULL customer_id", supplier.customer_id, null);

} finally {
  console.log("\n--- CLEANUP ---");
  for (const u of [userA, userB]) {
    await pool.query("DELETE FROM transactions WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM messages WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM customers WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [u.id]);
  }
  const left = (await pool.query(
    "SELECT COUNT(*)::int c FROM users WHERE telegram_user_id IN ($1,$2)", [A_TG, B_TG]
  )).rows[0].c;
  console.log(`  test users remaining: ${left} (should be 0)`);
  const total = (await pool.query("SELECT COUNT(*)::int c FROM transactions")).rows[0].c;
  console.log(`  transactions table back to: ${total} rows (was 19)`);
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
