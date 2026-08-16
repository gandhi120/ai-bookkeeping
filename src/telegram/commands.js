// The eight slash commands, and the report builders they share with the
// onboarding tour.
//
// Each send*() is split from its bot.onText() handler so the tour can run the
// REAL command against the user's own data rather than a mock-up of it.

import { getDailySummary } from "../services/summary.service.js";
import { getMonthlySummary } from "../services/monthly-summary.service.js";
import { getWorkspaces } from "../database/workspaces.js";
import { getTransactionsByDate } from "../database/transactions.js";
import { getAllOutstanding } from "../database/customers.js";
import {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  t,
  translator,
  enumLabel,
  formatDate,
  formatMonth,
} from "../i18n/index.js";
import {
  bot,
  resolveShopkeeper,
  WORKSPACE_KINDS,
  workspaceLabel,
  startSetup,
  askToChooseLanguage,
  isOnboarding,
  sendPracticePrompt,
  money,
  sendError,
  today,
} from "./core.js";
import { summaryBody } from "./cards.js";


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

  const tr = translator(user);

  await bot.sendMessage(
    chatId,
    `${tr("summary.monthlyTitle", { workspace: workspaceLabel(workspace) })}

${formatMonth(user.language, now)}

${summaryBody(user, workspace, summary, { categories: true })}

${tr("summary.count")} ${summary.transactionCount}`
  );
}


// Generates and sends the current month's financial summary.
bot.onText(/^\/monthly$/, async (message) => {
  // Resolved inside the try below, but the catch needs it too — a catch block
  // that reaches for `user` throws ReferenceError and kills the process.
  let language = DEFAULT_LANGUAGE;

  try {
    // Scope the summary to this workspace only.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    language = user.language ?? DEFAULT_LANGUAGE;

    if (!user.language || !workspace) {
      await startSetup(message.chat.id, user, workspace);

      return;
    }

    await sendMonthlySummary(message.chat.id, user, workspace);
  } catch (error) {
    console.error("Monthly summary error:", error);

    await sendError(message.chat.id, language, "error.monthly");
  }
});


// --------------------------------------------------
// /start
// --------------------------------------------------

// The "here is how to use me" screen, sent by /start, by /help, and again at
// the end of onboarding.
//
// It branches on the ledger: a household is never shown /udhaar, because a
// household has no customers. /help used to be a second, near-identical copy
// of this that showed the shop commands to everybody and patched it with a
// footnote — it now calls this instead, which is both shorter and correct.
async function sendWelcomeHelp(chatId, user, workspace) {
  const tr = translator(user);

  await bot.sendMessage(
    chatId,
    tr(workspace.type === "household" ? "help.home" : "help.shop", {
      workspace: workspaceLabel(workspace),
    })
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

  if (!user.language || !workspace) {
    await startSetup(message.chat.id, user, workspace);

    return;
  }

  if (isOnboarding(user)) {
    await sendPracticePrompt(message.chat.id, user, workspace);

    return;
  }

  await sendWelcomeHelp(message.chat.id, user, workspace);
});


// --------------------------------------------------
// /workspace
// --------------------------------------------------

