// Checks that Groq actually classifies real shopkeeper sentences correctly.
//
//   node tests/ai.test.js
//
// Needs GROQ_API_KEY. Costs a few API calls. No database is touched.
// This is the test that catches prompt regressions — the schema test only
// proves that WELL-FORMED output is accepted, not that the AI produces it.

import "dotenv/config";

import { processMessage } from "../src/services/transaction.service.js";
import { isTypeAllowedInWorkspace } from "../src/schemas/transaction.schema.js";

// Each case: the message a shopkeeper types, and what we expect back.
// `person: undefined` means "we don't care", null means "must be null".
const CASES = [
  // Everyday shop bookkeeping
  { text: "Bought 10 kg rice for ₹600", intent: "transaction", type: "purchase", amount: 600, person: null },
  { text: "Sold 5 shirts for ₹2500", intent: "transaction", type: "sale", amount: 2500, person: null },
  { text: "Paid electricity bill ₹1800", intent: "transaction", type: "expense", amount: 1800, person: null },
  { text: "Paid ₹3000 to supplier", intent: "transaction", type: "payment_sent", amount: 3000 },

  // Udhaar given
  { text: "Raj took goods for ₹2000 on udhaar", intent: "transaction", type: "credit_sale", amount: 2000, person: "Raj" },
  { text: "Raj bought groceries for ₹1500 on credit", intent: "transaction", type: "credit_sale", amount: 1500, person: "Raj" },
  { text: "Sold goods to Amit for ₹2500 on credit", intent: "transaction", type: "credit_sale", amount: 2500, person: "Amit" },
  { text: "Raj owes me ₹5000", intent: "transaction", type: "credit_sale", amount: 5000, person: "Raj" },

  // Udhaar repaid — only when the message SAYS it settles a debt.
  { text: "Raj paid ₹1000 towards his udhaar", intent: "transaction", type: "repayment", amount: 1000, person: "Raj" },
  { text: "Raj paid back ₹1000", intent: "transaction", type: "repayment", amount: 1000, person: "Raj" },
  { text: "Raj paid remaining ₹1000", intent: "transaction", type: "repayment", amount: 1000, person: "Raj" },
  { text: "Raj cleared his ₹3000 udhaar", intent: "transaction", type: "repayment", amount: 3000, person: "Raj" },
  { text: "Raj ne baaki ₹500 de diye", intent: "transaction", type: "repayment", amount: 500, person: "Raj" },

  // Ambiguous money in — the message never says what it was for, so it must
  // NOT come back as a repayment. The bot asks the shopkeeper instead.
  // These are the cases that used to silently reduce a customer's balance.
  { text: "Received ₹5000 from Raj", intent: "transaction", type: "payment_received", amount: 5000, person: "Raj" },
  { text: "Raj gave me ₹5000", intent: "transaction", type: "payment_received", amount: 5000, person: "Raj" },
  { text: "Raj gave me ₹5000 for the order", intent: "transaction", type: "payment_received", amount: 5000, person: "Raj" },
  { text: "Raj paid ₹1000", intent: "transaction", type: "payment_received", amount: 1000, person: "Raj" },

  // Nobody named: ordinary income, no customer involved, nothing to ask.
  { text: "Received ₹5000 cash", intent: "transaction", type: "payment_received", amount: 5000, person: null },
  { text: "Received ₹5000 from a walk-in customer", intent: "transaction", type: "payment_received", amount: 5000, person: null },

  // Questions, not transactions
  { text: "How much does Raj owe me?", intent: "balance_query", person: "Raj" },
  { text: "Raj ka kitna baaki hai?", intent: "balance_query", person: "Raj" },
  { text: "Show Raj's transactions", intent: "history_query", person: "Raj" },

  // Multi-language: the same meaning must produce the same record in English,
  // Gujarati script, Roman Gujarati and mixed. `person` is always compared in
  // English letters because customers are matched on lower(name) in SQL —
  // "રાજેશ" and "Rajesh" must not open two separate khatas.
  { text: "Raj took goods for ₹2000 on credit", intent: "transaction", type: "credit_sale", amount: 2000, person: "Raj" },
  { text: "રાજેશે ₹2000 નો માલ ઉધાર લીધો", intent: "transaction", type: "credit_sale", amount: 2000, person: "Rajesh" },
  { text: "Rajesh e 2000 no maal udhar lidho", intent: "transaction", type: "credit_sale", amount: 2000, person: "Rajesh" },
  { text: "Rajesh e ₹2000 na kapda udhar lidha", intent: "transaction", type: "credit_sale", amount: 2000, person: "Rajesh" },
  { text: "રાજેશે ₹1000 પાછા આપ્યા", intent: "transaction", type: "repayment", amount: 1000, person: "Rajesh" },
  { text: "Rajesh e 1000 pacha aapya", intent: "transaction", type: "repayment", amount: 1000, person: "Rajesh" },
  { text: "રાજેશના કેટલા રૂપિયા બાકી છે?", intent: "balance_query", person: "Rajesh" },
  { text: "Rajesh na ketla rupiya baki che?", intent: "balance_query", person: "Rajesh" },
  { text: "આજે લાઇટનું બિલ ₹1800 ભર્યું", intent: "transaction", type: "expense", amount: 1800, person: null },
  { text: "Bought rice for ₹600", intent: "transaction", type: "purchase", amount: 600, person: null },

  // ----------------------------------------------------------------
  // Household workspace. Same pipeline, same one AI call — the only
  // difference is which system prompt the workspace type selects.
  // `category` matters here in a way it never did for the shop: it is what
  // the household dashboard groups by.
  // ----------------------------------------------------------------
  { workspace: "household", text: "Bought groceries for ₹500", intent: "transaction", type: "expense", amount: 500, category: "groceries" },
  { workspace: "household", text: "Paid electricity bill ₹2400", intent: "transaction", type: "expense", amount: 2400, category: "electricity" },
  { workspace: "household", text: "Salary received ₹65000", intent: "transaction", type: "income", amount: 65000, category: "salary" },
  { workspace: "household", text: "Paid house rent ₹12000", intent: "transaction", type: "expense", amount: 12000, category: "rent" },

  // Same three languages as the shop cases above, same expected record.
  { workspace: "household", text: "કિરાણા માટે ૫૦૦ રૂપિયા ખર્ચ્યા", intent: "transaction", type: "expense", amount: 500, category: "groceries" },
  { workspace: "household", text: "Aaj grocery pe 500 kharch kiya", intent: "transaction", type: "expense", amount: 500, category: "groceries" },
  { workspace: "household", text: "લાઇટનું બિલ ₹2400 ભર્યું", intent: "transaction", type: "expense", amount: 2400, category: "electricity" },

  // A household has no customers, so a khata question has no meaning here.
  // The guard in transaction.service.js turns it into `unsupported` rather
  // than letting it through as a query.
  { workspace: "household", text: "How much does Raj owe me?", intent: "unsupported" },
];

