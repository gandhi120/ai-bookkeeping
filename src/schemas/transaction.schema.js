import { z } from "zod";

// The AI does not pick a transaction TYPE any more. It answers two questions
// about direction, and this file is what refuses anything else.
//
// A fixed type enum only works if the code knows what each member MEANS --
// that `credit_sale` is goods-out-no-cash, that `repayment` is cash-but-not-
// revenue. That knowledge was a lookup table spread across summary.service.js,
// customers.js, khata.js and cards.js, and a lookup table is the opposite of a
// ledger the user invented and named themselves.

// AXIS 1: did rupees actually move, and which way?
export const CASH_VALUES = ["in", "out", "none"];

// AXIS 2: did anyone's debt change, and in whose favour?
//
// Positive-for-the-user first: `they_owe_more` is goods handed over on udhaar,
// `i_owe_more` is money the user borrowed. Both directions exist because an
// Indian household lends about as often as it borrows -- the old shop-only
// enum could record money owed TO the user and never money the user owes.
export const UDHAAR_VALUES = [
  "they_owe_more",
  "they_owe_less",
  "i_owe_more",
  "i_owe_less",
  "none",
];

// The two axes are INDEPENDENT, which is exactly why one flat enum kept
// needing new members: a credit sale moves debt and no cash, a repayment moves
// both, a gift to a nephew moves cash and no debt. A single list has to invent
// a name for every combination; two fields do not.

// Category hints for the prompt. A plain list, not a table: adding one is a
// one-line edit and nothing references them by id. They are only a nudge
// toward consistent spelling so /monthly can group -- the AI may return
// anything, and enumLabel() falls back to the raw value when it does.
export const COMMON_CATEGORIES = [
  "groceries",
  "food",
  "electricity",
  "water",
  "gas",
  "rent",
  "transport",
  "education",
  "medical",
  "shopping",
  "entertainment",
  "subscriptions",
  "salary",
  "stock",
  "other",
];

// Returns true when this entry should be linked to a customer khata.
//
// Was a second list (CUSTOMER_TRANSACTION_TYPES) that had to be kept in step
// with the first one. A khata entry is now simply an entry that says
// somebody's debt changed -- there is nothing left to keep in step.
//
// Takes the ENTRY, not a type string: the old signature was
// isCustomerTransaction(transactionType).
export function isCustomerTransaction(entry) {
  return entry?.udhaar !== undefined && entry.udhaar !== "none";
}

// How much this entry moves the khata, signed the same way the database signs
// it: POSITIVE means they owe the user more, NEGATIVE means the user owes more.
//
// This duplicates `transactions.owed_delta`, which is a GENERATED column and
// the authority for every row that EXISTS. It is here for the one case the
// column cannot cover: the confirmation card previews "₹5,000 → ₹5,500" for a
// row that has not been inserted yet, because the user has not tapped Confirm.
//
// Keep the two in step. They are the only two copies — before migration 006
// this rule was written out five times across customers.js, khata.js and
// cards.js.
export function owedDelta(entry) {
  const amount = Number(entry?.amount ?? 0);

  switch (entry?.udhaar) {
    case "they_owe_more":
      return amount;
    case "they_owe_less":
      return -amount;
    case "i_owe_more":
      return -amount;
    case "i_owe_less":
      return amount;
    default:
      return 0;
  }
}

// SHAPE 1: the user is RECORDING money movement.
// Example: "Raj took goods for 2000 on udhaar"
// This is the only intent that goes through the confirm/cancel flow.
// Every field is required on purpose: if `amount` were optional, a
// transaction with no amount would pass validation and quietly break
// the /summary totals.
const TransactionIntentSchema = z.object({
  // z.literal = must be exactly this string, nothing else.
  intent: z.literal("transaction"),

  // Free text now, and written in the user's own language. It is a LABEL on
  // the card -- nothing branches on it. enumLabel() falls back to the raw
  // value, so "ઉધાર" renders as "ઉધાર" and pre-006 rows carrying "expense"
  // still render through the type.* catalog.
  transaction_type: z.string(),

  // z.enum = must be one of the listed values. These two are the only enums
  // left, and they are the ones that matter: they are arithmetic, not labels.
  // A hallucinated "sideways" is rejected here instead of reaching a total.
  cash: z.enum(CASH_VALUES),
  udhaar: z.enum(UDHAAR_VALUES),

  description: z.string(),
  category: z.string(),
  quantity: z.number().int(),

  // Positive, always. The direction is carried by `cash` and `udhaar`, never
  // by a minus sign -- otherwise a model that sent -500 for an expense would
  // subtract it from the outgoings it belongs in.
  amount: z.number().positive(),

  person: z.string().nullable(),
  transaction_date: z.string(),
  notes: z.string().nullable(),
});

// SHAPE 2: the user is ASKING a question about someone's khata.
// Example: "How much does Raj owe me?"  /  "Show Raj's transactions"
// A question has no amount and no date, so it needs nothing except who
// is being asked about. It is answered immediately and never enters the
// confirmation flow.
const QueryIntentSchema = z.object({
  intent: z.enum(["balance_query", "history_query"]),
  // .min(1) because "" is a valid string in JS — without this we could
  // end up looking up a customer with an empty name.
  person: z.string().min(1),
});

// The AI's output is untrusted input, so we validate it before use.
//
// A "discriminated union" means: the value can be one of several shapes,
// and ONE field tells you which. That field here is `intent` — the same
// idea as `switch (action.type)` in Redux.
//
// Zod reads `intent` first, picks the matching schema above, then checks
// only that one. So a question is never required to have an amount, and
// a transaction is never allowed to be missing one.
export const MessageSchema = z.discriminatedUnion("intent", [
  TransactionIntentSchema,
  QueryIntentSchema,
]);
