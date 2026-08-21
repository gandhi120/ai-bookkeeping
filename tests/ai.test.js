// Checks that the AI actually classifies real sentences correctly.
//
//   node tests/ai.test.js
//
// Needs GROQ_API_KEY (and GEMINI_API_KEY if the fallback is configured).
// Costs one API call per case. No database is touched.
//
// This is the ONLY test that can catch the failure mode migration 006
// introduced. The model no longer picks a transaction type from a list — it
// answers the DIRECTION, `cash` and `udhaar`, and the totals are built from
// its answer. Zod and the CHECK constraint can refuse a value outside the
// enum; nothing but this file can catch a wrong CHOICE inside it. A "light
// bill" coming back as cash "in" is valid input that silently books ₹2,400 on
// the wrong side of the month.
//
// Left out of `npm run test:all` because it costs calls, not because it
// matters less. Run it before a release.

import "dotenv/config";

import { processMessage } from "../src/services/transaction.service.js";
import { CASH_VALUES, UDHAAR_VALUES } from "../src/schemas/transaction.schema.js";

// Each case: the message someone types, and what we expect back.
// `person: undefined` means "we don't care", null means "must be null".
// `ledger` is the NAME of the ledger the message arrived in — context for the
// model, not a rule. Defaults to a shop, so every pre-006 case still reads the
// same way it always did.
const CASES = [
  // ----------------------------------------------------------------
  // Everyday buying and selling. cash only; nobody's debt moves.
  // ----------------------------------------------------------------
  { text: "Bought 10 kg rice for ₹600", intent: "transaction", cash: "out", udhaar: "none", amount: 600, person: null },
  { text: "Sold 5 shirts for ₹2500", intent: "transaction", cash: "in", udhaar: "none", amount: 2500, person: null },
  { text: "Paid electricity bill ₹1800", intent: "transaction", cash: "out", udhaar: "none", amount: 1800, person: null },
  { text: "Paid ₹3000 to supplier", intent: "transaction", cash: "out", udhaar: "none", amount: 3000 },

  // ----------------------------------------------------------------
  // UDHAAR GIVEN. Goods left, no cash moved — the case that proves the two
  // axes are read independently. cash "in" here would inflate the month by
  // money that has not arrived.
  // ----------------------------------------------------------------
  { text: "Raj took goods for ₹2000 on udhaar", intent: "transaction", cash: "none", udhaar: "they_owe_more", amount: 2000, person: "Raj" },
  { text: "Raj bought groceries for ₹1500 on credit", intent: "transaction", udhaar: "they_owe_more", amount: 1500, person: "Raj" },
  { text: "Sold goods to Amit for ₹2500 on credit", intent: "transaction", udhaar: "they_owe_more", amount: 2500, person: "Amit" },
  { text: "Raj owes me ₹5000", intent: "transaction", udhaar: "they_owe_more", amount: 5000, person: "Raj" },

  // ----------------------------------------------------------------
  // UDHAAR PAID BACK. Cash in AND a debt down — both axes at once, which a
  // single type name had to encode in one word and every consumer had to
  // remember the second half of.
  // ----------------------------------------------------------------
  { text: "Raj paid ₹1000 towards his udhaar", intent: "transaction", cash: "in", udhaar: "they_owe_less", amount: 1000, person: "Raj" },
  { text: "Raj paid back ₹1000", intent: "transaction", cash: "in", udhaar: "they_owe_less", amount: 1000, person: "Raj" },
  { text: "Raj paid remaining ₹1000", intent: "transaction", udhaar: "they_owe_less", amount: 1000, person: "Raj" },
  { text: "Raj cleared his ₹3000 udhaar", intent: "transaction", udhaar: "they_owe_less", amount: 3000, person: "Raj" },
  { text: "Raj ne baaki ₹500 de diye", intent: "transaction", cash: "in", udhaar: "they_owe_less", amount: 500, person: "Raj" },

  // The ergative pair. "ne" marks the DOER, "ko" marks the receiver, and the
  // sender is always the user — so a NAMED person before "ne" means they gave.
  // Without that rule in the prompt the model reads "Raj ne 500 de diye" as
  // the USER paying Raj, which books the money out AND moves the wrong khata
  // in the wrong direction. These two only differ by the debt word.
  { text: "Raj ne 500 aapya", intent: "transaction", cash: "in", udhaar: "none", amount: 500, person: "Raj" },

  // ----------------------------------------------------------------
  // THE USER OWING SOMEBODY. The direction the old shop-only enum could not
  // record at all: it had credit_sale and repayment, both about money owed TO
  // the user, and nothing for money the user borrowed.
  // ----------------------------------------------------------------
  { text: "Borrowed ₹10000 from Mama", intent: "transaction", cash: "in", udhaar: "i_owe_more", amount: 10000, person: "Mama" },
  { text: "Mama se 10000 udhaar liye", intent: "transaction", cash: "in", udhaar: "i_owe_more", amount: 10000, person: "Mama" },
  { text: "Took a ₹50000 loan from Suresh", intent: "transaction", cash: "in", udhaar: "i_owe_more", amount: 50000, person: "Suresh" },
  { text: "Paid Mama back ₹4000", intent: "transaction", cash: "out", udhaar: "i_owe_less", amount: 4000, person: "Mama" },
  { text: "Mama ko 4000 wapas diye", intent: "transaction", cash: "out", udhaar: "i_owe_less", amount: 4000, person: "Mama" },

  // ----------------------------------------------------------------
  // AMBIGUOUS MONEY IN. The message never says what it was for, so udhaar
  // must come back "none" and the bot asks instead of guessing. These are the
  // cases that would otherwise silently move somebody's balance.
  // ----------------------------------------------------------------
  { text: "Received ₹5000 from Raj", intent: "transaction", cash: "in", udhaar: "none", amount: 5000, person: "Raj" },
  { text: "Raj gave me ₹5000", intent: "transaction", cash: "in", udhaar: "none", amount: 5000, person: "Raj" },
  { text: "Raj gave me ₹5000 for the order", intent: "transaction", cash: "in", udhaar: "none", amount: 5000, person: "Raj" },
  { text: "Raj paid ₹1000", intent: "transaction", cash: "in", udhaar: "none", amount: 1000, person: "Raj" },

  // A name is not a debt, and a gift is not a loan.
  { text: "Gave Ramesh ₹2000 for his trip", intent: "transaction", cash: "out", udhaar: "none", amount: 2000, person: "Ramesh" },

  // Nobody named: ordinary money in, nothing to ask.
  { text: "Received ₹5000 cash", intent: "transaction", cash: "in", udhaar: "none", amount: 5000, person: null },
  { text: "Received ₹5000 from a walk-in customer", intent: "transaction", cash: "in", udhaar: "none", amount: 5000, person: null },

  // ----------------------------------------------------------------
  // Questions, not transactions. Legal in EVERY ledger now — the khata
  // belongs to the user, not to one book.
  // ----------------------------------------------------------------
  { text: "How much does Raj owe me?", intent: "balance_query", person: "Raj" },
  { text: "Raj ka kitna baaki hai?", intent: "balance_query", person: "Raj" },
  { text: "Show Raj's transactions", intent: "history_query", person: "Raj" },
  { ledger: "Ghar", text: "How much does Raj owe me?", intent: "balance_query", person: "Raj" },

  // ----------------------------------------------------------------
  // Multi-language: the same meaning must produce the same record in English,
  // Gujarati script, Roman Gujarati and mixed. `person` is always compared in
  // English letters because customers are matched on lower(name) in SQL —
  // "રાજેશ" and "Rajesh" must not open two separate khatas.
  // ----------------------------------------------------------------
  { text: "Raj took goods for ₹2000 on credit", intent: "transaction", udhaar: "they_owe_more", amount: 2000, person: "Raj" },
  { text: "રાજેશે ₹2000 નો માલ ઉધાર લીધો", intent: "transaction", udhaar: "they_owe_more", amount: 2000, person: "Rajesh" },
  { text: "Rajesh e 2000 no maal udhar lidho", intent: "transaction", udhaar: "they_owe_more", amount: 2000, person: "Rajesh" },
  { text: "Rajesh e ₹2000 na kapda udhar lidha", intent: "transaction", udhaar: "they_owe_more", amount: 2000, person: "Rajesh" },
  { text: "રાજેશે ₹1000 પાછા આપ્યા", intent: "transaction", udhaar: "they_owe_less", amount: 1000, person: "Rajesh" },
  { text: "Rajesh e 1000 pacha aapya", intent: "transaction", udhaar: "they_owe_less", amount: 1000, person: "Rajesh" },
  { text: "રાજેશના કેટલા રૂપિયા બાકી છે?", intent: "balance_query", person: "Rajesh" },
  { text: "Rajesh na ketla rupiya baki che?", intent: "balance_query", person: "Rajesh" },
  { text: "આજે લાઇટનું બિલ ₹1800 ભર્યું", intent: "transaction", cash: "out", udhaar: "none", amount: 1800, person: null },
  { text: "Bought rice for ₹600", intent: "transaction", cash: "out", udhaar: "none", amount: 600, person: null },

  // ----------------------------------------------------------------
  // Household money, in a ledger the user named. Same pipeline, same prompt —
  // there is no household prompt any more. `category` matters here in a way
  // it does not for a shop: it is what the /monthly breakdown groups by.
  // ----------------------------------------------------------------
  { ledger: "Ghar", text: "Bought groceries for ₹500", intent: "transaction", cash: "out", udhaar: "none", amount: 500, category: "groceries" },
  { ledger: "Ghar", text: "Paid electricity bill ₹2400", intent: "transaction", cash: "out", udhaar: "none", amount: 2400, category: "electricity" },
  { ledger: "Ghar", text: "Salary received ₹65000", intent: "transaction", cash: "in", udhaar: "none", amount: 65000, category: "salary" },
  { ledger: "Ghar", text: "Paid house rent ₹12000", intent: "transaction", cash: "out", udhaar: "none", amount: 12000, category: "rent" },
  { ledger: "Ghar", text: "કિરાણા માટે ૫૦૦ રૂપિયા ખર્ચ્યા", intent: "transaction", cash: "out", amount: 500, category: "groceries" },
  { ledger: "Ghar", text: "Aaj grocery pe 500 kharch kiya", intent: "transaction", cash: "out", amount: 500, category: "groceries" },
  { ledger: "Ghar", text: "લાઇટનું બિલ ₹2400 ભર્યું", intent: "transaction", cash: "out", amount: 2400, category: "electricity" },

  // A ledger the user invented. The name is passed to the model as context,
  // which is the whole reason it is passed at all.
  { ledger: "Bike", text: "300 nu petrol puravyu", intent: "transaction", cash: "out", udhaar: "none", amount: 300 },
  { ledger: "Farm", text: "Bought khaad for ₹1200", intent: "transaction", cash: "out", udhaar: "none", amount: 1200 },

  // ----------------------------------------------------------------
  // SEVERAL ENTRIES IN ONE MESSAGE.
  //
  // The first of these is verbatim what Varun typed on his first real test.
  // The AI understood both halves and returned an array; everything below the
  // AI then threw it away. `entries` is the assertion that matters here — the
  // other checks only look at the first one.
  // ----------------------------------------------------------------
  { ledger: "Ghar", text: "400 nu dudh lavya, 300 no kpda dhova no sabu lavya", intent: "transaction", entries: 2, cash: "out", amount: 400 },
  { ledger: "Ghar", text: "500 નું કરિયાણું લીધું અને 200 નું શાક લીધું", intent: "transaction", entries: 2, cash: "out", amount: 500 },
  { ledger: "Ghar", text: "दूध 60, सब्ज़ी 140, बिजली का बिल 2400", intent: "transaction", entries: 3 },
  { text: "10 kg rice 600 lidha ane 5 shirt 2500 ma vechya", intent: "transaction", entries: 2 },

  // Mixed directions in one breath — the case the netted total on the multi
  // card exists for.
  { text: "Sold goods for 2000 and paid the supplier 800", intent: "transaction", entries: 2 },

  // One entry must still come back as one — asking for a list must not make
  // the model split a single sentence into pieces.
  { ledger: "Ghar", text: "Bought groceries for ₹500", intent: "transaction", entries: 1, cash: "out", amount: 500 },
];

