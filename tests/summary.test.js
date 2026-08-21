// Self-check for the summary accumulator.
//
//   node tests/summary.test.js
//
// No database and no API key needed — summarize() is pure logic over rows,
// so it can be tested with hand-written rows instead of a real ledger.
//
// Before migration 006 this file guarded a different mistake: someone adding a
// transaction type and forgetting to decide what it meant for the totals, which
// was silent in production because the row saved fine and just never appeared.
// summarize() no longer classifies anything — it reads the `cash` and `udhaar`
// the AI answered — so what this file now guards is that reading.

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
function row(cash, amount, { udhaar = "none", category = "misc" } = {}) {
  return { cash, udhaar, amount: String(amount), category };
}

console.log("\nTotals:");

check("an empty day is all zeros, not NaN", () => {
  const s = summarize([]);
  assert.equal(s.moneyIn, 0);
  assert.equal(s.moneyOut, 0);
  assert.equal(s.net, 0);
  assert.equal(s.onUdhaar, 0);
  assert.equal(s.transactionCount, 0);
});

check("postgres numeric strings are added, not concatenated", () => {
  const s = summarize([row("in", "600"), row("in", "400")]);
  assert.equal(s.moneyIn, 1000, "got string concatenation instead of a sum");
});

check("in and out are counted separately and netted", () => {
  const s = summarize([row("in", 2000), row("out", 800)]);
  assert.equal(s.moneyIn, 2000);
  assert.equal(s.moneyOut, 800);
  assert.equal(s.net, 1200);
});

check("net goes negative when more went out than came in", () => {
  const s = summarize([row("in", 500), row("out", 2000)]);
  assert.equal(s.net, -1500);
});

console.log("\nThe two axes are read independently:");

// This is the whole reason there are two fields. A single enum had to invent a
// name for every combination, and every consumer had to remember what each name
// implied about the OTHER axis.

check("udhaar given moves the khata but not the cash", () => {
  // Goods left, nothing was paid. Counting it as money in would overstate the
  // month; leaving it out entirely would hide it — so it gets its own line.
  const s = summarize([row("none", 2000, { udhaar: "they_owe_more" })]);
  assert.equal(s.moneyIn, 0);
  assert.equal(s.moneyOut, 0);
  assert.equal(s.onUdhaar, 2000);
});

check("a repayment is money in AND a debt going down", () => {
  // The row a one-field model gets wrong. Cash arrived, so it counts; but the
  // sale was already counted when the goods went out on udhaar, so it must not
  // appear in onUdhaar a second time.
  const s = summarize([row("in", 500, { udhaar: "they_owe_less" })]);
  assert.equal(s.moneyIn, 500);
  assert.equal(s.onUdhaar, 0);
});

check("borrowing is money in, and never revenue-looking", () => {
  const s = summarize([row("in", 10000, { udhaar: "i_owe_more" })]);
  assert.equal(s.moneyIn, 10000);
  assert.equal(s.onUdhaar, 0, "money the user BORROWED is not udhaar they gave");
});

check("paying somebody back is money out", () => {
  const s = summarize([row("out", 4000, { udhaar: "i_owe_less" })]);
  assert.equal(s.moneyOut, 4000);
  assert.equal(s.onUdhaar, 0);
});

check("only udhaar GIVEN reaches the onUdhaar line", () => {
  // All four directions at once. onUdhaar answers "how much of this month is
  // still out there unpaid", which is only ever they_owe_more.
  const s = summarize([
    row("none", 100, { udhaar: "they_owe_more" }),
    row("in", 200, { udhaar: "they_owe_less" }),
    row("in", 300, { udhaar: "i_owe_more" }),
    row("out", 400, { udhaar: "i_owe_less" }),
  ]);
  assert.equal(s.onUdhaar, 100);
  assert.equal(s.moneyIn, 500);
  assert.equal(s.moneyOut, 400);
});

console.log("\nRows that say nothing move nothing:");

check("cash none with no udhaar is counted but adds nothing", () => {
  const s = summarize([row("none", 999)]);
  assert.equal(s.moneyIn, 0);
  assert.equal(s.moneyOut, 0);
  assert.equal(s.onUdhaar, 0);
  assert.equal(s.transactionCount, 1, "the row still happened");
});

check("a row with no cash field at all does not become NaN", () => {
  // Defensive: a pre-006 row read straight out of JSONB has neither field.
  const s = summarize([{ amount: "500", category: "misc" }]);
  assert.equal(s.moneyIn, 0);
  assert.equal(s.moneyOut, 0);
  assert.equal(s.net, 0);
});

console.log("\nWhere it went:");

check("only outgoings are broken down by category", () => {
  // A breakdown that mixed salary in with groceries would not answer the
  // question the breakdown exists for.
  const s = summarize([
    row("in", 65000, { category: "salary" }),
    row("out", 2400, { category: "electricity" }),
    row("out", 500, { category: "groceries" }),
  ]);
  assert.deepEqual(
    s.byCategory.map((c) => c.category),
    ["electricity", "groceries"]
  );
});

check("the breakdown is biggest first", () => {
  const s = summarize([
    row("out", 100, { category: "chai" }),
    row("out", 900, { category: "stock" }),
    row("out", 500, { category: "rent" }),
  ]);
  assert.deepEqual(
    s.byCategory.map((c) => c.total),
    [900, 500, 100]
  );
});

check("same category on several rows is summed once", () => {
  const s = summarize([
    row("out", 100, { category: "chai" }),
    row("out", 150, { category: "chai" }),
  ]);
  assert.equal(s.byCategory.length, 1);
  assert.equal(s.byCategory[0].total, 250);
});

check("a missing category lands in 'other', not undefined", () => {
  const s = summarize([{ cash: "out", udhaar: "none", amount: "300" }]);
  assert.equal(s.byCategory[0].category, "other");
});

check("a category the AI invented is kept as-is", () => {
  // `category` is a free string and enumLabel falls back to the raw value, so
  // a Farm ledger gets "khaad" with no change anywhere.
  const s = summarize([row("out", 300, { category: "khaad" })]);
  assert.equal(s.byCategory[0].category, "khaad");
});

console.log("\nCounting:");

check("every row counts, whichever way it went", () => {
  const s = summarize([
    row("in", 1),
    row("out", 1),
    row("none", 1, { udhaar: "they_owe_more" }),
  ]);
  assert.equal(s.transactionCount, 3);
});

console.log(`\n${passed} checks passed`);
