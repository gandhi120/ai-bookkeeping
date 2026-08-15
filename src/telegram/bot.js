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
  getWorkspaces,
  getActiveWorkspace,
  createWorkspace,
  setActiveWorkspace,
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

// Resolves the Telegram sender into a user row AND the workspace they are
// currently working in.
//
// EVERY handler must call this before reading or writing data. user.id scopes
// across users; workspace.id scopes within one user, so their shop ledger and
// their home ledger stay apart. `workspace` is undefined for a brand new user
// who has not been through onboarding yet — handlers check for that rather
// than guessing a default.
async function resolveShopkeeper(from, chat) {
  const user = await findOrCreateUser({
    telegram_user_id: from.id,
    telegram_chat_id: chat.id,
    first_name: from.first_name,
    username: from.username,
  });

  return { user, workspace: await getActiveWorkspace(user.id) };
}

// The two ledgers a user can keep, and how they are shown.
// `name` is only the default at creation — nothing looks a workspace up by it.
const WORKSPACE_KINDS = {
  shopkeeper: { icon: "🏪", name: "My Shop", label: "Shop" },
  household: { icon: "🏠", name: "My Home", label: "Household" },
};

// "🏪 My Shop" — how a workspace is named everywhere in the UI.
function workspaceLabel(workspace) {
  return `${WORKSPACE_KINDS[workspace.type].icon} ${workspace.name}`;
}

