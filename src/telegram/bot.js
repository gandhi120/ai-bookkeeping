import TelegramBot from "node-telegram-bot-api";
import "dotenv/config";
import { askGroq } from "../ai/groq.service.js";
import { TransactionSchema } from "../schemas/transaction.schema.js";
import { createTransaction } from "../database/postgres.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

// Creates a Telegram bot instance.
// polling: true means our Node.js app continuously checks Telegram
// for new messages.
const bot = new TelegramBot(token, {
  polling: true,
});

console.log("Telegram bot is running...");

// This function runs whenever someone sends a message to our bot.
bot.on("message", async (message) => {
  console.log("Message received:", message.text);

  const aiResponse = await askGroq(message.text);
  const transaction = JSON.parse(aiResponse);

  console.log("Parsed transaction:", transaction);

  const validatedTransaction = TransactionSchema.parse(transaction);

console.log("Validated transaction:", validatedTransaction);
const savedTransaction = await createTransaction({
  ...validatedTransaction,
  telegram_message_id: message.message_id,
});

console.log("Saved transaction:", savedTransaction);

  await bot.sendMessage(
    message.chat.id,
    aiResponse
  );
});

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});