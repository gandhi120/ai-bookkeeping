import { askAI } from "../ai/groq.service.js";
import {
  MessageSchema,
  isTypeAllowedInWorkspace,
} from "../schemas/transaction.schema.js";

// Turns one raw Telegram message into a validated, structured result.
//
// This function deliberately does NOT touch PostgreSQL. It only understands
// the message; saving happens later, and only after the shopkeeper taps
// Confirm. Keeping the AI logic and the SQL in separate files means either
// one can change without breaking the other.
//
// `workspaceType` tells the AI which ledger it is reading for, and decides
// which transaction types are legal. It defaults to "shopkeeper" so an
// un-updated caller behaves exactly as before workspaces existed.
//
// Returns one of:
//   { intent: "transaction", transaction: {...} }   -> needs confirmation
//   { intent: "balance_query", person: "Raj" }      -> answer immediately
//   { intent: "history_query", person: "Raj" }      -> answer immediately
//   { intent: "unsupported", reason: "..." }        -> tell the user politely
export async function processMessage(
  messageText,
  telegramMessageId,
  workspaceType = "shopkeeper"
) {
  // 1. Ask the AI to understand the shopkeeper's message. Groq answers
  //    normally; Gemini takes over automatically if Groq is unavailable.
  const aiResponse = await askAI(messageText, workspaceType);

  // 2. Convert Groq's JSON text into a JavaScript object.
  //    If Groq returned something that is not JSON this throws, and the
  //    caller marks the message FAILED.
  const parsed = JSON.parse(aiResponse);

  // 3. Validate against the schema. `intent` decides which shape is
  //    required, so a question is not forced to have an amount and a
  //    transaction is not allowed to be missing one.
  const validated = MessageSchema.parse(parsed);

  // 4. Questions are read-only. Return them as-is so the bot can answer
  //    straight away without creating anything.
  if (validated.intent !== "transaction") {
    // Only a shop has customers, so only a shop can be asked about a khata.
    // The household prompt is told never to produce these, but the prompt is
    // an instruction and this is the rule.
    if (workspaceType !== "shopkeeper") {
      return {
        intent: "unsupported",
        reason: "CUSTOMER_QUERY_OUTSIDE_SHOP",
      };
    }

    return {
      intent: validated.intent,
      person: validated.person,
    };
  }

  // 4b. The workspace, not the AI, decides which types may be recorded. This
  //     is what stops a hallucinated credit_sale on a household grocery
  //     message from opening a khata.
  if (!isTypeAllowedInWorkspace(workspaceType, validated.transaction_type)) {
    return {
      intent: "unsupported",
      reason: "TYPE_NOT_IN_WORKSPACE",
      transactionType: validated.transaction_type,
    };
  }

  // 5. For a real transaction, strip the `intent` field (it was only a
  //    routing hint, not part of the bookkeeping record) and attach
  //    Telegram's message id so the row can be traced back to the message.
  const { intent, ...transactionFields } = validated;

  return {
    intent: "transaction",
    transaction: {
      ...transactionFields,
      telegram_message_id: telegramMessageId,
    },
  };
}