// Pre-flight: check the CASES table against itself before spending a single
// API call on it. A case expecting cash "sideways" is a broken TEST, not a
// broken model — but at runtime it would look like a classification failure,
// after paying for the call to find out.
for (const [index, testCase] of CASES.entries()) {
  const bad =
    (testCase.cash !== undefined && !CASH_VALUES.includes(testCase.cash)) ||
    (testCase.udhaar !== undefined && !UDHAAR_VALUES.includes(testCase.udhaar));

  if (bad) {
    console.error(
      `\nBROKEN TEST CASE #${index}: "${testCase.text}"\n` +
        `  expects cash "${testCase.cash}" / udhaar "${testCase.udhaar}", ` +
        `which is not a declared value.\n`
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

  // Cases default to a shop ledger, so every pre-006 case still runs exactly
  // as it did — which is what makes them a regression guard.
  const ledger = testCase.ledger ?? "Kirana Store";

  try {
    result = await processMessage(testCase.text, 900000 + index, "en", ledger);
  } catch (error) {
    failed++;
    console.log(`  FAIL  [${ledger}] "${testCase.text}"\n        threw: ${error.message}`);
    continue;
  }

  // One message can now record several entries. Every case below states one
  // expectation, so the first entry is the one compared — a case that means
  // to check multiple entries should assert on `result.transactions.length`
  // via the `entries` field instead.
  const actual =
    result.intent === "transaction"
      ? {
          intent: result.intent,
          cash: result.transactions[0].cash,
          udhaar: result.transactions[0].udhaar,
          amount: result.transactions[0].amount,
          person: result.transactions[0].person,
          category: result.transactions[0].category,
          entries: result.transactions.length,
        }
      : { intent: result.intent, person: result.person };

  const problems = [];

  if (testCase.category !== undefined && actual.category !== testCase.category) {
    problems.push(`category ${actual.category} != ${testCase.category}`);
  }

  if (testCase.intent !== undefined && actual.intent !== testCase.intent) {
    problems.push(`intent ${actual.intent} != ${testCase.intent}`);
  }
  // The two that decide which way the money moves. Everything else on a card
  // is cosmetic; these two are the totals.
  if (testCase.cash !== undefined && actual.cash !== testCase.cash) {
    problems.push(`cash ${actual.cash} != ${testCase.cash}`);
  }
  if (testCase.udhaar !== undefined && actual.udhaar !== testCase.udhaar) {
    problems.push(`udhaar ${actual.udhaar} != ${testCase.udhaar}`);
  }
  if (testCase.amount !== undefined && actual.amount !== testCase.amount) {
    problems.push(`amount ${actual.amount} != ${testCase.amount}`);
  }
  if (testCase.person !== undefined && actual.person !== testCase.person) {
    problems.push(`person ${JSON.stringify(actual.person)} != ${JSON.stringify(testCase.person)}`);
  }
  if (testCase.entries !== undefined && actual.entries !== testCase.entries) {
    problems.push(`entries ${actual.entries} != ${testCase.entries}`);
  }

  if (problems.length === 0) {
    passed++;
    console.log(`  PASS  [${ledger}] "${testCase.text}"\n        -> ${JSON.stringify(actual)}`);
  } else {
    failed++;
    console.log(`  FAIL  [${ledger}] "${testCase.text}"\n        -> ${JSON.stringify(actual)}\n        ${problems.join("; ")}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
