// Checks that Groq actually classifies real shopkeeper sentences correctly.
//
//   node tests/ai.test.js
//
// Needs GROQ_API_KEY. Costs a few API calls. No database is touched.
// This is the test that catches prompt regressions — the schema test only
// proves that WELL-FORMED output is accepted, not that the AI produces it.

import "dotenv/config";

import { processMessage } from "../src/services/transaction.service.js";

// Each case: the message a shopkeeper types, and what we expect back.
// `person: undefined` means "we don't care", null means "must be null".
const CASES = [
  // Everyday shop bookkeeping
  { text: "Bought 10 kg rice for ₹600", intent: "transaction", type: "purchase", amount: 600, person: null },
  { text: "Sold 5 shirts for ₹2500", intent: "transaction", type: "sale", amount: 2500, person: null },
  { text: "Paid electricity bill ₹1800", intent: "transaction", type: "expense", amount: 1800, person: null },
  { text: "Paid ₹3000 to supplier", intent: "transaction", type: "payment_sent", amount: 3000 },
  { text: "Received ₹5000 from Raj", intent: "transaction", amount: 5000, person: "Raj" },

  // Udhaar given
  { text: "Raj took goods for ₹2000 on udhaar", intent: "transaction", type: "credit_sale", amount: 2000, person: "Raj" },
  { text: "Raj bought groceries for ₹1500 on credit", intent: "transaction", type: "credit_sale", amount: 1500, person: "Raj" },
  { text: "Sold goods to Amit for ₹2500 on credit", intent: "transaction", type: "credit_sale", amount: 2500, person: "Amit" },
  { text: "Raj owes me ₹5000", intent: "transaction", type: "credit_sale", amount: 5000, person: "Raj" },

  // Udhaar repaid
  { text: "Raj paid ₹1000", intent: "transaction", type: "repayment", amount: 1000, person: "Raj" },
  { text: "Raj paid remaining ₹1000", intent: "transaction", type: "repayment", amount: 1000, person: "Raj" },
  { text: "Raj cleared his ₹3000 udhaar", intent: "transaction", type: "repayment", amount: 3000, person: "Raj" },

  // Questions, not transactions
  { text: "How much does Raj owe me?", intent: "balance_query", person: "Raj" },
  { text: "Raj ka kitna baaki hai?", intent: "balance_query", person: "Raj" },
  { text: "Show Raj's transactions", intent: "history_query", person: "Raj" },
];

let passed = 0;
let failed = 0;

for (const [index, testCase] of CASES.entries()) {
  let result;

  try {
    result = await processMessage(testCase.text, 900000 + index);
  } catch (error) {
    failed++;
    console.log(`  FAIL  "${testCase.text}"\n        threw: ${error.message}`);
    continue;
  }

  const actual =
    result.intent === "transaction"
      ? {
          intent: result.intent,
          type: result.transaction.transaction_type,
          amount: result.transaction.amount,
          person: result.transaction.person,
        }
      : { intent: result.intent, person: result.person };

  const problems = [];

  if (testCase.intent !== undefined && actual.intent !== testCase.intent) {
    problems.push(`intent ${actual.intent} != ${testCase.intent}`);
  }
  if (testCase.type !== undefined && actual.type !== testCase.type) {
    problems.push(`type ${actual.type} != ${testCase.type}`);
  }
  if (testCase.amount !== undefined && actual.amount !== testCase.amount) {
    problems.push(`amount ${actual.amount} != ${testCase.amount}`);
  }
  if (testCase.person !== undefined && actual.person !== testCase.person) {
    problems.push(`person ${JSON.stringify(actual.person)} != ${JSON.stringify(testCase.person)}`);
  }

  if (problems.length === 0) {
    passed++;
    console.log(`  PASS  "${testCase.text}"\n        -> ${JSON.stringify(actual)}`);
  } else {
    failed++;
    console.log(`  FAIL  "${testCase.text}"\n        -> ${JSON.stringify(actual)}\n        ${problems.join("; ")}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
