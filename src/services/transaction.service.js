import { askAI } from "../ai/groq.service.js";
import { MessageSchema } from "../schemas/transaction.schema.js";

// Turns one raw Telegram message into a validated, structured result.
//
// This function deliberately does NOT touch PostgreSQL. It only understands
// the message; saving happens later, and only after the shopkeeper taps
// Confirm. Keeping the AI logic and the SQL in separate files means either
// one can change without breaking the other.
//
// Returns one of:
//   { intent: "transaction", transaction: {...} }   -> needs confirmation
//   { intent: "balance_query", person: "Raj" }      -> answer immediately
//   { intent: "history_query", person: "Raj" }      -> answer immediately
export async function processMessage(messageText, telegramMessageId) {
  // 1. Ask the AI to understand the shopkeeper's message. Groq answers
  //    normally; Gemini takes over automatically if Groq is unavailable.
  const aiResponse = await askAI(messageText);

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
    return {
      intent: validated.intent,
      person: validated.person,
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
