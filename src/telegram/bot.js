import TelegramBot from "node-telegram-bot-api";
import "dotenv/config";

import { processMessage } from "../services/transaction.service.js";
import { getDailySummary } from "../services/summary.service.js";
import { isCustomerTransaction } from "../schemas/transaction.schema.js";

import {
  getTransactionsByDate,
  findOrCreateUser,
  createMessage,
  updateMessageStatus,
  updateMessageTransactionData,
  getMessageByTelegramMessageId,
  confirmMessageTransaction,
  getCustomerByName,
  getCustomerBalance,
  getCustomerTransactions,
  getAllOutstanding,
} from "../database/postgres.js";

import { getMonthlySummary } from "../services/monthly-summary.service.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

// Creates a Telegram bot instance.
// polling: true means our Node.js app continuously checks Telegram
// for new messages.
const bot = new TelegramBot(token, {
  polling: true,
});

console.log("Telegram bot is running...");

// --------------------------------------------------
// Shared helpers
// --------------------------------------------------

// Resolves the Telegram sender into a shopkeeper row.
// EVERY handler must call this before reading or writing data, because
// user.id is what scopes all queries. Without it a handler would read
// across all shopkeepers.
async function resolveShopkeeper(from, chat) {
  return await findOrCreateUser({
    telegram_user_id: from.id,
    telegram_chat_id: chat.id,
    first_name: from.first_name,
    username: from.username,
  });
}

// Formats a number as Indian rupees, e.g. 50000 -> "₹50,000".
function money(value) {
  return `₹${Number(value).toLocaleString("en-IN")}`;
}

// Returns today's date as YYYY-MM-DD in the shop's timezone.
// "en-CA" is used because that locale formats dates as YYYY-MM-DD,
// which is exactly what PostgreSQL expects for a ::date cast.
function today() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
}

// --------------------------------------------------
// /monthly
// --------------------------------------------------

