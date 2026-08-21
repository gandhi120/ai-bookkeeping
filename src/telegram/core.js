// The pieces every other telegram module needs: the bot instance itself, the
// user/workspace lookup every handler starts with, the setup gate, and the
// small formatting helpers.
//
// This file imports nothing from its siblings — that is what keeps the module
// graph acyclic. Everything else in src/telegram/ may import from here.

import TelegramBot from "node-telegram-bot-api";
import "dotenv/config";

import { findOrCreateUser } from "../database/users.js";
import { getActiveWorkspace } from "../database/workspaces.js";
import {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  t,
  translator,
  formatDate,
} from "../i18n/index.js";


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


// Ready-made ledgers offered on the FIRST run only.
//
// Not a type system — these fill in an emoji and a name so somebody who just
// typed "hii" can start with one tap instead of being asked to compose an
// emoji and a name before the bot has done anything for them. Once created,
// one of these is indistinguishable from a ledger the user named themselves:
// nothing looks a ledger up by which starter made it.
//
// `nameKey` is translated at creation and then stored on the row, so an
// existing ledger keeps whatever it was called and only new ones follow the
// user's current language.
const LEDGER_STARTERS = {
  shop: { emoji: "🏪", nameKey: "workspace.nameShop" },
  home: { emoji: "🏠", nameKey: "workspace.nameHome" },
};


// "🏪 My Shop" — how a ledger is named everywhere in the UI.
//
// The emoji is a column now rather than a constant looked up by type, which
// is the whole point: the user picked it.
function workspaceLabel(workspace) {
  return `${workspace.emoji ?? "📒"} ${workspace.name}`;
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
        // Two ready-made ledgers and a way out of both. The starters exist so
        // the first step is a tap; "make my own" is the same flow /menu uses
        // later, so nothing here is a path that only new users ever walk.
        [{ text: tr("setup.shopButton"), callback_data: "addws:shop" }],
        [{ text: tr("setup.homeButton"), callback_data: "addws:home" }],
        [{ text: tr("setup.ownButton"), callback_data: "addws:own" }],
      ],
    },
  });
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
    tr("practice.prompt", { example: tr("practice.example") }),
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


// Money from a NAMED person, where the message never said what it was for.
// "Received ₹5000 from Raj" might settle Raj's udhaar or might be ordinary
// income. Only the user knows, and guessing wrong silently changes what
// somebody owes — so we ask instead of deciding.
//
// Expressed in the two axes: money came in, nobody's debt was said to change,
// and a person was named. The prompt only produces that combination for
// exactly this case — anything stating it settles a debt comes back with
// udhaar already set, and money from nobody in particular has no person.
function needsPaymentClarification(transaction) {
  return (
    transaction.cash === "in" &&
    transaction.udhaar === "none" &&
    Boolean(transaction.person)
  );
}

export {
  resolveShopkeeper,
  LEDGER_STARTERS,
  workspaceLabel,
  startSetup,
  askToChooseLanguage,
  askToChooseWorkspace,
  isOnboarding,
  sendPracticePrompt,
  money,
  sendError,
  today,
  needsPaymentClarification,
  webhookUrl,
  webhookPath,
};
