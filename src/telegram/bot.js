import TelegramBot from "node-telegram-bot-api";
import { pathToFileURL } from "node:url";
import "dotenv/config";

import { processMessage, MAX_ENTRIES } from "../services/transaction.service.js";
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
  setUserLanguage,
  pool,
} from "../database/postgres.js";

import { getMonthlySummary } from "../services/monthly-summary.service.js";

import {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  isLanguage,
  t,
  translator,
  enumLabel,
  formatDate,
  formatMonth,
} from "../i18n/index.js";

// True only when this file is the process entry point. Importing it — from a
// test, or from server.js if HTTP is ever added back — then defines the
// handlers and helpers without connecting to Telegram. Nothing below reaches
// the network until `start()` runs at the bottom.
const isEntryPoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const token = process.env.TELEGRAM_BOT_TOKEN;

// WEBHOOK_URL is the public https origin this bot is reachable at
// (e.g. https://ai-bookkeeping.up.railway.app). Setting it is what picks the
// transport: present means webhook, absent means polling. Production sets it,
// a laptop does not, so local development keeps working with no extra tooling.
const webhookUrl = process.env.WEBHOOK_URL;

// The URL path carries the bot token, which is what authenticates Telegram to
// us: the library answers 401 to any request whose path does not contain it.
// This is Telegram's own recommendation — the token is unguessable, and the
// path is only ever seen by Telegram over TLS.
const webhookPath = `/bot${token}`;

// Creates a Telegram bot instance.
//
// polling: our Node.js app continuously asks Telegram for new messages.
// Needs no public URL, so it works from a laptop, but it needs a process that
// stays alive and only one may run per bot token.
//
// webHook: Telegram POSTs each update to us instead. The library runs its own
// plain-HTTP server — the host (Railway/Render/Fly) terminates TLS in front of
// it — and calls the same handlers below. PORT is injected by the host.
//
// Neither transport is started here — `autoOpen: false` and `polling: false`
// keep the constructor off the network, so importing this file is free. The
// bottom of the file starts whichever one is configured.
export const bot = new TelegramBot(
  token,
  webhookUrl
    ? {
        webHook: {
          port: Number(process.env.PORT) || 8443,
          // Answers 200 without a token, so the host's health check passes.
          healthEndpoint: "/healthz",
          autoOpen: false,
        },
      }
    : { polling: false }
);

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
//
// `nameKey` is only the default name at creation — nothing looks a workspace
// up by it, which is what makes translating it safe: the name is stored on
// the row, so an existing ledger keeps whatever it was called and only new
// ones are created in the user's language.
const WORKSPACE_KINDS = {
  shopkeeper: {
    icon: "🏪",
    nameKey: "workspace.nameShop",
    labelKey: "ws.labelShop",
  },
  household: {
    icon: "🏠",
    nameKey: "workspace.nameHome",
    labelKey: "ws.labelHome",
  },
};

// "🏪 My Shop" — how a workspace is named everywhere in the UI.
function workspaceLabel(workspace) {
  return `${WORKSPACE_KINDS[workspace.type].icon} ${workspace.name}`;
}

// THE GATE. Sent whenever a handler needs a set-up user and gets one who is
// not set up yet.
//
// Setup is two questions — language, then ledger — and this decides which one
// the user is owed. Every command and every free-text message routes here
// until both are answered, which is what makes setup unskippable, and it is
// why this is called from eight places rather than only from /start: most
// people never type /start, they just say "hii".
//
// One function rather than two checks at each call site, so adding a third
// setup question later is a change here and nowhere else.
async function startSetup(chatId, user, workspace) {
  if (!user.language) {
    await askToChooseLanguage(chatId, user);

    return;
  }

  if (!workspace) {
    await askToChooseWorkspace(chatId, user);
  }
}

// SETUP STEP 1 — the language.
//
// Asked before anything else, because every other word the bot says depends
// on the answer. This is the one message that cannot be translated — we do
// not know the language yet — so it carries all three at once and leans on
// the buttons, which are each written in their own script: somebody who
// cannot read a word of English still recognises "ગુજરાતી".
//
// Also reachable later from /language and from the 🌐 row on /workspace. When
// a user already has a language, theirs is marked so the picker shows the
// current setting rather than looking like a fresh question.
async function askToChooseLanguage(chatId, user) {
  const buttons = Object.entries(LANGUAGES).map(([code, { label }]) => ({
    text: user?.language === code ? `${label} ✓` : label,
    callback_data: `lang:${code}`,
  }));

  await bot.sendMessage(
    chatId,
    `🌐 Choose your language
भाषा चुनें  ·  ભાષા પસંદ કરો`,
    {
      // One row: three short labels fit side by side on any phone, and a
      // single row reads as one question rather than three options to weigh.
      reply_markup: { inline_keyboard: [buttons] },
    }
  );
}

