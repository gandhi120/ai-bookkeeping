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
  "other",
];

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
