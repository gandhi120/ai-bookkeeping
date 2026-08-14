import TelegramBot from "node-telegram-bot-api";
import "dotenv/config";
import { processTransaction } from "../services/transaction.service.js";
import { getDailySummary } from "../services/summary.service.js";
import { getTransactionsByDate } from "../database/postgres.js";
import { getMonthlySummary } from "../services/monthly-summary.service.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

// Creates a Telegram bot instance.
// polling: true means our Node.js app continuously checks Telegram
// for new messages.
const bot = new TelegramBot(token, {
  polling: true,
});

console.log("Telegram bot is running...");

// Handles the /monthly command.
bot.onText(/^\/monthly$/, async (message) => {
  try {
    const now = new Date();

    const year = Number(
      now.toLocaleDateString("en-IN", {
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    );

    const month = Number(
      now.toLocaleDateString("en-IN", {
        month: "numeric",
        timeZone: "Asia/Kolkata",
      })
    );

    const summary = await getMonthlySummary(year, month);

    const monthName = now.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });

    await bot.sendMessage(
      message.chat.id,
      `📊 Monthly Summary

${monthName}

Sales: ₹${summary.totalSales}
Purchases: ₹${summary.totalPurchases}
Expenses: ₹${summary.totalExpenses}
Net Balance: ₹${summary.netBalance}

Transactions: ${summary.transactionCount}`
    );
  } catch (error) {
    console.error("Monthly summary error:", error);

    await bot.sendMessage(
      message.chat.id,
      "Sorry, I couldn't generate the monthly summary."
    );
  }
});

// Handles the /start command.
bot.onText(/^\/start$/, async (message) => {
  await bot.sendMessage(
    message.chat.id,
    `👋 Welcome to your AI Bookkeeping Assistant!

You can simply send me your business transactions in normal language.

For example:

"Bought a laptop for ₹50,000"
"Sold 5 T-shirts for ₹3,000"
"Paid ₹500 for electricity"

Commands:

/summary - Today's financial summary
/transactions - Today's transactions
/monthly - Monthly financial summary
/help - Show available commands`
  );
});

// Handles the /help command.
bot.onText(/^\/help$/, async (message) => {
  await bot.sendMessage(
    message.chat.id,
    `🤖 Bookkeeping Assistant

You can send transactions naturally:

"Bought a laptop for ₹50,000"
"Sold 5 T-shirts for ₹3,000"
"Paid ₹500 for electricity"

Commands:

/summary - Today's financial summary
/transactions - Today's transactions
/monthly - Monthly financial summary
/help - Show this help`
  );
});

// Handles the /transactions command.
bot.onText(/^\/transactions$/, async (message) => {
  try {
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });

    const transactions = await getTransactionsByDate(today);

    if (transactions.length === 0) {
      await bot.sendMessage(
        message.chat.id,
        `📋 No transactions found for ${today}.`
      );

      return;
    }

    const transactionList = transactions
      .map(
        (transaction, index) =>
          `${index + 1}. ${transaction.transaction_type.toUpperCase()}
${transaction.description} — ₹${transaction.amount}
Category: ${transaction.category}`
      )
      .join("\n\n");

    await bot.sendMessage(
      message.chat.id,
      `📋 Today's Transactions

Date: ${today}

${transactionList}`
    );
  } catch (error) {
    console.error("Transactions error:", error);

    await bot.sendMessage(
      message.chat.id,
      "Sorry, I couldn't get today's transactions."
    );
  }
});

// Handles the /summary command.
bot.onText(/^\/summary$/, async (message) => {
  try {
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });

    const summary = await getDailySummary(today);

    await bot.sendMessage(
      message.chat.id,
      `📊 Daily Summary

Date: ${summary.date}

Sales: ₹${summary.totalSales}
Purchases: ₹${summary.totalPurchases}
Expenses: ₹${summary.totalExpenses}
Net Balance: ₹${summary.netBalance}

Transactions: ${summary.transactionCount}`
    );
  } catch (error) {
    console.error("Summary error:", error);

    await bot.sendMessage(
      message.chat.id,
      "Sorry, I couldn't generate the summary."
    );
  }
});

// Handles normal transaction messages.
bot.on("message", async (message) => {
  // Ignore Telegram commands.
  if (message.text?.startsWith("/")) {
    return;
  }

  try {
    console.log("Message received:", message.text);

    // Telegram → Groq → JSON → Zod → PostgreSQL
    const result = await processTransaction(
      message.text,
      message.message_id
    );

    // Handle duplicate Telegram messages.
    if (result.duplicate) {
      await bot.sendMessage(
        message.chat.id,
        "⚠️ This transaction was already processed."
      );

      return;
    }

    console.log("Saved transaction:", result);

    // Send confirmation back to the user.
    await bot.sendMessage(
      message.chat.id,
      `✅ Transaction saved

Type: ${result.transaction.transaction_type}
Description: ${result.transaction.description}
Category: ${result.transaction.category}
Quantity: ${result.transaction.quantity}
Amount: ₹${result.transaction.amount}
Date: ${new Date(
        result.transaction.transaction_date
      ).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })}`
    );
  } catch (error) {
    console.error("Transaction processing error:", error);

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