// SETUP STEP 2 — the ledger.
//
// No workspace means no ledger, so nothing else in the bot can run until this
// is answered.
//
// It greets and explains before it asks. A first-time user who typed "hii"
// has no idea what this bot is, and being handed two bare buttons is where
// they quit. The options are labelled by what the user gets, not by the word
// "workspace", which no shopkeeper thinks in.
async function askToChooseWorkspace(chatId, user) {
  const tr = translator(user);

  // first_name is optional on Telegram accounts, so fall back to a nameless
  // greeting rather than "Hi undefined".
  const greeting = user?.first_name
    ? tr("setup.greeting", { name: user.first_name })
    : tr("setup.greetingAnon");

  await bot.sendMessage(chatId, tr("setup.welcome", { greeting }), {
    reply_markup: {
      inline_keyboard: [
        [{ text: tr("setup.shopButton"), callback_data: "addws:shopkeeper" }],
        [{ text: tr("setup.homeButton"), callback_data: "addws:household" }],
      ],
    },
  });
}

// Handles every lang:* button.
//
// `lang:pick` reopens the picker (the 🌐 row on /workspace); `lang:<code>`
// sets the language. Callback data comes from the user's Telegram client, so
// the code is checked here and again in setUserLanguage — a forged `lang:xx`
// can never reach the database.
async function handleLanguageAction(query, code) {
  const chatId = query.message.chat.id;

  const { user, workspace } = await resolveShopkeeper(
    query.from,
    query.message.chat
  );

  if (code === "pick") {
    await bot.answerCallbackQuery(query.id);

    await askToChooseLanguage(chatId, user);

    return;
  }

  if (!isLanguage(code)) {
    await bot.answerCallbackQuery(query.id, { text: translator(user)("toast.unknownLanguage") });

    return;
  }

  await setUserLanguage(user.id, code);

  await bot.answerCallbackQuery(query.id);

  // `user` was read before the update, so everything below has to be told the
  // new language explicitly — otherwise the very message confirming the
  // change would still be written in the language they just left.
  const updated = { ...user, language: code };

  // A user still in setup carries straight on to the ledger question. One
  // changing their language later just gets confirmation — same tap, same
  // function, the only difference is what comes next.
  if (!workspace) {
    await askToChooseWorkspace(chatId, updated);

    return;
  }

  await bot.sendMessage(chatId, translator(updated)("language.changed"));
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

// Which catalog key holds the practice example for each ledger type.
// A purchase for the shop and a grocery expense for the home: both are the
// most ordinary entry that ledger will ever see, so the example is one they
// will actually repeat tomorrow — which is also why it is translated rather
// than shown in English for a user to copy in a script they do not read.
const PRACTICE_EXAMPLE_KEY = {
  shopkeeper: "practice.exampleShop",
  household: "practice.exampleHome",
};

// ONBOARDING STEP 3 — asks the user to type their first real transaction.
//
// Carries a skip button, because nobody should be held in a tutorial they did
// not ask for. Skip points at `onb:finish` — the same step the Finish button
// uses — so skipping is not a separate path with its own rules: it ends
// onboarding, and still offers to clear anything already recorded.
async function sendPracticePrompt(chatId, user, workspace) {
  const tr = translator(user);

  await bot.sendMessage(
    chatId,
    tr("practice.prompt", { example: tr(PRACTICE_EXAMPLE_KEY[workspace.type]) }),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: tr("practice.skip"), callback_data: "onb:finish" }],
        ],
      },
    }
  );
}

// Formats a number as Indian rupees, e.g. 50000 -> "₹50,000".
function money(value) {
  return `₹${Number(value).toLocaleString("en-IN")}`;
}

// Apologises to the user in their own language after a handler has failed.
//
// Takes a LANGUAGE, not a user, and that is the whole point: `user` is
// resolved inside the try block, so a catch block referencing it throws
// ReferenceError and takes the process down with it — an apology that crashes
// the bot is worse than no apology. Callers hoist a `language` variable above
// their try and assign it once the user is known.
//
// Wrapped in its own try because this runs while something is already broken,
// and that something is often the database or Telegram itself.
async function sendError(chatId, language, key) {
  try {
    await bot.sendMessage(chatId, t(language ?? DEFAULT_LANGUAGE, key));
  } catch (error) {
    console.error("Could not send the error message:", error);
  }
}

// Returns today's date as YYYY-MM-DD in the shop's timezone.
// "en-CA" is used because that locale formats dates as YYYY-MM-DD,
// which is exactly what PostgreSQL expects for a ::date cast.
//
// This is a MACHINE format. Never send it to the user — use formatDate()
// from the i18n module, which gives "16 ઑગસ્ટ 2026" in their language.
function today() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
}

