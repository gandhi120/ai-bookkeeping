// The eight slash commands, and the report builders they share with the
// onboarding tour.
//
// Each send*() is split from its bot.onText() handler so the tour can run the
// REAL command against the user's own data rather than a mock-up of it.

import { getDailySummary } from "../services/summary.service.js";
import {
  getMonthlySummary,
  getMonthlySummaryAll,
} from "../services/monthly-summary.service.js";
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

  const summary = await getMonthlySummary(user.id, workspace.id, year, month);

  const tr = translator(user);

  await bot.sendMessage(
    chatId,
    `${tr("summary.monthlyTitle", { workspace: workspaceLabel(workspace) })}

${formatMonth(user.language, now)}

${summaryBody(user, summary, { categories: true })}

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

// THE MENU. Sent by /menu, by /start, by /help, and again at the end of
// onboarding — one screen with four buttons rather than four screens.
//
// It used to branch on the ledger so a household was never shown /udhaar.
// There is nothing left to branch on: every ledger does everything.
//
// The active ledger's NAME is inside the button label, not in a line of text
// above it. Somebody reading four buttons in Gujarati should be able to tap
// the right one without reading the message.
//
// Slash commands still work and are listed in the text — the buttons are for
// the majority who never learn them.
async function sendWelcomeHelp(chatId, user, workspace) {
  const tr = translator(user);

  await bot.sendMessage(
    chatId,
    tr("help.menu", { workspace: workspaceLabel(workspace) }),
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tr("menu.thisLedger", {
                workspace: workspaceLabel(workspace),
              }),
              callback_data: "menu:month",
            },
          ],
          [{ text: tr("menu.allLedgers"), callback_data: "menu:all" }],
          [{ text: tr("menu.switch"), callback_data: "menu:switch" }],
          [{ text: tr("menu.newLedger"), callback_data: "menu:new" }],
          [
            {
              text: tr("language.button", {
                label: LANGUAGES[user.language].label,
              }),
              callback_data: "lang:pick",
            },
          ],
        ],
      },
    }
  );
}


// This month, across every ledger the user keeps.
//
// The one report that deliberately crosses ledgers. A ledger with nothing in
// it this month is left out entirely rather than shown at zero — the point of
// this screen is the comparison, and empty rows are what make a comparison
// hard to read.
async function sendAllLedgersSummary(chatId, user) {
  const tr = translator(user);
  const now = new Date();

  const year = Number(
    now.toLocaleDateString("en-IN", { year: "numeric", timeZone: "Asia/Kolkata" })
  );

  const month = Number(
    now.toLocaleDateString("en-IN", { month: "numeric", timeZone: "Asia/Kolkata" })
  );

  const summary = await getMonthlySummaryAll(user.id, year, month);

  if (summary.ledgers.length === 0) {
    await bot.sendMessage(chatId, tr("menu.allEmpty"));

    return;
  }

  const blocks = summary.ledgers.map(
    (ledger) => `${ledger.emoji} ${ledger.name}
${tr("summary.moneyIn")} ${money(ledger.moneyIn)} · ${tr(
      "summary.moneyOut"
    )} ${money(ledger.moneyOut)}
${tr("summary.net")} ${money(ledger.net)}`
  );

  const footer = [`${tr("menu.everything")} ${money(summary.total.net)}`];

  if (summary.total.onUdhaar > 0) {
    footer.push(`${tr("summary.onUdhaar")} ${money(summary.total.onUdhaar)}`);
  }

  await bot.sendMessage(
    chatId,
    `${tr("menu.allTitle")}

${formatMonth(user.language, now)}

${blocks.join("\n\n")}
───────────────
${footer.join("\n")}`
  );
}


// The ledger switcher: one row per ledger, ✓ on the active one, and a way to
// make another. Shared by /workspace and the menu's Switch button.
async function sendWorkspaceSwitcher(chatId, user, workspace, workspaces) {
  const tr = translator(user);

  const rows = workspaces.map((existing) => [
    {
      text: `${workspaceLabel(existing)}${
        existing.id === workspace?.id ? "  ✓" : ""
      }`,
      callback_data: `ws:${existing.id}`,
    },
  ]);

  rows.push([{ text: tr("menu.newLedger"), callback_data: "menu:new" }]);

  // And the language row. This screen is the closest thing the bot has to
  // settings, so it is where somebody looks for the language — /language
  // works too, but nobody discovers a command they were never shown.
  rows.push([
    {
      text: tr("language.button", { label: LANGUAGES[user.language].label }),
      callback_data: "lang:pick",
    },
  ]);

  await bot.sendMessage(chatId, tr("ws.current"), {
    reply_markup: { inline_keyboard: rows },
  });
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
// /menu
// --------------------------------------------------

// The same screen /start sends, under the name people look for.
bot.onText(/^\/menu$/, async (message) => {
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

    await sendWorkspaceSwitcher(message.chat.id, user, workspace, workspaces);
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
  const summary = await getDailySummary(user.id, workspace.id, today());

  const tr = translator(user);

  await bot.sendMessage(
    chatId,
    `${tr("summary.dailyTitle", { workspace: workspaceLabel(workspace) })}

${tr("summary.date")} ${formatDate(user.language, summary.date)}

${summaryBody(user, summary)}

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

// Builds and sends the khata — everyone with an open balance, in either
// direction.
//
// Split out of the /udhaar command so the onboarding tour can run the real
// thing from a button.
//
// There used to be a shop-only check here, because a household had no
// customers. It is gone: the khata belongs to the USER, not to one ledger, and
// a household borrows from an uncle as readily as a shop lends to a regular.
// The list is user-wide for the same reason — Raj owes you, he does not owe
// your Kirana book.
async function sendUdhaarList(chatId, user, workspace) {
  const tr = translator(user);

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
  sendAllLedgersSummary,
  sendWorkspaceSwitcher,
  sendTransactionsList,
  sendUdhaarList,
  sendWelcomeHelp,
};
