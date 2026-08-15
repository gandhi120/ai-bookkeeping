import { z } from "zod";

// Every transaction type the AI is allowed to produce.
// credit_sale / repayment are the udhaar (credit) pair:
//   credit_sale -> customer took goods, so they owe the shopkeeper MORE
//   repayment   -> customer paid money back, so they owe LESS
export const TRANSACTION_TYPES = [
  "sale",
  "purchase",
  "expense",
  "payment_received",
  "payment_sent",
  "credit_sale",
  "repayment",
  "income",
  "other",
];

// The two kinds of ledger a user can keep. `type` on the workspaces table.
export const WORKSPACE_TYPES = ["shopkeeper", "household"];

// Which types are legal in which ledger.
//
// `expense` and `other` are in both: an electricity bill is an expense
// whether the meter is at the shop or at home. Everything else is exclusive —
// a household has no customers, so it can never produce credit_sale or
// repayment, and a shop's income is a sale, not a salary.
const TYPES_BY_WORKSPACE = {
  shopkeeper: [
    "sale",
    "purchase",
    "expense",
    "payment_received",
    "payment_sent",
    "credit_sale",
    "repayment",
    "other",
  ],
  household: ["expense", "income", "other"],
};

// What each ledger can DO, as opposed to TYPES_BY_WORKSPACE above, which is
// what it can RECORD.
//
// Both ledgers read their money back the same three ways. Only the khata is
// exclusive to a shop, because only a shop has customers — a household has
// nobody to lend to.
//
// This is the single place that answers "does this ledger have all its
// features?". The onboarding tour builds its buttons from it, so a feature
// added here appears in the tour for exactly the ledgers listed.
const FEATURES_BY_WORKSPACE = {
  shopkeeper: ["summary", "monthly", "transactions", "udhaar"],
  household: ["summary", "monthly", "transactions"],
};

// Returns the features a workspace type offers, in the order they should be
// shown.
//
// `?? []` so an unknown type offers nothing rather than everything — the same
// fail-closed default as isTypeAllowedInWorkspace().
export function featuresForWorkspace(workspaceType) {
  return FEATURES_BY_WORKSPACE[workspaceType] ?? [];
}

// Categories offered to the household prompt. A plain list, not a table:
// adding one is a one-line edit and nothing references them by id.
export const HOUSEHOLD_CATEGORIES = [
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
  "other",
];

// Decides whether a transaction type may be recorded in this workspace.
//
// The prompt TELLS the AI which types exist; this is what actually enforces
// it. Keeping the rule here rather than trusting the prompt is the reason a
// hallucinated `credit_sale` on a household grocery message cannot open a
// khata — the AI is instructed, never trusted.
export function isTypeAllowedInWorkspace(workspaceType, transactionType) {
  return (TYPES_BY_WORKSPACE[workspaceType] ?? []).includes(transactionType);
}

// Only these two types belong to a customer khata and move an outstanding
// balance. Everything else (a supplier payment, an electricity bill) has
// no customer attached.
export const CUSTOMER_TRANSACTION_TYPES = ["credit_sale", "repayment"];

// Returns true when this transaction type should be linked to a customer.
// Used at confirmation time to decide whether to resolve a customer record.
export function isCustomerTransaction(transactionType) {
  return CUSTOMER_TRANSACTION_TYPES.includes(transactionType);
}

// SHAPE 1: the shopkeeper is RECORDING money movement.
// Example: "Raj took goods for 2000 on udhaar"
// This is the only intent that goes through the confirm/cancel flow.
// Every field is required on purpose: if `amount` were optional, a
// transaction with no amount would pass validation and quietly break
// the /summary totals.
const TransactionIntentSchema = z.object({
  // z.literal = must be exactly this string, nothing else.
  intent: z.literal("transaction"),
  // z.enum = must be one of the listed values. A hallucinated type
  // like "refund" is rejected here instead of reaching the database.
  transaction_type: z.enum(TRANSACTION_TYPES),
  description: z.string(),
  category: z.string(),
  quantity: z.number().int(),
  amount: z.number(),
  person: z.string().nullable(),
  transaction_date: z.string(),
  notes: z.string().nullable(),
});

// SHAPE 2: the shopkeeper is ASKING a question about a customer.
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
