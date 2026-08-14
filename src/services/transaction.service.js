import { askGroq } from "../ai/groq.service.js";
import { TransactionSchema } from "../schemas/transaction.schema.js";
import { createTransaction } from "../database/postgres.js";

// Converts a Telegram message into a validated transaction
// and saves it to PostgreSQL.
export async function processTransaction(messageText, telegramMessageId) {
  // 1. Ask Groq to understand the user's message.
  const aiResponse = await askGroq(messageText);

  // 2. Convert Groq's JSON string into a JavaScript object.
  const transaction = JSON.parse(aiResponse);

  // 3. Validate the AI-generated object with Zod.
  const validatedTransaction = TransactionSchema.parse(transaction);

  // 4. Add Telegram's message ID so we can identify the source message.
  const transactionWithTelegramId = {
    ...validatedTransaction,
    telegram_message_id: telegramMessageId,
  };

  // 5. Save the validated transaction to PostgreSQL.
  const savedTransaction = await createTransaction(
    transactionWithTelegramId
  );

  return savedTransaction;
}