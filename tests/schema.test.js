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
  owedDelta,
  CASH_VALUES,
  UDHAAR_VALUES,
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
    cash: "out",
    udhaar: "none",
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

check("udhaar given keeps the customer name", () => {
  const result = MessageSchema.parse(
    transaction({
      cash: "none",
      udhaar: "they_owe_more",
      person: "Raj",
      amount: 2000,
    })
  );
  assert.equal(result.person, "Raj");
  assert.equal(result.cash, "none");
});

check("a repayment answers BOTH axes", () => {
  // The case a single-field model cannot express: money arrived AND a debt
  // went down. Under the old enum this was one name, "repayment", and every
  // consumer had to remember it meant two things.
  const result = MessageSchema.parse(
    transaction({
      cash: "in",
      udhaar: "they_owe_less",
      person: "Raj",
      amount: 1000,
    })
  );
  assert.equal(result.cash, "in");
  assert.equal(result.udhaar, "they_owe_less");
});

check("the user borrowing is the direction the old enum could not record", () => {
  const result = MessageSchema.parse(
    transaction({ cash: "in", udhaar: "i_owe_more", person: "Mama", amount: 10000 })
  );
  assert.equal(result.udhaar, "i_owe_more");
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

console.log("\nBad input is rejected before it reaches the database:");

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

check("an entry that moves a debt is a customer transaction", () => {
  for (const udhaar of UDHAAR_VALUES) {
    if (udhaar === "none") continue;

    assert.equal(
      isCustomerTransaction({ udhaar }),
      true,
      `${udhaar} should link a customer`
    );
  }
});

check("an entry that moves no debt is not", () => {
  assert.equal(isCustomerTransaction({ udhaar: "none" }), false);
});

check("a missing udhaar field is not a customer transaction", () => {
  // Fail closed. A pre-006 row read back from JSONB has no udhaar at all, and
  // must not be treated as opening a khata just because the field is absent.
  assert.equal(isCustomerTransaction({}), false);
  assert.equal(isCustomerTransaction(undefined), false);
  assert.equal(isCustomerTransaction(null), false);
});

console.log("\nThe AI cannot corrupt a total:");

// This is what replaced isTypeAllowedInWorkspace. The old guard stopped a
// hallucinated type reaching a ledger that could not record it. Now the model
// answers the DIRECTION itself, so the three ways it could put money in the
// wrong place are: an out-of-enum cash, an out-of-enum udhaar, and a negative
// amount. All three are refused here, before anything reaches a total.

check("a cash value outside the enum is rejected", () => {
  for (const bogus of ["sideways", "IN", "", null, 1]) {
    assert.equal(
      MessageSchema.safeParse(transaction({ cash: bogus })).success,
      false,
      `cash "${bogus}" was accepted`
    );
  }
});

check("an udhaar value outside the enum is rejected", () => {
  for (const bogus of ["they_owe", "credit_sale", "", null]) {
    assert.equal(
      MessageSchema.safeParse(transaction({ udhaar: bogus })).success,
      false,
      `udhaar "${bogus}" was accepted`
    );
  }
});

check("every declared cash and udhaar value is accepted", () => {
  for (const cash of CASH_VALUES) {
    assert.equal(
      MessageSchema.safeParse(transaction({ cash })).success,
      true,
      `${cash} was declared but rejected`
    );
  }

  for (const udhaar of UDHAAR_VALUES) {
    assert.equal(
      MessageSchema.safeParse(transaction({ udhaar })).success,
      true,
      `${udhaar} was declared but rejected`
    );
  }
});

check("cash and udhaar are both required", () => {
  const { cash, ...noCash } = transaction();
  const { udhaar, ...noUdhaar } = transaction();

  assert.equal(MessageSchema.safeParse(noCash).success, false);
  assert.equal(MessageSchema.safeParse(noUdhaar).success, false);
});

check("a negative amount is rejected", () => {
  // The direction is carried by cash and udhaar. If a minus sign could also
  // carry it, an expense sent as -500 would SUBTRACT from the outgoings it
  // belongs in — the total would be wrong by twice the amount and nothing
  // would look broken.
  assert.equal(MessageSchema.safeParse(transaction({ amount: -500 })).success, false);
});

check("a zero amount is rejected", () => {
  assert.equal(MessageSchema.safeParse(transaction({ amount: 0 })).success, false);
});

check("transaction_type is free text now", () => {
  // It is a LABEL. The AI writes it in the user's language, so anything that
  // is a string has to pass — the enum moved to cash and udhaar.
  for (const label of ["ખર્ચ", "उधार", "petrol", "whatever"]) {
    assert.equal(
      MessageSchema.safeParse(transaction({ transaction_type: label })).success,
      true,
      `"${label}" was rejected`
    );
  }
});

console.log("\nThe khata sign mirrors the database:");

// owedDelta() is the JS twin of the owed_delta GENERATED column. The column is
// the authority for rows that exist; this is used to preview a row that has
// not been inserted yet. They must agree, so the signs are asserted here and
// against real Postgres in tests/workspace.integration.js.

check("they_owe_more and i_owe_less are positive", () => {
  assert.equal(owedDelta({ udhaar: "they_owe_more", amount: 500 }), 500);
  assert.equal(owedDelta({ udhaar: "i_owe_less", amount: 400 }), 400);
});

check("they_owe_less and i_owe_more are negative", () => {
  assert.equal(owedDelta({ udhaar: "they_owe_less", amount: 500 }), -500);
  assert.equal(owedDelta({ udhaar: "i_owe_more", amount: 1000 }), -1000);
});

check("no udhaar means no movement", () => {
  assert.equal(owedDelta({ udhaar: "none", amount: 500 }), 0);
  assert.equal(owedDelta({}), 0);
  assert.equal(owedDelta(undefined), 0);
});

check("every udhaar value has a sign decided for it", () => {
  // Add a fifth direction and forget owedDelta, and it silently moves nobody's
  // balance — the row saves, the khata just never changes.
  for (const udhaar of UDHAAR_VALUES) {
    const delta = owedDelta({ udhaar, amount: 100 });

    assert.equal(
      udhaar === "none" ? delta === 0 : Math.abs(delta) === 100,
      true,
      `"${udhaar}" has no sign in owedDelta()`
    );
  }
});

check("postgres numeric strings are handled", () => {
  // amount arrives as a string from node-postgres.
  assert.equal(owedDelta({ udhaar: "they_owe_more", amount: "500" }), 500);
});

console.log(`\n${passed} checks passed`);