// Shows which ledger is active and offers to switch or create the other one.
bot.onText(/^\/workspace$/, async (message) => {
  // Resolved inside the try below, but the catch needs it too — a catch block
  // that reaches for `user` throws ReferenceError and kills the process.
  let language = DEFAULT_LANGUAGE;

  try {
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    language = user.language ?? DEFAULT_LANGUAGE;

    const workspaces = await getWorkspaces(user.id);

    if (!user.language || workspaces.length === 0) {
      await startSetup(message.chat.id, user, workspaces[0]);

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

    const tr = translator(user);

    // Then an "+ Add ..." button for whichever kind they don't have yet.
    for (const [type, kind] of Object.entries(WORKSPACE_KINDS)) {
      if (!workspaces.some((existing) => existing.type === type)) {
        rows.push([
          {
            text: tr("ws.add", { label: tr(kind.labelKey) }),
            callback_data: `addws:${type}`,
          },
        ]);
      }
    }

    // And the language row. This screen is the closest thing the bot has to
    // settings, so it is where somebody looks for the language — /language
    // works too, but nobody discovers a command they were never shown.
    rows.push([
      {
        text: tr("language.button", {
          label: LANGUAGES[user.language].label,
        }),
        callback_data: "lang:pick",
      },
    ]);

    await bot.sendMessage(message.chat.id, tr("ws.current"), {
      reply_markup: { inline_keyboard: rows },
    });
  } catch (error) {
    console.error("Workspace error:", error);

    await sendError(message.chat.id, language, "error.workspaces");
  }
});


// --------------------------------------------------
// /language
// --------------------------------------------------

// Reopens the language picker.
//
// Deliberately has no workspace gate — language is asked before the ledger,
// so a user still in setup must be able to correct a mistap here, and an
// existing user backfilled to English needs a way in that does not depend on
// having finished anything.
bot.onText(/^\/language$/, async (message) => {
  // Resolved inside the try below, but the catch needs it too — a catch block
  // that reaches for `user` throws ReferenceError and kills the process.
  let language = DEFAULT_LANGUAGE;

  try {
    const { user } = await resolveShopkeeper(message.from, message.chat);

    language = user.language ?? DEFAULT_LANGUAGE;

    await askToChooseLanguage(message.chat.id, user);
  } catch (error) {
    console.error("Language error:", error);

    await sendError(message.chat.id, language, "error.language");
  }
});


// --------------------------------------------------
// /help
// --------------------------------------------------

// Sends the usage examples and the command list.
//
// This used to be its own ~35-line block that showed the shop commands to
// everybody and patched it with a "🏠 in your household workspace…" footnote.
// It is now the same screen /start sends, which already branches on the
// ledger — so a household user no longer sees /udhaar at all.
//
// Checks for a workspace like every other command: a brand new user handed a
// list of commands for a ledger that does not exist yet has been shown the
// menu of a restaurant they have not walked into.
bot.onText(/^\/help$/, async (message) => {
  const { user, workspace } = await resolveShopkeeper(
    message.from,
    message.chat
  );

  if (!user.language || !workspace) {
    await startSetup(message.chat.id, user, workspace);

    return;
  }

  await sendWelcomeHelp(message.chat.id, user, workspace);
});


// --------------------------------------------------
// /transactions
// --------------------------------------------------

// Builds and sends today's entry list for one workspace.
//
// Split out of the /transactions command so the onboarding tour can run the
// real thing from a button. Assumes a workspace exists.
async function sendTransactionsList(chatId, user, workspace) {
  const tr = translator(user);

  // `date` is the machine format the query needs; the user is always shown
  // formatDate() of it.
  const date = today();

  const transactions = await getTransactionsByDate(user.id, workspace.id, date);

  if (transactions.length === 0) {
    await bot.sendMessage(
      chatId,
      tr("list.empty", {
        date: formatDate(user.language, date),
        workspace: workspaceLabel(workspace),
      })
    );

    return;
  }

  // The category row is gone for the same reason it left the confirmation
  // card: it repeated the description and could not be acted on. The type is
  // now a word rather than a shouted database identifier.
  const transactionList = transactions
    .map(
      (transaction, index) =>
        `${index + 1}. ${enumLabel(
          user.language,
          "type",
          transaction.transaction_type
        )}
${transaction.description} — ${money(transaction.amount)}${
          transaction.person
            ? `\n${tr("list.customer")} ${transaction.person}`
            : ""
        }`
    )
    .join("\n\n");

  await bot.sendMessage(
    chatId,
    `${tr("list.title", { workspace: workspaceLabel(workspace) })}

${tr("summary.date")} ${formatDate(user.language, date)}

${transactionList}`
  );
}


// Fetches and displays today's transactions for the user.
bot.onText(/^\/transactions$/, async (message) => {
  // Resolved inside the try below, but the catch needs it too — a catch block
  // that reaches for `user` throws ReferenceError and kills the process.
  let language = DEFAULT_LANGUAGE;

  try {
    // Scope the list to this workspace only.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    language = user.language ?? DEFAULT_LANGUAGE;

    if (!user.language || !workspace) {
      await startSetup(message.chat.id, user, workspace);

      return;
    }

    await sendTransactionsList(message.chat.id, user, workspace);
  } catch (error) {
    console.error("Transactions error:", error);

    await sendError(message.chat.id, language, "error.transactions");
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

  const tr = translator(user);

  await bot.sendMessage(
    chatId,
    `${tr("summary.dailyTitle", { workspace: workspaceLabel(workspace) })}

${tr("summary.date")} ${formatDate(user.language, summary.date)}

${summaryBody(user, workspace, summary)}

${tr("summary.count")} ${summary.transactionCount}`
  );
}


// Generates and sends today's financial summary.
bot.onText(/^\/summary$/, async (message) => {
  // Resolved inside the try below, but the catch needs it too — a catch block
  // that reaches for `user` throws ReferenceError and kills the process.
  let language = DEFAULT_LANGUAGE;

  try {
    // Scope the summary to this workspace only.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    language = user.language ?? DEFAULT_LANGUAGE;

    if (!user.language || !workspace) {
      await startSetup(message.chat.id, user, workspace);

      return;
    }

    await sendDailySummary(message.chat.id, user, workspace);
  } catch (error) {
    console.error("Summary error:", error);

    await sendError(message.chat.id, language, "error.summary");
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
  const tr = translator(user);

  // Udhaar is a khata, and only a shop keeps one.
  if (workspace.type !== "shopkeeper") {
    await bot.sendMessage(chatId, tr("udhaar.wrongLedger"));

    return;
  }

  const customers = await getAllOutstanding(user.id);

  if (customers.length === 0) {
    // Says how a khata is created rather than only that there isn't one.
    // "Everyone has cleared their balance" reads as a mistake to a shopkeeper
    // who has never lent to anybody — which is exactly who taps this during
    // onboarding.
    await bot.sendMessage(chatId, tr("udhaar.empty"));

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
    `${tr("udhaar.title")}

${list}

${tr("udhaar.total")} ${money(total)}`
  );
}


// Shows every customer who still owes this shopkeeper money.
bot.onText(/^\/udhaar$/, async (message) => {
  // Resolved inside the try below, but the catch needs it too — a catch block
  // that reaches for `user` throws ReferenceError and kills the process.
  let language = DEFAULT_LANGUAGE;

  try {
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    language = user.language ?? DEFAULT_LANGUAGE;

    // A user with NO workspace gets the ledger question, like every other
    // command. Telling them to "switch to your shop" was a dead end: they do
    // not have a shop to switch to yet.
    if (!user.language || !workspace) {
      await startSetup(message.chat.id, user, workspace);

      return;
    }

    await sendUdhaarList(message.chat.id, user, workspace);
  } catch (error) {
    console.error("Udhaar list error:", error);

    await sendError(message.chat.id, language, "error.udhaar");
  }
});

export {
  sendDailySummary,
  sendMonthlySummary,
  sendTransactionsList,
  sendUdhaarList,
  sendWelcomeHelp,
};