// Generates and sends the current month's financial summary.
bot.onText(/^\/monthly$/, async (message) => {
  try {
    // Scope the summary to this shopkeeper only.
    const user = await resolveShopkeeper(message.from, message.chat);

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

    const summary = await getMonthlySummary(user.id, year, month);

    const monthName = now.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });

    await bot.sendMessage(
      message.chat.id,
      `📊 Monthly Summary

${monthName}

Sales: ${money(summary.totalSales)}
Purchases: ${money(summary.totalPurchases)}
Expenses: ${money(summary.totalExpenses)}
Net Balance: ${money(summary.netBalance)}

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

// Sends the welcome message and available commands.
bot.onText(/^\/start$/, async (message) => {
  await bot.sendMessage(
    message.chat.id,
    `👋 Welcome to your AI Bookkeeping Assistant!

Just send me your shop transactions in normal language.

Buying and selling:

"Bought 10 kg rice for ₹600"
"Sold 5 shirts for ₹2,500"
"Paid electricity bill ₹1,800"

Udhaar (credit):

"Raj took goods for ₹2,000 on udhaar"
"Raj paid ₹1,000"

Ask me anything:

"How much does Raj owe me?"
"Show Raj's transactions"

Commands:

/summary - Today's financial summary
/transactions - Today's transactions
/monthly - Monthly financial summary
/udhaar - Who owes you money
/help - Show available commands`
  );
});

// --------------------------------------------------
// /help
// --------------------------------------------------

// Sends the available bot commands and usage examples.
bot.onText(/^\/help$/, async (message) => {
  await bot.sendMessage(
    message.chat.id,
    `🤖 Bookkeeping Assistant

Send transactions naturally:

"Bought 10 kg rice for ₹600"
"Sold 5 shirts for ₹2,500"
"Paid electricity bill ₹1,800"
"Paid ₹3,000 to supplier"

Udhaar (credit):

"Raj took goods for ₹2,000 on udhaar"
"Sold goods to Amit for ₹2,500 on credit"
"Raj paid ₹1,000"
"Raj cleared his ₹3,000 udhaar"

Ask about a customer:

"How much does Raj owe me?"
"Show Raj's transactions"

Commands:

/summary - Today's financial summary
/transactions - Today's transactions
/monthly - Monthly financial summary
/udhaar - Who owes you money
/help - Show this help`
  );
});

// --------------------------------------------------
// /transactions
// --------------------------------------------------

// Fetches and displays today's transactions for the user.
bot.onText(/^\/transactions$/, async (message) => {
  try {
    // Scope the list to this shopkeeper only.
    const user = await resolveShopkeeper(message.from, message.chat);

    const date = today();

    const transactions = await getTransactionsByDate(user.id, date);

    if (transactions.length === 0) {
      await bot.sendMessage(
        message.chat.id,
        `📋 No transactions found for ${date}.`
      );

      return;
    }

    const transactionList = transactions
      .map(
        (transaction, index) =>
          `${index + 1}. ${transaction.transaction_type.toUpperCase()}
${transaction.description} — ${money(transaction.amount)}
Category: ${transaction.category}${
            transaction.person ? `\nCustomer: ${transaction.person}` : ""
          }`
      )
      .join("\n\n");

    await bot.sendMessage(
      message.chat.id,
      `📋 Today's Transactions

Date: ${date}

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

// Generates and sends today's financial summary.
bot.onText(/^\/summary$/, async (message) => {
  try {
    // Scope the summary to this shopkeeper only.
    const user = await resolveShopkeeper(message.from, message.chat);

    const summary = await getDailySummary(user.id, today());

    await bot.sendMessage(
      message.chat.id,
      `📊 Daily Summary

Date: ${summary.date}

Sales: ${money(summary.totalSales)}
Purchases: ${money(summary.totalPurchases)}
Expenses: ${money(summary.totalExpenses)}
Net Balance: ${money(summary.netBalance)}

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
// /udhaar
// --------------------------------------------------

// Shows every customer who still owes this shopkeeper money.
bot.onText(/^\/udhaar$/, async (message) => {
  try {
    const user = await resolveShopkeeper(message.from, message.chat);

    const customers = await getAllOutstanding(user.id);

    if (customers.length === 0) {
      await bot.sendMessage(
        message.chat.id,
        "📒 No pending udhaar. Everyone has cleared their balance."
      );

      return;
    }

    const total = customers.reduce(
      (sum, customer) => sum + Number(customer.outstanding),
      0
    );

    const list = customers
      .map(
        (customer, index) =>
          `${index + 1}. ${customer.name} — ${money(customer.outstanding)}`
      )
      .join("\n");

    await bot.sendMessage(
      message.chat.id,
      `📒 Udhaar Book

${list}

Total pending: ${money(total)}`
    );
  } catch (error) {
    console.error("Udhaar list error:", error);

    await bot.sendMessage(
      message.chat.id,
      "Sorry, I couldn't load the udhaar book."
    );
  }
});

// --------------------------------------------------
// Customer question helpers
// --------------------------------------------------

// Answers "How much does Raj owe me?".
// Read-only: nothing is created, so this never enters the confirmation flow.
async function answerBalanceQuery(chatId, user, personName) {
  const customer = await getCustomerByName(user.id, personName);

  // The shopkeeper has no such customer. Say so instead of showing ₹0,
  // which would look like a cleared balance.
  if (!customer) {
    await bot.sendMessage(
      chatId,
      `🔍 No customer named "${personName}" in your khata yet.`
    );

    return;
  }

  const balance = await getCustomerBalance(user.id, customer.id);

  if (balance === 0) {
    await bot.sendMessage(
      chatId,
      `✅ ${customer.name} has cleared all udhaar. Outstanding: ₹0`
    );

    return;
  }

  // A negative balance means the customer paid more than they owed,
  // so the shopkeeper is holding advance money for them.
  if (balance < 0) {
    await bot.sendMessage(
      chatId,
      `💰 ${customer.name} has paid ${money(
        Math.abs(balance)
      )} in advance (no pending udhaar).`
    );

    return;
  }

  await bot.sendMessage(
    chatId,
    `📒 ${customer.name} owes you ${money(balance)}.`
  );
}

// Answers "Show Raj's transactions" with that customer's udhaar entries.
async function answerHistoryQuery(chatId, user, personName) {
  const customer = await getCustomerByName(user.id, personName);

  if (!customer) {
    await bot.sendMessage(
      chatId,
      `🔍 No customer named "${personName}" in your khata yet.`
    );

    return;
  }

  const transactions = await getCustomerTransactions(user.id, customer.id);

  if (transactions.length === 0) {
    await bot.sendMessage(
      chatId,
      `📋 No entries yet for ${customer.name}.`
    );

    return;
  }

  const balance = await getCustomerBalance(user.id, customer.id);

  const list = transactions
    .map((transaction) => {
      // Show the direction of each entry so the running total makes sense.
      const sign =
        transaction.transaction_type === "credit_sale" ? "＋" : "－";

      const date = new Date(
        transaction.transaction_date
      ).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        timeZone: "Asia/Kolkata",
      });

      return `${sign} ${money(transaction.amount)}  ${date}
   ${transaction.description}`;
    })
    .join("\n");

  await bot.sendMessage(
    chatId,
    `📋 ${customer.name}'s Khata

${list}

Outstanding: ${money(balance)}`
  );
}

// --------------------------------------------------
// Normal transaction messages
// --------------------------------------------------

bot.on("message", async (message) => {
  // Ignore Telegram commands.
  if (message.text?.startsWith("/")) {
    return;
  }

  // Declared OUTSIDE the try block on purpose. `const` inside try{} is
  // block scoped and would be invisible to catch{}, so the FAILED status
  // could never be written.
  let savedMessage;

  try {
    // Find or create the shopkeeper from Telegram information.
    const user = await resolveShopkeeper(message.from, message.chat);

    // Save every incoming Telegram message permanently.
    savedMessage = await createMessage({
      user_id: user.id,
      telegram_message_id: message.message_id,
      message_text: message.text,
      status: "RECEIVED",
    });

    // createMessage uses ON CONFLICT DO NOTHING, so a redelivered Telegram
    // message returns no row. Fetch the original instead of crashing.
    if (!savedMessage) {
      savedMessage = await getMessageByTelegramMessageId(
        user.id,
        message.message_id
      );
    }

    // Mark the message as currently being processed by AI.
    await updateMessageStatus(
      savedMessage.id,
      "PROCESSING"
    );

    // Ask Groq what this message means and validate the answer with Zod.
    const result = await processMessage(
      message.text,
      message.message_id
    );

    // ----------------------------------------------
    // Questions are answered immediately.
    // They create nothing, so they skip confirmation entirely.
    // ----------------------------------------------
    if (result.intent === "balance_query") {
      await answerBalanceQuery(message.chat.id, user, result.person);
      await updateMessageStatus(savedMessage.id, "ANSWERED");

      return;
    }

    if (result.intent === "history_query") {
      await answerHistoryQuery(message.chat.id, user, result.person);
      await updateMessageStatus(savedMessage.id, "ANSWERED");

      return;
    }

    // ----------------------------------------------
    // A real transaction: store it and wait for confirmation.
    // ----------------------------------------------

    // Store the AI-generated transaction data in PostgreSQL.
    // This is why no in-memory Map is needed: the pending transaction
    // survives a server restart because PostgreSQL holds it.
    await updateMessageTransactionData(
      savedMessage.id,
      result.transaction
    );

    // AI processing succeeded, so wait for user confirmation.
    await updateMessageStatus(
      savedMessage.id,
      "PENDING_CONFIRMATION"
    );

    // For udhaar entries, show what the customer owes right now so the
    // shopkeeper can see the before/after before committing to it.
    let khataLine = "";

    if (
      isCustomerTransaction(result.transaction.transaction_type) &&
      result.transaction.person
    ) {
      const customer = await getCustomerByName(
        user.id,
        result.transaction.person
      );

      const current = customer
        ? await getCustomerBalance(user.id, customer.id)
        : 0;

      const after =
        result.transaction.transaction_type === "credit_sale"
          ? current + Number(result.transaction.amount)
          : current - Number(result.transaction.amount);

      khataLine = `\nCustomer: ${result.transaction.person}
Currently owes: ${money(current)}
After this entry: ${money(after)}`;
    }

    // Show the transaction preview with Confirm / Cancel buttons.
    await bot.sendMessage(
      message.chat.id,
      `📝 Please confirm

Type: ${result.transaction.transaction_type}
Description: ${result.transaction.description}
Category: ${result.transaction.category}
Quantity: ${result.transaction.quantity}
Amount: ${money(result.transaction.amount)}
Date: ${new Date(
        result.transaction.transaction_date
      ).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })}${khataLine}`,
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

    // Mark the message as failed because AI processing failed.
    // savedMessage is visible here because it is declared in the outer
    // scope above the try block.
    if (savedMessage) {
      await updateMessageStatus(
        savedMessage.id,
        "FAILED"
      );
    }

    await bot.sendMessage(
      message.chat.id,
      "Sorry, I couldn't process that transaction."
    );
  }
});

// --------------------------------------------------
// Confirm / Cancel buttons
// --------------------------------------------------

// Handles Confirm / Cancel button clicks using PostgreSQL
// as the source of truth instead of an in-memory Map.
bot.on("callback_query", async (query) => {
  try {
    const [action, messageId] = query.data.split(":");

    const telegramMessageId = Number(messageId);

    // Get the shopkeeper who clicked the button.
    const user = await resolveShopkeeper(query.from, query.message.chat);

    // Retrieve the original message and its transaction data
    // from PostgreSQL.
    const savedMessage =
      await getMessageByTelegramMessageId(
        user.id,
        telegramMessageId
      );

    // The message does not exist in PostgreSQL.
    if (!savedMessage) {
      await bot.answerCallbackQuery(query.id, {
        text: "Transaction not found.",
      });

      return;
    }

    // Only a pending transaction can be confirmed or cancelled.
    if (savedMessage.status !== "PENDING_CONFIRMATION") {
      await bot.answerCallbackQuery(query.id, {
        text: `Transaction already ${savedMessage.status.toLowerCase()}.`,
      });

      return;
    }

    // The AI-generated transaction data is stored in PostgreSQL.
    const transaction = savedMessage.transaction_data;

    // Make sure transaction data exists before continuing.
    if (!transaction) {
      await bot.answerCallbackQuery(query.id, {
        text: "Transaction data not found.",
      });

      return;
    }

    // --------------------------------------------------
    // Cancel
    // --------------------------------------------------

    if (action === "cancel") {
      // Mark the original Telegram message as cancelled.
      await updateMessageStatus(
        savedMessage.id,
        "CANCELLED"
      );

      await bot.answerCallbackQuery(query.id, {
        text: "Transaction cancelled.",
      });

      // Replace the confirmation message with the cancellation result.
      await bot.editMessageText(
        "❌ Transaction cancelled.",
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );

      return;
    }

    // --------------------------------------------------
    // Confirm
    // --------------------------------------------------

    if (action === "confirm") {
      // Confirm the message and create the transaction
      // atomically inside PostgreSQL.
      const result = await confirmMessageTransaction(
        savedMessage.id,
        user.id
      );

      // The message was not found.
      if (result.reason === "NOT_FOUND") {
        await bot.answerCallbackQuery(query.id, {
          text: "Transaction not found.",
        });

        return;
      }

      // The message was already confirmed, cancelled,
      // or otherwise processed.
      if (result.reason === "ALREADY_PROCESSED") {
        await bot.answerCallbackQuery(query.id, {
          text: `Transaction already ${result.status.toLowerCase()}.`,
        });

        return;
      }

      // Transaction data is missing from the message.
      if (result.reason === "TRANSACTION_DATA_MISSING") {
        await bot.answerCallbackQuery(query.id, {
          text: "Transaction data not found.",
        });

        return;
      }

      // The transaction was successfully created
      // and the message was marked as CONFIRMED.
      if (result.success) {
        const savedTransaction = result.transaction;

        await bot.answerCallbackQuery(query.id, {
          text: "Transaction saved!",
        });

        // For udhaar entries, show the customer's new outstanding balance
        // so the shopkeeper gets immediate confirmation of the khata.
        let khataLine = "";

        if (savedTransaction.customer_id) {
          const balance = await getCustomerBalance(
            user.id,
            savedTransaction.customer_id
          );

          khataLine = `\n\n📒 ${savedTransaction.person} now owes ${money(
            balance
          )}`;
        }

        // Replace the confirmation message with the saved result.
        await bot.editMessageText(
          `✅ Transaction saved

Type: ${savedTransaction.transaction_type}
Description: ${savedTransaction.description}
Amount: ${money(savedTransaction.amount)}${khataLine}`,
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
          }
        );

        return;
      }
    }

    // Unknown callback action.
    await bot.answerCallbackQuery(query.id, {
      text: "Unknown action.",
    });
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

// Handles errors reported by Telegram polling.
bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});