// Self-check for the AI output validator.
//
// This is the trust boundary: Groq can return anything, and whatever
// passes this schema gets written to the database. Run it with:
//
//   node tests/schema.test.js
//
// No database and no Groq API key needed — this is pure logic.

import assert from "node:assert/strict";

import {
  MessageSchema,
  isCustomerTransaction,
  isTypeAllowedInWorkspace,
  TRANSACTION_TYPES,
  CUSTOMER_TRANSACTION_TYPES,
  WORKSPACE_TYPES,
  HOUSEHOLD_CATEGORIES,
} from "../src/schemas/transaction.schema.js";

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

// A complete, valid transaction. Used as the base for the cases below.
function transaction(overrides = {}) {
  return {
    intent: "transaction",
    transaction_type: "purchase",
    description: "10 kg rice",
    category: "stock",
    quantity: 10,
    amount: 600,
    person: null,
    transaction_date: "2026-08-16",
    notes: null,
    ...overrides,
  };
}

console.log("\nValid input is accepted:");

check("normal purchase", () => {
  const result = MessageSchema.parse(transaction());
  assert.equal(result.intent, "transaction");
  assert.equal(result.amount, 600);
});

check("credit sale keeps the customer name", () => {
  const result = MessageSchema.parse(
    transaction({ transaction_type: "credit_sale", person: "Raj", amount: 2000 })
  );
  assert.equal(result.person, "Raj");
});

check("repayment is a valid type", () => {
  const result = MessageSchema.parse(
    transaction({ transaction_type: "repayment", person: "Raj", amount: 1000 })
  );
  assert.equal(result.transaction_type, "repayment");
});

check("balance query needs only a person", () => {
  const result = MessageSchema.parse({
    intent: "balance_query",
    person: "Raj",
  });
  assert.equal(result.person, "Raj");
});

check("history query needs only a person", () => {
  const result = MessageSchema.parse({
    intent: "history_query",
    person: "Raj",
  });
  assert.equal(result.intent, "history_query");
});

check("every declared type is accepted", () => {
  for (const type of TRANSACTION_TYPES) {
    MessageSchema.parse(transaction({ transaction_type: type }));
  }
});

console.log("\nBad input is rejected before it reaches the database:");

check("hallucinated transaction_type is rejected", () => {
  assert.throws(() => MessageSchema.parse(transaction({ transaction_type: "refund" })));
});

check("missing amount is rejected", () => {
  const bad = transaction();
  delete bad.amount;
  assert.throws(() => MessageSchema.parse(bad));
});

check("null amount is rejected", () => {
  assert.throws(() => MessageSchema.parse(transaction({ amount: null })));
});

check("amount as a string is rejected", () => {
  assert.throws(() => MessageSchema.parse(transaction({ amount: "600" })));
});

check("fractional quantity is rejected", () => {
  assert.throws(() => MessageSchema.parse(transaction({ quantity: 1.5 })));
});

check("unknown intent is rejected", () => {
  assert.throws(() => MessageSchema.parse({ intent: "delete_everything" }));
});

check("missing intent is rejected", () => {
  const bad = transaction();
  delete bad.intent;
  assert.throws(() => MessageSchema.parse(bad));
});

check("balance query with an empty name is rejected", () => {
  assert.throws(() => MessageSchema.parse({ intent: "balance_query", person: "" }));
});

check("balance query without a person is rejected", () => {
  assert.throws(() => MessageSchema.parse({ intent: "balance_query" }));
});

console.log("\nOnly udhaar types are linked to a customer:");

check("credit_sale and repayment are customer transactions", () => {
  assert.equal(isCustomerTransaction("credit_sale"), true);
  assert.equal(isCustomerTransaction("repayment"), true);
});

check("ordinary types are not customer transactions", () => {
  for (const type of ["sale", "purchase", "expense", "payment_sent", "payment_received", "other"]) {
    assert.equal(isCustomerTransaction(type), false, `${type} should not link a customer`);
  }
});

console.log("\nA workspace only accepts the types that belong in it:");

check("a household cannot record udhaar", () => {
  // The whole point of the guard: a hallucinated credit_sale on a grocery
  // message must never reach confirmMessageTransaction, because that is what
  // opens a khata.
  for (const type of ["credit_sale", "repayment", "sale", "purchase", "payment_sent", "payment_received"]) {
    assert.equal(
      isTypeAllowedInWorkspace("household", type),
      false,
      `${type} should not be recordable at home`
    );
  }
});

check("a shop cannot record household income", () => {
  // Money into a shop is a sale or a payment_received, never a salary.
  assert.equal(isTypeAllowedInWorkspace("shopkeeper", "income"), false);
});

