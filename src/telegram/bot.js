import TelegramBot from "node-telegram-bot-api";
import "dotenv/config";

import { processTransaction } from "../services/transaction.service.js";
import { getDailySummary } from "../services/summary.service.js";
import {
  getTransactionsByDate,
  createTransaction,
} from "../database/postgres.js";
import { getMonthlySummary } from "../services/monthly-summary.service.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

// Creates a Telegram bot instance.
// polling: true means our Node.js app continuously checks Telegram
// for new messages.
const bot = new TelegramBot(token, {
  polling: true,
});

// Stores transactions waiting for user confirmation.
const pendingTransactions = new Map();

console.log("Telegram bot is running...");

// --------------------------------------------------
// /monthly
// --------------------------------------------------

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

// --------------------------------------------------
// /start
// --------------------------------------------------

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

// --------------------------------------------------
// /help
// --------------------------------------------------

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

// --------------------------------------------------
// /transactions
// --------------------------------------------------

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

// --------------------------------------------------
// /summary
// --------------------------------------------------

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

// --------------------------------------------------
// Normal transaction messages
// --------------------------------------------------

bot.on("message", async (message) => {
  // Ignore Telegram commands.
  if (message.text?.startsWith("/")) {
    return;
  }

  try {
    console.log("Message received:", message.text);

    // Telegram → Groq → JSON → Zod
    // PostgreSQL is NOT called here.
    const result = await processTransaction(
      message.text,
      message.message_id
    );

    console.log(
      "Transaction ready for confirmation:",
      result
    );

    // Store the transaction until the user confirms it.
    pendingTransactions.set(
      message.message_id,
      result.transaction
    );

    // Show transaction preview with Confirm / Cancel buttons.
    await bot.sendMessage(
      message.chat.id,
      `📝 Please confirm

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
      })}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Confirm",
                callback_data: `confirm:${message.message_id}`,
              },
              {
                text: "❌ Cancel",
                callback_data: `cancel:${message.message_id}`,
              },
            ],
          ],
        },
      }
    );
  } catch (error) {
    console.error(
      "Transaction processing error:",
      error
    );

    await bot.sendMessage(
      message.chat.id,
      "Sorry, I couldn't process that transaction."
    );
  }
});

// --------------------------------------------------
// Confirm / Cancel buttons
// --------------------------------------------------

bot.on("callback_query", async (query) => {
  try {
    const [action, messageId] = query.data.split(":");

    const telegramMessageId = Number(messageId);

    // Get the pending transaction.
    const transaction =
      pendingTransactions.get(telegramMessageId);

    // Transaction no longer exists in memory.
    if (!transaction) {
      await bot.answerCallbackQuery(query.id, {
        text: "Transaction not found.",
      });

      return;
    }

    // ----------------------------------------------
    // Cancel
    // ----------------------------------------------

    if (action === "cancel") {
      pendingTransactions.delete(telegramMessageId);

      await bot.answerCallbackQuery(query.id, {
        text: "Transaction cancelled.",
      });

      await bot.editMessageText(
        "❌ Transaction cancelled.",
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );

      return;
    }

    // ----------------------------------------------
    // Confirm
    // ----------------------------------------------

    if (action === "confirm") {
      const savedTransaction =
        await createTransaction(transaction);

      pendingTransactions.delete(telegramMessageId);

      await bot.answerCallbackQuery(query.id, {
        text: "Transaction saved!",
      });

      await bot.editMessageText(
        `✅ Transaction saved

Type: ${savedTransaction.transaction_type}
Description: ${savedTransaction.description}
Amount: ₹${savedTransaction.amount}`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );
    }
  } catch (error) {
    console.error(
      "Confirmation error:",
      error
    );

    await bot.answerCallbackQuery(query.id, {
      text: "Something went wrong.",
    });
  }
});

// --------------------------------------------------
// Telegram polling errors
// --------------------------------------------------

bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});