// Sent whenever a handler needs a workspace and the user has none yet.
// Returning the buttons rather than a bare error means onboarding can start
// from any command, not just /start.
async function askToChooseWorkspace(chatId) {
  await bot.sendMessage(
    chatId,
    `👋 What do you want to manage?

🏪 Shop — track your business
🏠 Household — track your personal/family money

You can add the other one later.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏪 Shop", callback_data: "addws:shopkeeper" }],
          [{ text: "🏠 Household", callback_data: "addws:household" }],
        ],
      },
    }
  );
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

// Money from a NAMED person, where the message never said what it was for.
// "Received ₹5000 from Raj" might settle Raj's udhaar or might be ordinary
// income. Only the shopkeeper knows, and guessing wrong silently changes
// what a customer owes — so we ask instead of deciding.
//
// The AI only produces payment_received + a person for exactly this case:
// anything that states it settles a debt comes back as `repayment`.
function needsPaymentClarification(transaction) {
  return (
    transaction.transaction_type === "payment_received" &&
    Boolean(transaction.person)
  );
}

// Handles the two workspace buttons: switching to an existing workspace
// (`ws:<uuid>`) and creating one during onboarding (`addws:<type>`).
//
// Both payloads come from the user's Telegram client, so neither is trusted:
// `addws` is looked up in WORKSPACE_KINDS, which is the whitelist, and
// setActiveWorkspace refuses a workspace that is not this user's.
async function handleWorkspaceAction(query, action, value) {
  const chatId = query.message.chat.id;

  const { user } = await resolveShopkeeper(query.from, query.message.chat);

  let workspace;

  if (action === "addws") {
    const kind = WORKSPACE_KINDS[value];

    if (!kind) {
      await bot.answerCallbackQuery(query.id, { text: "Unknown workspace." });

      return;
    }

    workspace = await createWorkspace(user.id, kind.name, value);
    await setActiveWorkspace(user.id, workspace.id);
  } else {
    // A forged or stale uuid updates nothing and returns undefined.
    const updated = await setActiveWorkspace(user.id, value);

    if (!updated) {
      await bot.answerCallbackQuery(query.id, { text: "Workspace not found." });

      return;
    }

    workspace = await getActiveWorkspace(user.id);
  }

  await bot.answerCallbackQuery(query.id, {
    text: `Switched to ${workspace.name}`,
  });

  await bot.editMessageText(`✅ Now using ${workspaceLabel(workspace)}`, {
    chat_id: chatId,
    message_id: query.message.message_id,
  });

  await bot.sendMessage(
    chatId,
    workspace.type === "household"
      ? `Send me your household spending, like "Bought groceries for ₹500" or "Salary received ₹65,000".`
      : `Send me your shop transactions, like "Sold 5 shirts for ₹2,500" or "Raj took goods for ₹2,000 on udhaar".`
  );
}

// Maps a clarification button to the transaction type it means.
// Callback data arrives from the user's Telegram client, so this lookup is
// the whitelist: anything not listed here can never reach the database.
const CLARIFIED_TYPE = {
  repayment: "repayment",
  income: "payment_received",
};

// --------------------------------------------------
// /monthly
// --------------------------------------------------

// Generates and sends the current month's financial summary.
bot.onText(/^\/monthly$/, async (message) => {
  try {
    // Scope the summary to this workspace only.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    if (!workspace) {
      await askToChooseWorkspace(message.chat.id);

      return;
    }

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

    const summary = await getMonthlySummary(
      user.id,
      workspace.id,
      year,
      month,
      workspace.type
    );

    const monthName = now.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });

    // A household reports income against expenses and where the money went;
    // a shop reports sales against purchases. Different questions, so the
    // dashboard is not one layout with some rows blanked out.
    const body =
      workspace.type === "household"
        ? `Income: ${money(summary.totalIncome)}
Expenses: ${money(summary.totalExpenses)}
Balance: ${money(summary.balance)}${
            summary.byCategory.length > 0
              ? `\n\nWhere it went:\n${summary.byCategory
                  .map((row) => `${row.category} — ${money(row.total)}`)
                  .join("\n")}`
              : ""
          }`
        : `Sales: ${money(summary.totalSales)}
Purchases: ${money(summary.totalPurchases)}
Expenses: ${money(summary.totalExpenses)}
Net Balance: ${money(summary.netBalance)}`;

    await bot.sendMessage(
      message.chat.id,
      `📊 ${workspaceLabel(workspace)} — Monthly Summary

${monthName}

${body}

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
//
// A user with no workspace is onboarded instead: they pick a shop or a
// household and are never forced to create both.
bot.onText(/^\/start$/, async (message) => {
  const { workspace } = await resolveShopkeeper(message.from, message.chat);

  if (!workspace) {
    await askToChooseWorkspace(message.chat.id);

    return;
  }

  if (workspace.type === "household") {
    await bot.sendMessage(
      message.chat.id,
      `👋 You're in ${workspaceLabel(workspace)}.

Just send me your household spending in normal language.

"Bought groceries for ₹500"
"Paid electricity bill ₹2,400"
"Salary received ₹65,000"
"કિરાણા માટે ₹500 ખર્ચ્યા"

Commands:

/summary - Today's income and spending
/transactions - Today's entries
/monthly - This month's dashboard
/workspace - Switch between shop and home
/help - Show available commands`
    );

    return;
  }

  await bot.sendMessage(
    message.chat.id,
    `👋 You're in ${workspaceLabel(workspace)}.

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
/workspace - Switch between shop and home
/help - Show available commands`
  );
});

// --------------------------------------------------
// /workspace
// --------------------------------------------------

// Shows which ledger is active and offers to switch or create the other one.
bot.onText(/^\/workspace$/, async (message) => {
  try {
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    const workspaces = await getWorkspaces(user.id);

    if (workspaces.length === 0) {
      await askToChooseWorkspace(message.chat.id);

      return;
    }

    // One row per existing workspace, ✓ on the active one.
    const rows = workspaces.map((existing) => [
      {
        text: `${workspaceLabel(existing)}${
          existing.id === workspace?.id ? "  ✓" : ""
        }`,
        callback_data: `ws:${existing.id}`,
      },
    ]);

    // Then an "+ Add ..." button for whichever kind they don't have yet.
    for (const [type, kind] of Object.entries(WORKSPACE_KINDS)) {
      if (!workspaces.some((existing) => existing.type === type)) {
        rows.push([
          {
            text: `+ Add ${kind.label}`,
            callback_data: `addws:${type}`,
          },
        ]);
      }
    }

    await bot.sendMessage(message.chat.id, "Current workspace", {
      reply_markup: { inline_keyboard: rows },
    });
  } catch (error) {
    console.error("Workspace error:", error);

    await bot.sendMessage(
      message.chat.id,
      "Sorry, I couldn't load your workspaces."
    );
  }
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
/workspace - Switch between shop and home
/help - Show this help

🏠 In your household workspace, send things like
"Bought groceries for ₹500" or "Salary received ₹65,000".`
  );
});

// --------------------------------------------------
// /transactions
// --------------------------------------------------

// Fetches and displays today's transactions for the user.
bot.onText(/^\/transactions$/, async (message) => {
  try {
    // Scope the list to this workspace only.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    if (!workspace) {
      await askToChooseWorkspace(message.chat.id);

      return;
    }

    const date = today();

    const transactions = await getTransactionsByDate(
      user.id,
      workspace.id,
      date
    );

    if (transactions.length === 0) {
      await bot.sendMessage(
        message.chat.id,
        `📋 No transactions found for ${date} in ${workspaceLabel(workspace)}.`
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
      `📋 ${workspaceLabel(workspace)} — Today's Transactions

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
    // Scope the summary to this workspace only.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    if (!workspace) {
      await askToChooseWorkspace(message.chat.id);

      return;
    }

    const summary = await getDailySummary(
      user.id,
      workspace.id,
      today(),
      workspace.type
    );

    const body =
      workspace.type === "household"
        ? `Income: ${money(summary.totalIncome)}
Expenses: ${money(summary.totalExpenses)}
Balance: ${money(summary.balance)}`
        : `Sales: ${money(summary.totalSales)}
Purchases: ${money(summary.totalPurchases)}
Expenses: ${money(summary.totalExpenses)}
Net Balance: ${money(summary.netBalance)}`;

    await bot.sendMessage(
      message.chat.id,
      `📊 ${workspaceLabel(workspace)} — Daily Summary

Date: ${summary.date}

${body}

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
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    // Udhaar is a khata, and only a shop keeps one.
    if (!workspace || workspace.type !== "shopkeeper") {
      await bot.sendMessage(
        message.chat.id,
        "📒 Udhaar is a shop feature. Switch to your shop with /workspace to see who owes you money."
      );

      return;
    }

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

// Asks the shopkeeper what an ambiguous payment was actually for.
//
// Nothing is written here. The message is already saved as
// PENDING_CONFIRMATION with its transaction data, so the answer can arrive
// after a restart — the buttons carry only the Telegram message id, and
// everything else is looked up again in PostgreSQL.
//
// The customer's current outstanding is shown because that is the number
// the shopkeeper needs in order to answer correctly.
async function askPaymentClarification(
  chatId,
  user,
  transaction,
  telegramMessageId
) {
  const customer = await getCustomerByName(user.id, transaction.person);

  // A customer with no khata yet still gets the question: the shopkeeper may
  // have given the udhaar verbally before ever recording it here.
  const khataLine = customer
    ? `\n${transaction.person} currently owes: ${money(
        await getCustomerBalance(user.id, customer.id)
      )}`
    : `\n${transaction.person} has no udhaar recorded yet.`;

  await bot.sendMessage(
    chatId,
    `📝 Please confirm

Amount: ${money(transaction.amount)}
From: ${transaction.person}
Description: ${transaction.description}
Date: ${new Date(transaction.transaction_date).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    })}
${khataLine}

❓ Did ${transaction.person} pay this toward their udhaar, or is this a normal payment?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📒 Udhaar Repayment",
              callback_data: `repayment:${telegramMessageId}`,
            },
            {
              text: "💰 Normal Payment",
              callback_data: `income:${telegramMessageId}`,
            },
          ],
          [
            {
              text: "❌ Cancel",
              callback_data: `cancel:${telegramMessageId}`,
            },
          ],
        ],
      },
    }
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
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    // Without a workspace there is no ledger to write to. Ask before
    // spending an AI call on a message that has nowhere to go.
    if (!workspace) {
      await askToChooseWorkspace(message.chat.id);

      return;
    }

    // Save every incoming Telegram message permanently.
    savedMessage = await createMessage({
      user_id: user.id,
      workspace_id: workspace.id,
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
    // The workspace type picks which rules the AI is given and which
    // transaction types are allowed back.
    const result = await processMessage(
      message.text,
      message.message_id,
      workspace.type
    );

    // The message made sense but does not belong in this ledger — a customer
    // question asked at home, or a type this workspace cannot record. Say so
    // plainly instead of failing with a generic apology.
    if (result.intent === "unsupported") {
      await bot.sendMessage(
        message.chat.id,
        result.reason === "CUSTOMER_QUERY_OUTSIDE_SHOP"
          ? `That's a customer question, and ${workspaceLabel(
              workspace
            )} has no customers. Switch to your shop with /workspace.`
          : `I couldn't record that in ${workspaceLabel(
              workspace
            )}. Try rephrasing, or switch workspace with /workspace.`
      );

      await updateMessageStatus(savedMessage.id, "ANSWERED");

      return;
    }

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

    // The AI could not tell what this money was for. Ask before offering to
    // save anything — a wrong guess here would move a customer's balance.
    if (needsPaymentClarification(result.transaction)) {
      await askPaymentClarification(
        message.chat.id,
        user,
        result.transaction,
        message.message_id
      );

      return;
    }

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

    // Workspace buttons carry a uuid or a workspace type, not a Telegram
    // message id, so they are handled BEFORE the Number() parse below —
    // which would otherwise turn them into NaN.
    if (action === "ws" || action === "addws") {
      await handleWorkspaceAction(query, action, messageId);

      return;
    }

    const telegramMessageId = Number(messageId);

    // Set only when the shopkeeper answered the "what was this money for?"
    // question. null for a plain Confirm, which keeps the AI's own type.
    const typeOverride = CLARIFIED_TYPE[action] ?? null;

    // Get the shopkeeper who clicked the button.
    const { user } = await resolveShopkeeper(query.from, query.message.chat);

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

    // An ambiguous payment can only be saved through a clarification button.
    // The plain Confirm button is never shown for one, but callback data
    // comes from the user's client, so refuse it here rather than trust that.
    if (action === "confirm" && needsPaymentClarification(transaction)) {
      await bot.answerCallbackQuery(query.id, {
        text: "Please choose what this payment was for.",
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
    // Confirm (or a clarification button, which confirms and chooses
    // the meaning in the same tap)
    // --------------------------------------------------

    if (action === "confirm" || typeOverride) {
      // Confirm the message and create the transaction
      // atomically inside PostgreSQL.
      const result = await confirmMessageTransaction(
        savedMessage.id,
        user.id,
        typeOverride
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

          // A repayment can overshoot the debt, leaving a negative balance.
          // "owes ₹-4,000" reads as nonsense to a shopkeeper, so a negative
          // is phrased as advance money held — matching how the balance
          // question answers it.
          khataLine =
            balance < 0
              ? `\n\n📒 ${savedTransaction.person} has paid ${money(
                  Math.abs(balance)
                )} in advance`
              : `\n\n📒 ${savedTransaction.person} now owes ${money(balance)}`;
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