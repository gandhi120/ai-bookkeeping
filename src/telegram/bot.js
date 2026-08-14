import TelegramBot from "node-telegram-bot-api";
import "dotenv/config";

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
   await bot.sendMessage(
    message.chat.id,
    `I received: ${message.text}`
  );
});

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});