// The body of the confirmation card, and of the "saved" card after Confirm.
// Both show the same three rows so tapping Confirm does not reshuffle what
// the user is looking at.
//
//     ખરીદી: 10 કિલો ચોખા
//     રકમ: ₹600
//     તારીખ: 16 ઑગસ્ટ 2026
//
// The transaction TYPE is the first row's LABEL rather than a value. That is
// what collapsed the old six rows into three: "Type: expense" and
// "Description: groceries" were saying the same thing twice, once as a raw
// database identifier and once in the user's language.
//
// Category is deliberately absent. It cannot be corrected from this card, it
// only feeds the /monthly breakdown, and it was the row duplicating the
// description.
function transactionCard(user, transaction) {
  const tr = translator(user);
  const language = user?.language ?? "en";

  // For a khata entry the customer IS what the shopkeeper is confirming;
  // for everything else it is the thing bought or sold.
  const what = isCustomerTransaction(transaction.transaction_type)
    ? transaction.person
    : transaction.description;

  const rows = [
    `${enumLabel(language, "type", transaction.transaction_type)}: ${what}`,
  ];

  // A quantity of 1 is every ordinary entry, so printing it said nothing and
  // read as a second amount sitting above the real one.
  if (Number(transaction.quantity) > 1) {
    rows.push(`${tr("confirm.quantity")} ${transaction.quantity}`);
  }

  rows.push(`${tr("confirm.amount")} ${money(transaction.amount)}`);

  if (transaction.transaction_date) {
    rows.push(
      `${tr("confirm.date")} ${formatDate(language, transaction.transaction_date)}`
    );
  }

  return rows.join("\n");
}

// The body of the card when ONE message recorded several entries.
//
// One line each rather than N stacked cards, because the entries were typed
// as one thought ("400 nu dudh, 300 no sabu") and are confirmed as one. The
// total is what makes a single tap safe to give: it is the number the user
// checks before agreeing to all of them.
function transactionListCard(user, transactions) {
  const tr = translator(user);
  const language = user?.language ?? DEFAULT_LANGUAGE;

  const dates = new Set(transactions.map((t) => t.transaction_date));

  // Normally every entry in a message is the same day, so the date is stated
  // once at the bottom. It only moves onto each line when they genuinely
  // differ — a shared date line would be a quiet lie about half the rows.
  const sameDay = dates.size === 1;

  const lines = transactions.map((transaction) => {
    const what = isCustomerTransaction(transaction.transaction_type)
      ? transaction.person
      : transaction.description;

    const when = sameDay
      ? ""
      : `  ${formatDate(language, transaction.transaction_date, { year: false })}`;

    return `${enumLabel(language, "type", transaction.transaction_type)}: ${what} — ${money(
      transaction.amount
    )}${when}`;
  });

  const total = transactions.reduce(
    (sum, transaction) => sum + Number(transaction.amount),
    0
  );

  const footer = [`${tr("confirm.total")} ${money(total)}`];

  if (sameDay) {
    footer.push(
      `${tr("confirm.date")} ${formatDate(language, transactions[0].transaction_date)}`
    );
  }

  return `${lines.join("\n")}\n───────────────\n${footer.join("\n")}`;
}

// What the message could not record, and why — appended under the card.
//
// Never silent. Somebody who types five things and gets four back must be
// told which one is missing now, not discover it in next month's summary.
function skippedNotes(user, skipped) {
  const tr = translator(user);

  return Object.entries(skipped ?? {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) =>
      tr(`skipped.${reason}`, { count, max: MAX_ENTRIES })
    )
    .join("\n");
}