// Pre-flight: check the CASES table against itself before spending a single
// API call on it. A case expecting `income` under `shopkeeper` is a broken
// TEST, not a broken model — but at runtime it would look like a
// classification failure, after paying for the call to find out.
for (const [index, testCase] of CASES.entries()) {
  const workspace = testCase.workspace ?? "shopkeeper";

  if (testCase.type && !isTypeAllowedInWorkspace(workspace, testCase.type)) {
    console.error(
      `\nBROKEN TEST CASE #${index}: "${testCase.text}"\n` +
        `  expects type "${testCase.type}", which is not legal in a ${workspace} workspace.\n`
    );

    process.exit(1);
  }
}

let passed = 0;
let failed = 0;

// Gemini's free tier allows 15 requests per MINUTE per model, so firing the
// whole suite at once gets most of it rejected with a 429 that looks like a
// classification failure. 5s spacing = 12/min, comfortably under; 4.5s was
// close enough to the ceiling to still lose a case now and then.
// Override with TEST_DELAY_MS=0 when running against a paid tier.
const DELAY_MS = Number(process.env.TEST_DELAY_MS ?? 5000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const [index, testCase] of CASES.entries()) {
  let result;

  if (index > 0 && DELAY_MS > 0) {
    await sleep(DELAY_MS);
  }

  // Cases default to the shop, so every pre-workspace case still runs exactly
  // as it did — which is what makes them a regression guard.
  const workspace = testCase.workspace ?? "shopkeeper";

  try {
    result = await processMessage(testCase.text, 900000 + index, workspace);
  } catch (error) {
    failed++;
    console.log(`  FAIL  [${workspace}] "${testCase.text}"\n        threw: ${error.message}`);
    continue;
  }

  const actual =
    result.intent === "transaction"
      ? {
          intent: result.intent,
          type: result.transaction.transaction_type,
          amount: result.transaction.amount,
          person: result.transaction.person,
          category: result.transaction.category,
        }
      : { intent: result.intent, person: result.person };

  const problems = [];

  if (testCase.category !== undefined && actual.category !== testCase.category) {
    problems.push(`category ${actual.category} != ${testCase.category}`);
  }

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
    console.log(`  PASS  [${workspace}] "${testCase.text}"\n        -> ${JSON.stringify(actual)}`);
  } else {
    failed++;
    console.log(`  FAIL  [${workspace}] "${testCase.text}"\n        -> ${JSON.stringify(actual)}\n        ${problems.join("; ")}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
