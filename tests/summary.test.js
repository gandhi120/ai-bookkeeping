// Self-check for the summary accumulator.
//
//   node tests/summary.test.js
//
// No database and no API key needed — summarize() is pure logic over rows,
// so it can be tested with hand-written rows instead of a real ledger.
//
// This is the file that breaks when someone adds a transaction type and
// forgets to decide what it means for the totals. That mistake is silent in
// production: the row saves fine and just quietly never appears in /summary.

import assert from "node:assert/strict";

import { summarize } from "../src/services/summary.service.js";

let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

// A ledger row as it comes back from Postgres.
//
// `amount` is a STRING on purpose. node-postgres returns `numeric` as text to
// avoid float precision loss, so summarize() must coerce it. Writing 600 here
// instead of "600" would make these tests pass while production silently
// concatenated strings.
function row(transaction_type, amount, category = "misc") {
  return { transaction_type, amount: String(amount), category };
}

console.log("\nShop totals:");

check("an empty day is all zeros, not NaN", () => {
  const s = summarize([], "shopkeeper");
  assert.equal(s.totalSales, 0);
  assert.equal(s.totalPurchases, 0);
  assert.equal(s.totalExpenses, 0);
  assert.equal(s.netBalance, 0);
  assert.equal(s.transactionCount, 0);
});

check("postgres numeric strings are added, not concatenated", () => {
  const s = summarize([row("sale", "600"), row("sale", "400")], "shopkeeper");
  assert.equal(s.totalSales, 1000, "got string concatenation instead of a sum");
});

check("a credit sale is revenue AND tracked separately", () => {
  // Goods left the shop, so it counts as a sale immediately — but we also
  // need to know how much of the day was unpaid.
  const s = summarize([row("credit_sale", 2000)], "shopkeeper");
  assert.equal(s.totalSales, 2000);
  assert.equal(s.creditSales, 2000);
});

check("a repayment is NOT counted as revenue", () => {
  // The sale was already counted when the goods went out on udhaar.
  // Counting the repayment too would report the same sale twice.
  const s = summarize([row("credit_sale", 2000), row("repayment", 2000)], "shopkeeper");
  assert.equal(s.totalSales, 2000, "repayment double-counted as revenue");
  assert.equal(s.repaymentsReceived, 2000);
});

check("net balance is sales minus purchases minus expenses", () => {
  const s = summarize(
    [row("sale", 5000), row("purchase", 1000), row("expense", 500)],
    "shopkeeper"
  );
  assert.equal(s.netBalance, 3500);
});

check("net balance can go negative", () => {
  const s = summarize([row("purchase", 900)], "shopkeeper");
  assert.equal(s.netBalance, -900);
});

check("money movements that are not revenue affect no total", () => {
  // payment_received / payment_sent / other are deliberately in no bucket.
  // They still count as transactions, so the count is how you notice them.
  const s = summarize(
    [row("payment_received", 5000), row("payment_sent", 3000), row("other", 100)],
    "shopkeeper"
  );
  assert.equal(s.totalSales, 0);
  assert.equal(s.totalPurchases, 0);
  assert.equal(s.totalExpenses, 0);
  assert.equal(s.transactionCount, 3);
});

console.log("\nHousehold totals:");

check("an empty month is all zeros", () => {
  const s = summarize([], "household");
  assert.equal(s.totalIncome, 0);
  assert.equal(s.totalExpenses, 0);
  assert.equal(s.balance, 0);
  assert.deepEqual(s.byCategory, []);
});

check("income minus expenses is the balance", () => {
  const s = summarize(
    [row("income", 65000, "salary"), row("expense", 2400, "electricity")],
    "household"
  );
  assert.equal(s.totalIncome, 65000);
  assert.equal(s.totalExpenses, 2400);
  assert.equal(s.balance, 62600);
});

check("overspending shows a negative balance", () => {
  const s = summarize(
    [row("income", 1000, "salary"), row("expense", 2500, "rent")],
    "household"
  );
  assert.equal(s.balance, -1500);
});

check("the same category is summed, not listed twice", () => {
  const s = summarize(
    [row("expense", 300, "groceries"), row("expense", 200, "groceries")],
    "household"
  );
  assert.deepEqual(s.byCategory, [{ category: "groceries", total: 500 }]);
});

check("categories are sorted biggest first", () => {
  // This is the order the dashboard prints, so it is part of the contract.
  const s = summarize(
    [
      row("expense", 500, "groceries"),
      row("expense", 12000, "rent"),
      row("expense", 2400, "electricity"),
    ],
    "household"
  );
  assert.deepEqual(
    s.byCategory.map((c) => c.category),
    ["rent", "electricity", "groceries"]
  );
});

check("income never appears in the spending breakdown", () => {
  // "Where did the money go?" is not answered by showing the salary.
  const s = summarize(
    [row("income", 65000, "salary"), row("expense", 500, "groceries")],
    "household"
  );
  assert.deepEqual(s.byCategory, [{ category: "groceries", total: 500 }]);
});

check("a missing category falls back to 'other'", () => {
  // The AI is told to always send one, but a null must not become the
  // literal string "null" in the dashboard.
  const s = summarize(
    [
      { transaction_type: "expense", amount: "100", category: null },
      { transaction_type: "expense", amount: "50", category: "" },
    ],
    "household"
  );
  assert.deepEqual(s.byCategory, [{ category: "other", total: 150 }]);
});

check("shop-only types contribute nothing at home", () => {
  // They cannot be recorded there anyway, but if one ever leaked in through
  // a bad migration it must not silently inflate the household totals.
  const s = summarize(
    [row("sale", 5000, "clothing"), row("credit_sale", 2000, "goods")],
    "household"
  );
  assert.equal(s.totalIncome, 0);
  assert.equal(s.totalExpenses, 0);
  assert.deepEqual(s.byCategory, []);
});

console.log("\nThe two shapes stay apart:");

check("a household summary has no sales figures", () => {
  const s = summarize([row("expense", 100, "food")], "household");
  assert.equal("totalSales" in s, false);
  assert.equal("creditSales" in s, false);
  assert.equal("netBalance" in s, false);
});

check("a shop summary has no income or category breakdown", () => {
  const s = summarize([row("sale", 100)], "shopkeeper");
  assert.equal("totalIncome" in s, false);
  assert.equal("balance" in s, false);
  assert.equal("byCategory" in s, false);
});

check("an unknown workspace type falls back to the shop shape", () => {
  // Fail towards the older, better-tested behaviour rather than returning
  // an object with no recognisable fields at all.
  const s = summarize([row("sale", 100)], undefined);
  assert.equal(s.totalSales, 100);
});

check("both shapes always report a transaction count", () => {
  // The bot prints this unconditionally, so a missing count renders
  // "Transactions: undefined".
  assert.equal(summarize([row("sale", 1)], "shopkeeper").transactionCount, 1);
  assert.equal(summarize([row("expense", 1)], "household").transactionCount, 1);
});

console.log(
  `\n${passed} checks passed${process.exitCode ? " — SOME FAILED" : ""}\n`
);
