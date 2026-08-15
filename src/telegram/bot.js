import TelegramBot from "node-telegram-bot-api";
import "dotenv/config";

import { processMessage } from "../services/transaction.service.js";
import { getDailySummary } from "../services/summary.service.js";
import {
  isCustomerTransaction,
  featuresForWorkspace,
} from "../schemas/transaction.schema.js";

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
  countOnboardingTransactions,
  finishOnboarding,
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

// ONBOARDING STEP 1 — the gate. Sent whenever a handler needs a workspace and
// the user has none yet.
//
// No workspace means no ledger, so nothing else in the bot can run: every
// command and every message routes here until a choice is made. That is what
// makes onboarding unskippable, and it is why this is sent from ten different
// places rather than only from /start — most people never type /start, they
// just say "hii".
//
// It greets and explains before it asks. A first-time user who typed "hii"
// has no idea what this bot is, and being handed two bare buttons is where
// they quit. The options are labelled by what the user gets, not by the word
// "workspace", which no shopkeeper thinks in.
async function askToChooseWorkspace(chatId, user) {
  // first_name is optional on Telegram accounts, so fall back to no name
  // rather than greeting "Hi undefined".
  const greeting = user?.first_name ? `Hi ${user.first_name}!` : "Hello!";

  await bot.sendMessage(
    chatId,
    `👋 ${greeting} I'm your bookkeeping assistant.

Just type what happened — like "Bought 10 kg rice for ₹600" — and I'll
write it in your books. No forms, no Excel.

First, what should I keep books for?

You can add the other one later, so this is not final.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🏪 My Shop — sales, purchases, udhaar",
              callback_data: "addws:shopkeeper",
            },
          ],
          [
            {
              text: "🏠 My Home — household spending",
              callback_data: "addws:household",
            },
          ],
        ],
      },
    }
  );
}

// True until the user finishes onboarding.
//
// Read off the users row that resolveShopkeeper already fetched, so asking
// this costs no extra query. There is no step counter: which step the user is
// on is carried by the button they tap next (onb:summary, onb:finish, ...),
// the same way confirm:/cancel:/addws: already work.
function isOnboarding(user) {
  return !user.onboarding_done_at;
}

// The practice message we ask a new user to type, per ledger type.
// A purchase for the shop and a grocery expense for the home: both are the
// most ordinary entry that ledger will ever see, so the example is one they
// will actually repeat tomorrow.
const PRACTICE_EXAMPLE = {
  shopkeeper: "Bought 10 kg rice for ₹600",
  household: "Bought groceries for ₹500",
};

// ONBOARDING STEP 2 — asks the user to type their first real transaction.
//
// Carries a skip button, because nobody should be held in a tutorial they did
// not ask for. Skip points at `onb:finish` — the same step the Finish button
// uses — so skipping is not a separate path with its own rules: it ends
// onboarding, and still offers to clear anything already recorded.
async function sendPracticePrompt(chatId, workspace) {
  await bot.sendMessage(
    chatId,
    `Let's try it once — takes 30 seconds.

Type this, or your own version:

${PRACTICE_EXAMPLE[workspace.type]}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⏭ Skip setup", callback_data: "onb:finish" }],
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

  // ONBOARDING STEP 2. A first-time user has just answered the only question
  // the bot cannot work without, so instead of a one-line hint they get walked
  // through recording something. Somebody adding a SECOND workspace later is
  // not new and keeps the short hint.
  if (isOnboarding(user)) {
    await bot.sendMessage(chatId, `${workspaceLabel(workspace)} is ready.`);

    await sendPracticePrompt(chatId, workspace);

    return;
  }

  await bot.sendMessage(
    chatId,
    workspace.type === "household"
      ? `Send me your household spending, like "Bought groceries for ₹500" or "Salary received ₹65,000".`
      : `Send me your shop transactions, like "Sold 5 shirts for ₹2,500" or "Raj took goods for ₹2,000 on udhaar".`
  );
}

// ONBOARDING STEP 4 — sent right after the practice transaction is saved.
//
// This is the moment the user has seen the whole loop work, so the tour is
// offered here and nowhere earlier: every command below now has at least one
// real row to show. /summary and /monthly have no empty state, so offering
// them before anything is recorded would introduce the user to their own
// books as a wall of ₹0.
//
// Every feature the tour can show: its button text and the function that
// runs it, in one entry each.
//
// One table rather than a label map beside an action map, so a feature can
// never have a button with no handler or a handler with no label — the second
// would send Telegram a button captioned "undefined".
//
// WHICH of these a given user sees comes from featuresForWorkspace(), so a
// household is never offered a khata.
const TOUR = {
  summary: { label: "📊 Today's summary", run: sendDailySummary },
  monthly: { label: "📅 This month", run: sendMonthlySummary },
  transactions: { label: "📋 Today's entries", run: sendTransactionsList },
  udhaar: { label: "📒 Who owes me", run: sendUdhaarList },
};

// ONBOARDING STEP 4/5 — the feature tour.
//
// Buttons rather than steps. Everything here is optional, so a user who wants
// out taps Finish once and a user who is curious sees every feature run
// against their own data in about ten seconds. That is what keeps "takes 30
// seconds" honest while still covering the whole product.
async function sendFeatureTour(chatId, workspace, intro) {
  const featureRows = featuresForWorkspace(workspace.type).map((feature) => [
    { text: TOUR[feature].label, callback_data: `onb:${feature}` },
  ]);

  await bot.sendMessage(chatId, intro, {
    reply_markup: {
      inline_keyboard: [
        ...featureRows,
        [{ text: "✅ Finish setup", callback_data: "onb:finish" }],
      ],
    },
  });
}

// ONBOARDING STEP 6 — the confirmation before anything is deleted.
//
// The COUNT is the safety rail, not decoration. Everything typed while
// onboarding is open counts as practice, so a user who ignored the finish
// button for a week would be clearing real work. "You have 47 practice
// entries" is what makes that visible before the tap, and Keep is offered
// with equal weight.
async function askToClearPracticeData(chatId, count) {
  const entries = count === 1 ? "1 practice entry" : `${count} practice entries`;

  await bot.sendMessage(
    chatId,
    `Almost done.

You have ${entries} in your books from setup. Clear them so your real accounts start from zero?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧹 Clear practice data", callback_data: "onb:clear" }],
          [{ text: "📌 Keep it", callback_data: "onb:keep" }],
        ],
      },
    }
  );
}

// The only onboarding steps that exist. Callback data is user-supplied, so
// this list is the whitelist: `onb:` with anything else is not routed at all.
//
// Every tour feature must appear here or its button silently does nothing
// useful — an unlisted step does not reach "Unknown action", it falls through
// to the transaction path and reports "Transaction not found."
const ONBOARDING_STEPS = [
  ...Object.keys(TOUR),
  "finish",
  "clear",
  "keep",
];

// Handles every onb:* button — the onboarding steps after the workspace has
// been created.
//
// Callback data comes from the user's Telegram client and is never trusted:
// only the steps above exist, anything else falls through to the caller's
// "Unknown action". `finish` and `clear`/`keep` are separate steps on purpose,
// so deleting data always takes a deliberate second tap.
async function handleOnboardingAction(query, step) {
  const chatId = query.message.chat.id;

  const { user, workspace } = await resolveShopkeeper(
    query.from,
    query.message.chat
  );

  // Onboarding is already over — the buttons are on an old message someone
  // scrolled back to. Say so rather than clearing anything.
  if (!isOnboarding(user)) {
    await bot.answerCallbackQuery(query.id, { text: "Setup is already done." });

    return;
  }

  // A tour button: run the real command against their own data, then offer
  // the card again so trying a second feature is one tap, not a hunt.
  if (TOUR[step]) {
    await bot.answerCallbackQuery(query.id);

    await TOUR[step].run(chatId, user, workspace);

    await sendFeatureTour(chatId, workspace, "What else?");

    return;
  }

  if (step === "finish") {
    await bot.answerCallbackQuery(query.id);

    const count = await countOnboardingTransactions(user.id);

    // Nothing was ever recorded, so there is nothing to ask about. Close
    // onboarding straight away rather than asking to clear zero rows.
    if (count === 0) {
      await finishOnboarding(user.id, { clear: false });

      await bot.sendMessage(chatId, `✅ All set.`);

      await sendWelcomeHelp(chatId, workspace);

      return;
    }

    await askToClearPracticeData(chatId, count);

    return;
  }

  // Only `clear` and `keep` remain, and both end onboarding. Anything else
  // never reaches here — the caller's whitelist decides what gets this far.
  const clear = step === "clear";

  const result = await finishOnboarding(user.id, { clear });

  await bot.answerCallbackQuery(query.id, {
    text: clear ? "Practice data cleared." : "Setup complete.",
  });

  await bot.editMessageText(
    clear
      ? `✅ All set. Cleared ${result.transactions} practice ${
          result.transactions === 1 ? "entry" : "entries"
        }.`
      : `✅ All set. Your practice entries are kept.`,
    {
      chat_id: chatId,
      message_id: query.message.message_id,
    }
  );

  await sendWelcomeHelp(chatId, workspace);
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

// Builds and sends this month's dashboard for one workspace.
//
// Split out of the /monthly command so the onboarding tour can run the real
// thing from a button. Assumes a workspace exists — the callers gate on that.
async function sendMonthlySummary(chatId, user, workspace) {
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
    chatId,
    `📊 ${workspaceLabel(workspace)} — Monthly Summary

${monthName}

${body}

Transactions: ${summary.transactionCount}`
  );
}

// Generates and sends the current month's financial summary.
bot.onText(/^\/monthly$/, async (message) => {
  try {
    // Scope the summary to this workspace only.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    if (!workspace) {
      await askToChooseWorkspace(message.chat.id, user);

      return;
    }

    await sendMonthlySummary(message.chat.id, user, workspace);
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

// The "here is how to use me" text for a workspace, sent by /start and again
// at the end of onboarding. One function rather than two copies so the two
// can never drift apart as commands are added.
async function sendWelcomeHelp(chatId, workspace) {
  if (workspace.type === "household") {
    await bot.sendMessage(
      chatId,
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
    chatId,
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
}

// Sends the welcome message and available commands.
//
// A user with no workspace is onboarded instead: they pick a shop or a
// household and are never forced to create both. A user who is mid-onboarding
// gets the practice prompt again rather than the full command list — they
// have not recorded anything yet, so a list of commands is noise, and the
// finish button here is the escape hatch for someone who never types.
bot.onText(/^\/start$/, async (message) => {
  const { user, workspace } = await resolveShopkeeper(
    message.from,
    message.chat
  );

  if (!workspace) {
    await askToChooseWorkspace(message.chat.id, user);

    return;
  }

  if (isOnboarding(user)) {
    await sendPracticePrompt(message.chat.id, workspace);

    return;
  }

  await sendWelcomeHelp(message.chat.id, workspace);
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
      await askToChooseWorkspace(message.chat.id, user);

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
//
// Checks for a workspace like every other command: a brand new user handed a
// list of commands for a ledger that does not exist yet has been shown the
// menu of a restaurant they have not walked into.
bot.onText(/^\/help$/, async (message) => {
  const { user, workspace } = await resolveShopkeeper(
    message.from,
    message.chat
  );

  if (!workspace) {
    await askToChooseWorkspace(message.chat.id, user);

    return;
  }

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

// Builds and sends today's entry list for one workspace.
//
// Split out of the /transactions command so the onboarding tour can run the
// real thing from a button. Assumes a workspace exists.
async function sendTransactionsList(chatId, user, workspace) {
  const date = today();

  const transactions = await getTransactionsByDate(user.id, workspace.id, date);

  if (transactions.length === 0) {
    await bot.sendMessage(
      chatId,
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
    chatId,
    `📋 ${workspaceLabel(workspace)} — Today's Transactions

Date: ${date}

${transactionList}`
  );
}

// Fetches and displays today's transactions for the user.
bot.onText(/^\/transactions$/, async (message) => {
  try {
    // Scope the list to this workspace only.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    if (!workspace) {
      await askToChooseWorkspace(message.chat.id, user);

      return;
    }

    await sendTransactionsList(message.chat.id, user, workspace);
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

// Builds and sends today's summary for one workspace.
//
// Split out of the /summary command so the onboarding "See today's summary"
// button shows the real thing rather than a mock-up of it — the point of that
// step is to prove the entry they just made actually landed.
async function sendDailySummary(chatId, user, workspace) {
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
    chatId,
    `📊 ${workspaceLabel(workspace)} — Daily Summary

Date: ${summary.date}

${body}

Transactions: ${summary.transactionCount}`
  );
}

// Generates and sends today's financial summary.
bot.onText(/^\/summary$/, async (message) => {
  try {
    // Scope the summary to this workspace only.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    if (!workspace) {
      await askToChooseWorkspace(message.chat.id, user);

      return;
    }

    await sendDailySummary(message.chat.id, user, workspace);
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

// Builds and sends the khata — everyone who still owes this shopkeeper money.
//
// Split out of the /udhaar command so the onboarding tour can run the real
// thing from a button. The shop-only check stays INSIDE this function rather
// than in the command wrapper, so a forged `onb:udhaar` from a household user
// is refused at the same place the command refuses it.
async function sendUdhaarList(chatId, user, workspace) {
  // Udhaar is a khata, and only a shop keeps one.
  if (workspace.type !== "shopkeeper") {
    await bot.sendMessage(
      chatId,
      "📒 Udhaar is a shop feature. Switch to your shop with /workspace to see who owes you money."
    );

    return;
  }

  const customers = await getAllOutstanding(user.id);

  if (customers.length === 0) {
    // Says how a khata is created rather than only that there isn't one.
    // "Everyone has cleared their balance" reads as a mistake to a shopkeeper
    // who has never lent to anybody — which is exactly who taps this during
    // onboarding.
    await bot.sendMessage(
      chatId,
      `📒 Nobody owes you money right now.

When you record something like "Raj took goods for ₹2,000 on udhaar", Raj will appear here until he pays it back.`
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
    chatId,
    `📒 Udhaar Book

${list}

Total pending: ${money(total)}`
  );
}

// Shows every customer who still owes this shopkeeper money.
bot.onText(/^\/udhaar$/, async (message) => {
  try {
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    // A user with NO workspace gets the ledger question, like every other
    // command. Telling them to "switch to your shop" was a dead end: they do
    // not have a shop to switch to yet.
    if (!workspace) {
      await askToChooseWorkspace(message.chat.id, user);

      return;
    }

    await sendUdhaarList(message.chat.id, user, workspace);
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
  // Stickers, photos, voice notes and locations have no `text` at all. Without
  // this they fall straight past the command check below (`undefined?.` is
  // undefined, not true) and reach createMessage with a NULL message_text,
  // which the column rejects. A 👋 sticker is a very common first contact.
  if (!message.text) {
    return;
  }

  // Ignore Telegram commands.
  if (message.text.startsWith("/")) {
    return;
  }

  // Declared OUTSIDE the try block on purpose. `const` inside try{} is
  // block scoped and would be invisible to catch{}, so the FAILED status
  // could never be written.
  let savedMessage;

  // Set only while the sender is still onboarding, for the same scoping
  // reason: the catch below needs it to answer a beginner differently.
  let onboardingWorkspace;

  try {
    // Find or create the shopkeeper from Telegram information.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    // Without a workspace there is no ledger to write to. Ask before
    // spending an AI call on a message that has nowhere to go.
    if (!workspace) {
      await askToChooseWorkspace(message.chat.id, user);

      return;
    }

    if (isOnboarding(user)) {
      onboardingWorkspace = workspace;
    }

    // Save every incoming Telegram message permanently.
    savedMessage = await createMessage({
      user_id: user.id,
      workspace_id: workspace.id,
      telegram_message_id: message.message_id,
      message_text: message.text,
      status: "RECEIVED",
      // Stamped at arrival, not read back later: this is what marks the row
      // as practice data, and it is the key the cleanup deletes by.
      is_onboarding: isOnboarding(user),
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
      // Mid-tutorial this is almost always a greeting, not a real attempt at
      // bookkeeping. Repeating the practice prompt keeps a brand new user on
      // the rails; advice about /workspace means nothing to them yet.
      if (isOnboarding(user)) {
        await sendPracticePrompt(message.chat.id, workspace);
      } else {
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
      }

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

    // A beginner who typed "hii" during the tutorial gets the practice prompt
    // back, not an apology about a transaction they never tried to record.
    // The message is still marked FAILED above either way.
    if (onboardingWorkspace) {
      await sendPracticePrompt(message.chat.id, onboardingWorkspace);

      return;
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

    // Onboarding buttons carry a step name for the same reason, and are
    // whitelisted here so a forged payload can only ever be one of four.
    if (action === "onb" && ONBOARDING_STEPS.includes(messageId)) {
      await handleOnboardingAction(query, messageId);

      return;
    }

    const telegramMessageId = Number(messageId);

    // Set only when the shopkeeper answered the "what was this money for?"
    // question. null for a plain Confirm, which keeps the AI's own type.
    const typeOverride = CLARIFIED_TYPE[action] ?? null;

    // Get the shopkeeper who clicked the button. `workspace` is needed only
    // by the onboarding tour below, which picks its buttons from the ledger
    // type.
    const { user, workspace } = await resolveShopkeeper(
      query.from,
      query.message.chat
    );

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

        // ONBOARDING STEP 4. The user has now seen the full loop work, so
        // follow the saved entry with the way out of the tutorial. This
        // reappears after every confirm until they answer it, which is what
        // stops somebody living in onboarding for a week with all their real
        // entries flagged as practice.
        if (isOnboarding(user)) {
          await sendFeatureTour(
            query.message.chat.id,
            workspace,
            `🎉 That's the whole app — type it, tap Confirm.

Want to see what else I can do?`
          );
        }

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