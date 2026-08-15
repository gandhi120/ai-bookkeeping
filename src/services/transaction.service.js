import { askGroq } from "../ai/groq.service.js";
import { TransactionSchema } from "../schemas/transaction.schema.js";

// Converts a Telegram message into a validated transaction.
// Does NOT save to PostgreSQL yet.
export async function processTransaction(messageText, telegramMessageId) {
  // 1. Ask Groq to understand the user's message.
  const aiResponse = await askGroq(messageText);

  // 2. Convert Groq's JSON string into a JavaScript object.
  const transaction = JSON.parse(aiResponse);

  // 3. Validate the AI-generated object with Zod.
  const validatedTransaction = TransactionSchema.parse(transaction);

  // 4. Add Telegram's message ID.
  const transactionWithTelegramId = {
    ...validatedTransaction,
    telegram_message_id: telegramMessageId,
  };

  // Return the validated transaction.
  // PostgreSQL will be called only after user confirmation.
  return {
    transaction: transactionWithTelegramId,
  };
}