// The money rows shared by /summary and /monthly.
//
// A household reports income against expenses and where the money went; a
// shop reports sales against purchases. Different questions, so this is two
// layouts rather than one with some rows blanked out.
//
// `categories` is off for the daily view: a single day's spending broken down
// by category is usually one line repeating what is already on screen.
function summaryBody(user, workspace, summary, { categories = false } = {}) {
  const tr = translator(user);

  if (workspace.type !== "household") {
    return `${tr("summary.sales")} ${money(summary.totalSales)}
${tr("summary.purchases")} ${money(summary.totalPurchases)}
${tr("summary.expenses")} ${money(summary.totalExpenses)}
${tr("summary.netBalance")} ${money(summary.netBalance)}`;
  }

  const rows = `${tr("summary.income")} ${money(summary.totalIncome)}
${tr("summary.expenses")} ${money(summary.totalExpenses)}
${tr("summary.balance")} ${money(summary.balance)}`;

  if (!categories || summary.byCategory.length === 0) return rows;

  // byCategory carries the raw database strings, and `category` is a free
  // z.string() — so enumLabel falls back to whatever the AI wrote rather than
  // printing a missing key.
  const breakdown = summary.byCategory
    .map(
      (row) =>
        `${enumLabel(user.language, "cat", row.category)} — ${money(row.total)}`
    )
    .join("\n");

  return `${rows}\n\n${tr("summary.whereItWent")}\n${breakdown}`;
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

  const tr = translator(user);

  let workspace;

  if (action === "addws") {
    const kind = WORKSPACE_KINDS[value];

    if (!kind) {
      await bot.answerCallbackQuery(query.id, { text: tr("toast.unknownWorkspace") });

      return;
    }

    workspace = await createWorkspace(user.id, tr(kind.nameKey), value);
    await setActiveWorkspace(user.id, workspace.id);
  } else {
    // A forged or stale uuid updates nothing and returns undefined.
    const updated = await setActiveWorkspace(user.id, value);

    if (!updated) {
      await bot.answerCallbackQuery(query.id, { text: tr("toast.workspaceNotFound") });

      return;
    }

    workspace = await getActiveWorkspace(user.id);
  }

  await bot.answerCallbackQuery(query.id, {
    text: tr("workspace.switched", { workspace: workspace.name }),
  });

  await bot.editMessageText(
    tr("workspace.nowUsing", { workspace: workspaceLabel(workspace) }),
    {
      chat_id: chatId,
      message_id: query.message.message_id,
    }
  );

  // ONBOARDING STEP 3. A first-time user has just answered the only question
  // the bot cannot work without, so instead of a one-line hint they get walked
  // through recording something. Somebody adding a SECOND workspace later is
  // not new and keeps the short hint.
  if (isOnboarding(user)) {
    await bot.sendMessage(
      chatId,
      tr("workspace.ready", { workspace: workspaceLabel(workspace) })
    );

    await sendPracticePrompt(chatId, user, workspace);

    return;
  }

  await bot.sendMessage(
    chatId,
    workspace.type === "household"
      ? tr("ws.hintHome")
      : tr("ws.hintShop")
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
//
// `label` is a catalog key rather than the text itself, so the button and the
// screen it opens can be translated independently — which matters right now,
// because the buttons are translated and the reports behind them are not yet.
const TOUR = {
  summary: { label: "tour.summary", run: sendDailySummary },
  monthly: { label: "tour.monthly", run: sendMonthlySummary },
  transactions: { label: "tour.transactions", run: sendTransactionsList },
  udhaar: { label: "tour.udhaar", run: sendUdhaarList },
};

// ONBOARDING STEP 4/5 — the feature tour.
//
// Buttons rather than steps. Everything here is optional, so a user who wants
// out taps Finish once and a user who is curious sees every feature run
// against their own data in about ten seconds. That is what keeps "takes 30
// seconds" honest while still covering the whole product.
async function sendFeatureTour(chatId, user, workspace, introKey) {
  const tr = translator(user);

  const featureRows = featuresForWorkspace(workspace.type).map((feature) => [
    { text: tr(TOUR[feature].label), callback_data: `onb:${feature}` },
  ]);

  await bot.sendMessage(chatId, tr(introKey), {
    reply_markup: {
      inline_keyboard: [
        ...featureRows,
        [{ text: tr("tour.finish"), callback_data: "onb:finish" }],
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
//
// The count stands alone in the sentence ("Practice entries: 3") rather than
// being pluralised into it. English needs entry/entries, Hindi and Gujarati
// do not pluralise the same way, and a number on its own reads naturally in
// all three — so there is no plural function to write or get wrong.
async function askToClearPracticeData(chatId, user, count) {
  const tr = translator(user);

  await bot.sendMessage(chatId, tr("clear.prompt", { count }), {
    reply_markup: {
      inline_keyboard: [
        [{ text: tr("clear.button"), callback_data: "onb:clear" }],
        [{ text: tr("keep.button"), callback_data: "onb:keep" }],
      ],
    },
  });
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

  const tr = translator(user);

  // Onboarding is already over — the buttons are on an old message someone
  // scrolled back to. Say so rather than clearing anything.
  if (!isOnboarding(user)) {
    await bot.answerCallbackQuery(query.id, {
      text: tr("toast.setupAlreadyDone"),
    });

    return;
  }

  // A tour button: run the real command against their own data, then offer
  // the card again so trying a second feature is one tap, not a hunt.
  if (TOUR[step]) {
    await bot.answerCallbackQuery(query.id);

    await TOUR[step].run(chatId, user, workspace);

    await sendFeatureTour(chatId, user, workspace, "tour.more");

    return;
  }

  if (step === "finish") {
    await bot.answerCallbackQuery(query.id);

    const count = await countOnboardingTransactions(user.id);

    // Nothing was ever recorded, so there is nothing to ask about. Close
    // onboarding straight away rather than asking to clear zero rows.
    if (count === 0) {
      await finishOnboarding(user.id, { clear: false });

      await bot.sendMessage(chatId, tr("finish.done"));

      await sendWelcomeHelp(chatId, user, workspace);

      return;
    }

    await askToClearPracticeData(chatId, user, count);

    return;
  }

  // Only `clear` and `keep` remain, and both end onboarding. Anything else
  // never reaches here — the caller's whitelist decides what gets this far.
  const clear = step === "clear";

  const result = await finishOnboarding(user.id, { clear });

  await bot.answerCallbackQuery(query.id, {
    text: clear ? tr("toast.cleared") : tr("toast.setupComplete"),
  });

  await bot.editMessageText(
    clear
      ? tr("finish.cleared", { count: result.transactions })
      : tr("finish.kept"),
    {
      chat_id: chatId,
      message_id: query.message.message_id,
    }
  );

  await sendWelcomeHelp(chatId, user, workspace);
}

// Why nothing in a message could be recorded, and what to say about it.
//
// A table rather than a ternary chain because processMessage grew a fourth
// reason the moment one message could hold several entries, and a chain is
// where the fifth one gets missed. `?? "error.transaction"` is the fallback,
// so an unmapped reason apologises rather than printing a key.
const UNSUPPORTED_KEY = {
  CUSTOMER_QUERY_OUTSIDE_SHOP: "error.customerQueryAtHome",
  TYPE_NOT_IN_WORKSPACE: "error.typeNotInWorkspace",
  NO_AMOUNT: "error.noAmount",
  NOT_UNDERSTOOD: "error.transaction",
};

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

// --------------------------------------------------
// Customer question helpers
// --------------------------------------------------

// Answers "How much does Raj owe me?".
// Read-only: nothing is created, so this never enters the confirmation flow.
async function answerBalanceQuery(chatId, user, personName) {
  const tr = translator(user);

  const customer = await getCustomerByName(user.id, personName);

  // The shopkeeper has no such customer. Say so instead of showing ₹0,
  // which would look like a cleared balance.
  if (!customer) {
    await bot.sendMessage(chatId, tr("khata.noCustomer", { person: personName }));

    return;
  }

  const balance = await getCustomerBalance(user.id, customer.id);

  if (balance === 0) {
    await bot.sendMessage(chatId, tr("khata.cleared", { person: customer.name }));

    return;
  }

  // A negative balance means the customer paid more than they owed,
  // so the shopkeeper is holding advance money for them.
  if (balance < 0) {
    await bot.sendMessage(
      chatId,
      tr("khata.paidAdvance", {
        person: customer.name,
        amount: money(Math.abs(balance)),
      })
    );

    return;
  }

  await bot.sendMessage(
    chatId,
    tr("khata.owesYou", { person: customer.name, amount: money(balance) })
  );
}

// Answers "Show Raj's transactions" with that customer's udhaar entries.
async function answerHistoryQuery(chatId, user, personName) {
  const tr = translator(user);

  const customer = await getCustomerByName(user.id, personName);

  if (!customer) {
    await bot.sendMessage(chatId, tr("khata.noCustomer", { person: personName }));

    return;
  }

  const transactions = await getCustomerTransactions(user.id, customer.id);

  if (transactions.length === 0) {
    await bot.sendMessage(chatId, tr("khata.noEntries", { person: customer.name }));

    return;
  }

  const balance = await getCustomerBalance(user.id, customer.id);

  const list = transactions
    .map((transaction) => {
      // Show the direction of each entry so the running total makes sense.
      const sign =
        transaction.transaction_type === "credit_sale" ? "＋" : "－";

      // No year: every row is the same khata and the year is noise.
      const date = formatDate(user.language, transaction.transaction_date, {
        year: false,
      });

      return `${sign} ${money(transaction.amount)}  ${date}
   ${transaction.description}`;
    })
    .join("\n");

  await bot.sendMessage(
    chatId,
    `${tr("khata.title", { person: customer.name })}

${list}

${tr("khata.outstanding")} ${money(balance)}`
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
// `index` names WHICH entry is being asked about when one message recorded
// several. null for a single-entry message, which keeps that callback data
// byte-identical to what it has always been — and keeps its one-tap
// confirm-and-save behaviour, see the callback handler.
async function askPaymentClarification(
  chatId,
  user,
  transaction,
  telegramMessageId,
  index = null
) {
  const tr = translator(user);

  const suffix = index === null ? "" : `:${index}`;

  const customer = await getCustomerByName(user.id, transaction.person);

  // A customer with no khata yet still gets the question: the shopkeeper may
  // have given the udhaar verbally before ever recording it here.
  const khataLine = customer
    ? tr("clarify.owes", {
        person: transaction.person,
        amount: money(await getCustomerBalance(user.id, customer.id)),
      })
    : tr("clarify.noUdhaar", { person: transaction.person });

  await bot.sendMessage(
    chatId,
    `${tr("confirm.title")}

${tr("confirm.amount")} ${money(transaction.amount)}
${tr("confirm.from")} ${transaction.person}
${tr("confirm.description")} ${transaction.description}
${tr("confirm.date")} ${formatDate(
      user?.language ?? DEFAULT_LANGUAGE,
      transaction.transaction_date
    )}

${khataLine}

${tr("clarify.question", { person: transaction.person })}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tr("clarify.repayment"),
              callback_data: `repayment:${telegramMessageId}${suffix}`,
            },
            {
              text: tr("clarify.normal"),
              callback_data: `income:${telegramMessageId}${suffix}`,
            },
          ],
          [
            {
              text: tr("confirm.no"),
              callback_data: `cancel:${telegramMessageId}`,
            },
          ],
        ],
      },
    }
  );
}

// The step between "the AI understood you" and "waiting for a yes".
//
// It either asks the next unanswered clarification question or shows the
// confirm card. Both the message handler and the clarification callback call
// it, which is what lets a multi-entry message ask about entry 2 after entry
// 0 has been answered without either side owning the state machine.
async function askToConfirm(
  chatId,
  user,
  transactions,
  skipped,
  telegramMessageId
) {
  const tr = translator(user);

  // Money from a named person with no stated reason moves a khata balance if
  // guessed wrong, so it is asked about before anything can be saved.
  const unanswered = transactions.findIndex(needsPaymentClarification);

  if (unanswered !== -1) {
    await askPaymentClarification(
      chatId,
      user,
      transactions[unanswered],
      telegramMessageId,
      // A single-entry message needs no index: its callback data, and its
      // one-tap behaviour, stay exactly as they were.
      transactions.length > 1 ? unanswered : null
    );

    return;
  }

  const multi = transactions.length > 1;

  // For udhaar entries, show what the customer owes right now so the
  // shopkeeper sees the before/after before committing to it.
  const khataLines = [];

  for (const transaction of transactions) {
    if (
      !isCustomerTransaction(transaction.transaction_type) ||
      !transaction.person
    ) {
      continue;
    }

    const customer = await getCustomerByName(user.id, transaction.person);
    const current = customer ? await getCustomerBalance(user.id, customer.id) : 0;

    const after =
      transaction.transaction_type === "credit_sale"
        ? current + Number(transaction.amount)
        : current - Number(transaction.amount);

    khataLines.push(
      tr("confirm.khataChange", {
        person: transaction.person,
        before: money(current),
        after: money(after),
      })
    );
  }

  const parts = [
    multi
      ? tr("confirm.titleMulti", { count: transactions.length })
      : tr("confirm.title"),
    "",
    multi
      ? transactionListCard(user, transactions)
      : transactionCard(user, transactions[0]),
  ];

  if (khataLines.length > 0) parts.push("", khataLines.join("\n"));

  const notes = skippedNotes(user, skipped);

  if (notes) parts.push("", notes);

  await bot.sendMessage(chatId, parts.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: tr("confirm.yes"),
            callback_data: `confirm:${telegramMessageId}`,
          },
          {
            text: tr("confirm.no"),
            callback_data: `cancel:${telegramMessageId}`,
          },
        ],
      ],
    },
  });
}

// --------------------------------------------------
// Normal transaction messages
// --------------------------------------------------

// --------------------------------------------------
// Flood guard
// --------------------------------------------------

// The AI budget is shared across every user and resets daily, so one person
// pasting a hundred lines does not cost them anything — it takes the whole
// shop down until tomorrow. This limit protects the other users, which is why
// it sits in front of the AI call rather than in front of the database.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

const rateCounters = new Map();

// Returns 0 while the sender is within the limit, otherwise how many messages
// past it this one is. The caller replies only on 1 — the message that crosses
// — so a flood earns one warning instead of a hundred. `now` is a parameter so
// the window can be tested without waiting a real minute.
export function overRateLimit(telegramUserId, now = Date.now()) {
  const entry = rateCounters.get(telegramUserId);

  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    // ponytail: unbounded Map, one entry per user ever seen. Dropped wholesale
    // past 10k — the worst case is that 10k people get a fresh window at the
    // same moment. Swap for a TTL cache if that ever churns for real.
    if (rateCounters.size > 10_000) {
      rateCounters.clear();
    }

    rateCounters.set(telegramUserId, { start: now, count: 1 });

    return 0;
  }

  entry.count += 1;

  return entry.count > RATE_LIMIT ? entry.count - RATE_LIMIT : 0;
}

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

  // Below the commands on purpose: only free text reaches the AI, and the AI
  // is the budget being protected. Commands are pure database reads.
  const over = overRateLimit(message.from.id);

  if (over) {
    if (over === 1) {
      // Only the message that CROSSES the limit gets a reply, so this costs
      // one query per flood, not one per message — cheap enough to answer a
      // flooding user in their own language rather than in English.
      const { user } = await resolveShopkeeper(message.from, message.chat);

      await bot.sendMessage(message.chat.id, translator(user)("error.rateLimit"));
    }

    return;
  }

  // Declared OUTSIDE the try block on purpose. `const` inside try{} is
  // block scoped and would be invisible to catch{}, so the FAILED status
  // could never be written.
  let savedMessage;

  // Set only while the sender is still onboarding, for the same scoping
  // reason: the catch below needs them to answer a beginner differently, in
  // their own language. Both are assigned together and neither is read unless
  // the other is set.
  let onboardingUser;
  let onboardingWorkspace;

  // Same reason again: the catch apologises, and it cannot reach `user`.
  let language = DEFAULT_LANGUAGE;

  try {
    // Find or create the shopkeeper from Telegram information.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    language = user.language ?? DEFAULT_LANGUAGE;

    // Without a workspace there is no ledger to write to. Ask before
    // spending an AI call on a message that has nowhere to go.
    if (!user.language || !workspace) {
      await startSetup(message.chat.id, user, workspace);

      return;
    }

    const tr = translator(user);

    if (isOnboarding(user)) {
      onboardingUser = user;
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
    // transaction types are allowed back; the language decides only which
    // language the description comes back in.
    const result = await processMessage(
      message.text,
      message.message_id,
      workspace.type,
      user.language
    );

    // The message made sense but does not belong in this ledger — a customer
    // question asked at home, or a type this workspace cannot record. Say so
    // plainly instead of failing with a generic apology.
    if (result.intent === "unsupported") {
      // Mid-tutorial this is almost always a greeting, not a real attempt at
      // bookkeeping. Repeating the practice prompt keeps a brand new user on
      // the rails; advice about /workspace means nothing to them yet.
      if (isOnboarding(user)) {
        await sendPracticePrompt(message.chat.id, user, workspace);
      } else {
        await bot.sendMessage(
          message.chat.id,
          tr(UNSUPPORTED_KEY[result.reason] ?? "error.transaction", {
            workspace: workspaceLabel(workspace),
          })
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

    // Store the AI-generated entries in PostgreSQL — an ARRAY, since one
    // message can record several. This is why no in-memory Map is needed: the
    // pending entries survive a server restart because PostgreSQL holds them.
    await updateMessageTransactionData(savedMessage.id, result.transactions);

    // AI processing succeeded, so wait for user confirmation.
    await updateMessageStatus(
      savedMessage.id,
      "PENDING_CONFIRMATION"
    );

    // Ask the first unanswered "what was this money for?", or show the card.
    await askToConfirm(
      message.chat.id,
      user,
      result.transactions,
      result.skipped,
      message.message_id
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
      await sendPracticePrompt(
        message.chat.id,
        onboardingUser,
        onboardingWorkspace
      );

      return;
    }

    await sendError(message.chat.id, language, "error.transaction");
  }
});

// --------------------------------------------------
// Confirm / Cancel buttons
// --------------------------------------------------

// Handles Confirm / Cancel button clicks using PostgreSQL
// as the source of truth instead of an in-memory Map.
bot.on("callback_query", async (query) => {
  // Outside the try so the catch below can apologise in the user's language.
  // Set once the user is known; the catch never queries for it, because what
  // it is apologising for may well be the database being unreachable.
  let language = DEFAULT_LANGUAGE;

  try {
    // A clarification button on a multi-entry message carries a third part
    // naming WHICH entry it answers — `repayment:4821:2`. Single-entry
    // messages send no index, exactly as before.
    const [action, messageId, entryIndex] = query.data.split(":");

    // Workspace buttons carry a uuid or a workspace type, not a Telegram
    // message id, so they are handled BEFORE the Number() parse below —
    // which would otherwise turn them into NaN.
    if (action === "ws" || action === "addws") {
      await handleWorkspaceAction(query, action, messageId);

      return;
    }

    // Language buttons carry a language code or the literal "pick", for the
    // same reason — and the guard is the whitelist, so a forged `lang:xx`
    // never reaches the database.
    //
    //   lang:pick   reopen the picker (the 🌐 row on /workspace)
    //   lang:gu     set the language
    if (action === "lang" && (messageId === "pick" || isLanguage(messageId))) {
      await handleLanguageAction(query, messageId);

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

    const tr = translator(user);

    language = user.language ?? DEFAULT_LANGUAGE;

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
        text: tr("toast.notFound"),
      });

      return;
    }

    // Only a pending transaction can be confirmed or cancelled.
    if (savedMessage.status !== "PENDING_CONFIRMATION") {
      await bot.answerCallbackQuery(query.id, {
        text: tr("toast.alreadyDone"),
      });

      return;
    }

    // The AI-generated entries, stored in PostgreSQL. Always read as a list:
    // rows written before one message could hold several hold a bare object.
    const transactions = [savedMessage.transaction_data ?? []].flat();

    // Make sure transaction data exists before continuing.
    if (transactions.length === 0) {
      await bot.answerCallbackQuery(query.id, {
        text: tr("toast.dataMissing"),
      });

      return;
    }

    // An ambiguous payment can only be saved through a clarification button.
    // The plain Confirm button is never shown while one is unanswered, but
    // callback data comes from the user's client, so refuse it here rather
    // than trust that.
    if (action === "confirm" && transactions.some(needsPaymentClarification)) {
      await bot.answerCallbackQuery(query.id, {
        text: tr("toast.chooseFirst"),
      });

      return;
    }

    // A clarification answer on a MULTI-entry message records the choice and
    // moves on to the next question, rather than confirming — nothing is
    // written until the final Yes on the card that lists everything.
    //
    // A single-entry message keeps its original behaviour, where the same tap
    // both answers and saves. Two paths, but the common one is untouched.
    if (entryIndex !== undefined && CLARIFIED_TYPE[action]) {
      const index = Number(entryIndex);

      if (!transactions[index]) {
        await bot.answerCallbackQuery(query.id, { text: tr("toast.notFound") });

        return;
      }

      transactions[index].transaction_type = CLARIFIED_TYPE[action];

      await updateMessageTransactionData(savedMessage.id, transactions);

      await bot.answerCallbackQuery(query.id);

      // Replace the question so it cannot be answered twice.
      await bot.editMessageText(
        `${tr("clarify.question", { person: transactions[index].person })}
${enumLabel(language, "type", CLARIFIED_TYPE[action])} ✅`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );

      // Ask the next one, or show the card now that none are left.
      await askToConfirm(
        query.message.chat.id,
        user,
        transactions,
        null,
        telegramMessageId
      );

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
        text: tr("toast.cancelled"),
      });

      // Replace the confirmation message with the cancellation result.
      await bot.editMessageText(
        tr("confirm.cancelled"),
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
          text: tr("toast.notFound"),
        });

        return;
      }

      // The message was already confirmed, cancelled,
      // or otherwise processed.
      if (result.reason === "ALREADY_PROCESSED") {
        await bot.answerCallbackQuery(query.id, {
          text: tr("toast.alreadyDone"),
        });

        return;
      }

      // Transaction data is missing from the message.
      if (result.reason === "TRANSACTION_DATA_MISSING") {
        await bot.answerCallbackQuery(query.id, {
          text: tr("toast.dataMissing"),
        });

        return;
      }

      // The transaction was successfully created
      // and the message was marked as CONFIRMED.
      if (result.success) {
        const saved = result.transactions;
        const multi = saved.length > 1;

        await bot.answerCallbackQuery(query.id, {
          text: multi
            ? tr("toast.savedMulti", { count: saved.length })
            : tr("toast.saved"),
        });

        // For udhaar entries, show each customer's new outstanding balance so
        // the shopkeeper gets immediate confirmation of the khata.
        //
        // Balances are read AFTER the commit and per customer, so two entries
        // naming the same person both show the final figure rather than a
        // half-applied one.
        const khataLines = [];

        for (const transaction of saved) {
          if (!transaction.customer_id) continue;

          const balance = await getCustomerBalance(
            user.id,
            transaction.customer_id
          );

          // A repayment can overshoot the debt, leaving a negative balance.
          // "owes ₹-4,000" reads as nonsense to a shopkeeper, so a negative
          // is phrased as advance money held — matching how the balance
          // question answers it.
          khataLines.push(
            balance < 0
              ? tr("khata.advance", {
                  person: transaction.person,
                  amount: money(Math.abs(balance)),
                })
              : tr("khata.nowOwes", {
                  person: transaction.person,
                  amount: money(balance),
                })
          );
        }

        const khataLine =
          khataLines.length > 0 ? `\n\n${[...new Set(khataLines)].join("\n")}` : "";

        // Replace the confirmation message with the saved result — the same
        // shape the user just approved, so the card does not rearrange itself
        // under them. Only the title and the khata line change.
        await bot.editMessageText(
          `${
            multi
              ? tr("confirm.savedTitleMulti", { count: saved.length })
              : tr("confirm.savedTitle")
          }

${
  multi ? transactionListCard(user, saved) : transactionCard(user, saved[0])
}${khataLine}`,
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
            user,
            workspace,
            "tour.intro"
          );
        }

        return;
      }
    }

    // Unknown callback action.
    await bot.answerCallbackQuery(query.id, {
      text: tr("toast.unknownAction"),
    });
  } catch (error) {
    console.error(
      "Confirmation error:",
      error
    );

    await bot.answerCallbackQuery(query.id, {
      text: t(language, "toast.wentWrong"),
    });
  }
});

// --------------------------------------------------
// Telegram transport errors
// --------------------------------------------------

// Handles errors reported by Telegram polling.
bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});

// Same, for the webhook transport. Without a listener the library prints the
// raw error itself, so this exists to keep the log format consistent.
bot.on("webhook_error", (error) => {
  console.error(
    "Telegram webhook error:",
    error.message
  );
});

// --------------------------------------------------
// Shutdown
// --------------------------------------------------

// Every redeploy sends SIGTERM and kills the process shortly after. Stopping
// the transport first means no new update is accepted while we are on the way
// out, and `pool.end()` waits for in-flight queries — so a confirmation that
// is mid-`BEGIN` finishes instead of being cut off and rolled back.
async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);

  try {
    if (webhookUrl) {
      await bot.closeWebHook();
    } else {
      await bot.stopPolling();
    }

    await pool.end();
  } catch (error) {
    console.error("Shutdown error:", error.message);
  }

  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => shutdown(signal));
}

// --------------------------------------------------
// Boot
// --------------------------------------------------

// Everything above only defines things. This is the only code that touches the
// network, and it runs solely when this file is the entry point.
async function start() {
  // Checked before anything connects. A missing variable otherwise surfaces as
  // a confusing error on the first real message — the bot boots, looks
  // healthy, and fails per user. A typo'd name in a host's dashboard is the
  // most common bad deploy, so it should stop the process, not degrade it.
  const missingEnv = [
    "TELEGRAM_BOT_TOKEN",
    "DATABASE_URL",
    "GROQ_API_KEY",
  ].filter((name) => !process.env[name]);

  if (missingEnv.length) {
    console.error(
      `Missing required environment variables: ${missingEnv.join(", ")}`
    );

    process.exit(1);
  }

  if (webhookUrl) {
    await bot.openWebHook();

    // Tells Telegram where to deliver updates. Safe to repeat on every boot —
    // it overwrites the previous registration rather than erroring, so
    // redeploying on a new URL needs no manual step. Deliberately not wrapped
    // in a try: a bot Telegram cannot reach should crash visibly rather than
    // sit there answering health checks.
    await bot.setWebhook(`${webhookUrl}${webhookPath}`);

    console.log(`Telegram bot listening for webhooks on ${webhookUrl}`);
  } else {
    await bot.startPolling();

    console.log("Telegram bot is running (polling)...");
  }
}

if (isEntryPoint) {
  await start();
}