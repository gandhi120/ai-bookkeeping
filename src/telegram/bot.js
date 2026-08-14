import TelegramBot from "node-telegram-bot-api";
import "dotenv/config";
import { processTransaction } from "../services/transaction.service.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

// Creates a Telegram bot instance.
// polling: true means our Node.js app continuously checks Telegram
// for new messages.
const bot = new TelegramBot(token, {
  polling: true,
});

console.log("Telegram bot is running...");

// Runs whenever someone sends a message to the bot.
bot.on("message", async (message) => {
  try {
    console.log("Message received:", message.text);

    // Send the message to our transaction service.
    // The service handles:
    // Telegram message → Groq → JSON → Zod → PostgreSQL
    const savedTransaction = await processTransaction(
      message.text,
      message.message_id
    );

    console.log("Saved transaction:", savedTransaction);

    // Send confirmation back to the user.
    await bot.sendMessage(
      message.chat.id,
      `Transaction saved successfully.\n\nAmount: ₹${savedTransaction.amount}`
    );
  } catch (error) {
    console.error("Transaction processing error:", error);

    // Tell the user if something went wrong.
    await bot.sendMessage(
      message.chat.id,
      "Sorry, I couldn't process that transaction."
    );
  }
});

// Handles Telegram polling errors.
bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});