check("household accepts its own types", () => {
  for (const type of ["expense", "income", "other"]) {
    assert.equal(isTypeAllowedInWorkspace("household", type), true, type);
  }
});

check("shopkeeper still accepts every type it accepted before", () => {
  for (const type of TRANSACTION_TYPES) {
    if (type === "income") continue;

    assert.equal(
      isTypeAllowedInWorkspace("shopkeeper", type),
      true,
      `${type} regressed out of the shop ledger`
    );
  }
});

check("an unknown workspace type accepts nothing", () => {
  // Fail closed: a typo in a workspace type must not silently allow
  // everything through.
  assert.equal(isTypeAllowedInWorkspace("bogus", "expense"), false);
  assert.equal(isTypeAllowedInWorkspace(undefined, "expense"), false);
});

check("expense is the one type both ledgers share", () => {
  assert.equal(isTypeAllowedInWorkspace("shopkeeper", "expense"), true);
  assert.equal(isTypeAllowedInWorkspace("household", "expense"), true);
});

console.log("\nThe type lists still agree with each other:");

// These do not test behaviour. They test that the several lists in
// transaction.schema.js have not drifted apart — the failure mode you only
// notice weeks later, when a message fails with a generic apology.

check("every declared type belongs to at least one workspace", () => {
  // Add a type to TRANSACTION_TYPES and forget TYPES_BY_WORKSPACE, and you
  // get a type the AI may emit and Zod will happily accept, but that no
  // workspace can record. The user sees "I couldn't record that" with no clue.
  for (const type of TRANSACTION_TYPES) {
    const allowed = WORKSPACE_TYPES.some((workspace) =>
      isTypeAllowedInWorkspace(workspace, type)
    );

    assert.equal(
      allowed,
      true,
      `"${type}" is in TRANSACTION_TYPES but no workspace accepts it — add it to TYPES_BY_WORKSPACE`
    );
  }
});

check("no workspace allows a type the schema does not know", () => {
  // The mirror of the check above: a typo inside TYPES_BY_WORKSPACE would
  // permit a type that Zod then rejects further down the pipeline.
  for (const workspace of WORKSPACE_TYPES) {
    for (const type of TRANSACTION_TYPES.concat(["refund", "loan", ""])) {
      if (TRANSACTION_TYPES.includes(type)) continue;

      assert.equal(
        isTypeAllowedInWorkspace(workspace, type),
        false,
        `${workspace} accepts "${type}", which is not a declared transaction type`
      );
    }
  }
});

check("only a shop can record a type that touches a khata", () => {
  // The standing product rule — a household has no customers — asserted from
  // the data rather than trusted. If a customer type ever became legal at
  // home, confirmMessageTransaction would open a khata from a grocery bill.
  for (const type of CUSTOMER_TRANSACTION_TYPES) {
    assert.equal(isTypeAllowedInWorkspace("shopkeeper", type), true, type);

    for (const workspace of WORKSPACE_TYPES) {
      if (workspace === "shopkeeper") continue;

      assert.equal(
        isTypeAllowedInWorkspace(workspace, type),
        false,
        `${workspace} can record "${type}", which would open a khata`
      );
    }
  }
});

check("every workspace accepts at least one type", () => {
  // Catches a workspace added to the enum but never wired up: it would
  // reject every single message the user sends into it.
  for (const workspace of WORKSPACE_TYPES) {
    const usable = TRANSACTION_TYPES.filter((type) =>
      isTypeAllowedInWorkspace(workspace, type)
    );

    assert.ok(
      usable.length > 0,
      `workspace "${workspace}" accepts nothing — it is in WORKSPACE_TYPES but missing from TYPES_BY_WORKSPACE`
    );
  }
});

check("household categories are clean enough to put in a prompt", () => {
  // This list is interpolated straight into the household system prompt, so
  // a duplicate wastes tokens and a capitalised entry teaches the model to
  // emit a category that will not match the others when grouped.
  assert.ok(HOUSEHOLD_CATEGORIES.length > 0, "no categories to offer");

  assert.equal(
    new Set(HOUSEHOLD_CATEGORIES).size,
    HOUSEHOLD_CATEGORIES.length,
    "duplicate category"
  );

  for (const category of HOUSEHOLD_CATEGORIES) {
    assert.equal(category, category.toLowerCase(), `"${category}" is not lowercase`);
    assert.equal(category.trim(), category, `"${category}" has stray whitespace`);
    assert.ok(category.length > 0, "empty category");
  }
});

console.log(
  `\n${passed} checks passed${process.exitCode ? " — SOME FAILED" : ""}\n`
);
