// /gym — the fitness check-in, as a menu.
//
// The whole gym feature reaches the bot through this one file. It imports
// `bot` and `resolveShopkeeper` from telegram/core.js READ-ONLY and modifies
// nothing in the bookkeeping code.
//
// It lives in src/gym/ rather than src/telegram/ deliberately, and not only
// for tidiness: tests/i18n.test.js scans every file in src/telegram/ and
// asserts each tr("...") key exists in the BOOKKEEPING catalog. A gym handler
// sitting in that folder would fail a bookkeeping test for using its own
// strings. Keeping it here means the whole feature is one folder to delete.
//
// THE SHEET IS THE STATE. Nothing about a half-finished check-in is stored
// anywhere: every screen is rendered from a fresh read of the week, and every
// tap writes straight through. So a menu opened yesterday still works, the bot
// can restart mid-check-in, and editing the sheet by hand is never out of sync
// with what the bot believes. It costs one read per screen, which is a Google
// round trip nobody notices at this size.

import { resolveShopkeeper, bot } from "../telegram/core.js";
import {
  parseCheckin,
  parseValue,
  FIELDS,
  FIELD_BY_KEY,
} from "./checkin.js";
import { readWeek, writeCheckin, isConfigured } from "./sheet.js";
import { gtr, AI_LANGUAGE } from "./text.js";

// Today in the user's timezone, as YYYY-MM-DD.
//
// Its own copy rather than core.js's today(): identical three lines, but a
// gym change must never be able to move the date bookkeeping files by.
function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// Why a sheet call failed, in words the user can act on.
//
// Reading and writing fail the same ways but mean different things to the
// person: "could not write it" after a bare /gym is a lie, because /gym only
// opens the menu. readFailure() says the true thing.
const FAILURE_KEY = {
  NOT_CONFIGURED: "gym.notConfigured",
  FORBIDDEN: "gym.notConfigured",
  NO_ROW: "gym.noRow",
  NO_TAB: "gym.sheetFailed",
  NO_DATE_COLUMN: "gym.sheetFailed",
  NOTHING_TO_WRITE: "gym.sheetFailed",
  UNMATCHED: "gym.sheetFailed",
  UNREACHABLE: "gym.sheetFailed",
  HTTP: "gym.sheetFailed",
  UNEXPECTED: "gym.sheetFailed",
};

// The tag that carries a force-reply's context.
//
// Telegram hands back the message being replied to, so the date and field ride
// in its TEXT rather than in a table somewhere. That is the whole reason this
// feature needs no state: the question remembers what it asked.
const TAG = /#(\d{4}-\d{2}-\d{2})\/(\w+)/;

// A read never wrote anything, so it must never claim it tried.
function readFailure(tr, reason, date) {
  const key = FAILURE_KEY[reason] ?? "gym.readFailed";

  return tr(key === "gym.sheetFailed" ? "gym.readFailed" : key, { date });
}

function tagFor(date, key) {
  return `#${date}/${key}`;
}

// "22 August" from an ISO date, in the user's language.
function dayLabel(iso, language) {
  const [year, month, day] = iso.split("-").map(Number);

  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(
    `${language === "en" ? "en-IN" : language}-u-nu-latn`,
    { day: "numeric", month: "long", timeZone: "UTC" }
  );
}

// What the sheet currently holds for one field on one day.
// Weekly fields ignore the day: there is one value for the whole block.
function currentValue(week, iso, field) {
  if (field.column in week.weekly) return week.weekly[field.column] || null;

  return week.daily?.[iso]?.[field.column] || null;
}

function isWeekly(week, field) {
  return field.column in week.weekly;
}


// --------------------------------------------------
// Screen 1 — which day
// --------------------------------------------------

// The seven days of the week the sheet is showing, today marked.
//
// A week rather than "today / yesterday" because that is how the tracker is
// built: one block of seven rows with the weekly scores merged across them.
// Offering the same shape means catching up on Sunday is the same gesture as
// filling in today.
async function sendDayPicker(chatId, user, week, messageId = null) {
  const tr = gtr(user);
  const language = user?.language ?? "en";
  const now = today();

  const rows = week.days.map((day) => [
    {
      text:
        `${day.date === now ? "▶ " : ""}${day.day} ${dayLabel(day.date, language)}` +
        `${filledCount(week, day.date)}`,
      callback_data: `gym:day:${day.date}`,
    },
  ]);

  const options = {
    reply_markup: { inline_keyboard: rows },
  };

  // Editing rather than sending keeps one menu on screen instead of a column
  // of stale ones the user can still tap.
  if (messageId) {
    await bot.editMessageText(tr("gym.pickDay"), {
      chat_id: chatId,
      message_id: messageId,
      ...options,
    });

    return;
  }

  await bot.sendMessage(chatId, tr("gym.pickDay"), options);
}

// "3/5" — how much of that day is done, so a gap is visible without opening it.
// Weekly fields are left out: they belong to the week, not to any one day.
function filledCount(week, iso) {
  const daily = FIELDS.filter((field) => !isWeekly(week, field));
  const done = daily.filter((field) => currentValue(week, iso, field)).length;

  return done === 0 ? "" : `   ${done}/${daily.length}`;
}


// --------------------------------------------------
// Screen 2 — one day's fields
// --------------------------------------------------

async function sendDayMenu(chatId, user, week, iso, messageId = null) {
  const tr = gtr(user);
  const language = user?.language ?? "en";

  const day = week.days.find((d) => d.date === iso);

  const daily = FIELDS.filter((field) => !isWeekly(week, field));
  const weekly = FIELDS.filter((field) => isWeekly(week, field));

  const line = (field) => {
    const value = currentValue(week, iso, field);

    return `${field.icon} ${tr(`gym.${field.label}`)}: ${
      value ? `${value}${field.unit}` : tr("gym.blank")
    }`;
  };

  const parts = [
    `🏋️ ${day?.day ?? ""} ${dayLabel(iso, language)}`,
    "",
    daily.map(line).join("\n"),
  ];

  if (weekly.length) {
    parts.push("", tr("gym.thisWeek"), weekly.map(line).join("\n"));
  }

  // Two per row for the day's fields, one per row for the week's — the weekly
  // buttons carry a longer caption and would wrap side by side.
  const buttons = [];

  for (let i = 0; i < daily.length; i += 2) {
    buttons.push(
      daily.slice(i, i + 2).map((field) => ({
        text: `${field.icon} ${tr(`gym.${field.label}`)}`,
        callback_data: `gym:f:${iso}:${field.key}`,
      }))
    );
  }

  for (const field of weekly) {
    buttons.push([
      {
        text: `${field.icon} ${tr(`gym.${field.label}`)} ${tr("gym.weekTag")}`,
        callback_data: `gym:f:${iso}:${field.key}`,
      },
    ]);
  }

  buttons.push([{ text: tr("gym.backToDays"), callback_data: `gym:week:${iso}` }]);

  const options = { reply_markup: { inline_keyboard: buttons } };

  if (messageId) {
    await bot.editMessageText(parts.join("\n"), {
      chat_id: chatId,
      message_id: messageId,
      ...options,
    });

    return;
  }

  await bot.sendMessage(chatId, parts.join("\n"), options);
}


// --------------------------------------------------
// Screen 3 — entering one value
// --------------------------------------------------

// A 1-5 field becomes five buttons: no typing, nothing to get out of range,
// and it matches the dropdown the coach put in the sheet.
async function askForScore(chatId, user, week, iso, field) {
  const tr = gtr(user);
  const language = user?.language ?? "en";

  const scale = [1, 2, 3, 4, 5].map((n) => ({
    text: String(currentValue(week, iso, field) == n ? `${n} ✓` : n),
    callback_data: `gym:s:${iso}:${field.key}:${n}`,
  }));

  await bot.sendMessage(
    chatId,
    `${field.icon} ${tr(`gym.${field.label}`)} — ${
      isWeekly(week, field)
        ? tr("gym.forTheWeek")
        : dayLabel(iso, language)
    }`,
    {
      reply_markup: {
        inline_keyboard: [scale, [{ text: tr("gym.back"), callback_data: `gym:day:${iso}` }]],
      },
    }
  );
}

// Everything else opens a reply box. The date and field ride in the message
// text as a tag, so the answer needs no stored state to be understood.
async function askForValue(chatId, user, iso, field) {
  const tr = gtr(user);
  const language = user?.language ?? "en";

  await bot.sendMessage(
    chatId,
    `${field.icon} ${tr(`gym.${field.label}`)} — ${dayLabel(iso, language)}
${tr(`gym.hint.${field.label}`)}

${tagFor(iso, field.key)}`,
    {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: tr(`gym.ph.${field.label}`),
      },
    }
  );
}


// --------------------------------------------------
// Writing
// --------------------------------------------------

// One field, one value, straight to the sheet.
//
// Sends the whole check-in shape with a single non-null field: writeCheckin
// skips nulls, so this reuses the same path the free-text /gym uses rather
// than adding a second way to write.
async function saveOne(iso, key, value) {
  const blank = { date: iso };

  for (const field of FIELDS) blank[field.key] = null;

  return await writeCheckin({ ...blank, [key]: value });
}


// --------------------------------------------------
// Handlers
// --------------------------------------------------

// `/gym` opens the menu. `/gym 82.5kg, slept 7h` still records in one message
// — the fast path for somebody who knows what they want to say.
bot.onText(/^\/gym(?:@\w+)?(?:\s+([\s\S]+))?$/, async (message, match) => {
  const chatId = message.chat.id;

  let tr = gtr(null);

  try {
    const { user } = await resolveShopkeeper(message.from, message.chat);

    tr = gtr(user);

    if (!isConfigured()) {
      await bot.sendMessage(chatId, tr("gym.notConfigured"));

      return;
    }

    const text = match?.[1]?.trim();

    if (!text) {
      const week = await readWeek(today(), { fresh: true });

      if (!week.ok) {
        console.error("[gym] sheet read failed:", week.reason, week.detail ?? "");

        await bot.sendMessage(chatId, readFailure(tr, week.reason, today()));

        return;
      }

      await sendDayPicker(chatId, user, week);

      return;
    }

    // The free-text path: one sentence, the model pulls it apart.
    const parsed = await parseCheckin(text, today(), AI_LANGUAGE[user.language ?? "en"]);

    if (!parsed.ok) {
      await bot.sendMessage(
        chatId,
        parsed.reason === "INVALID" ? tr("gym.badValue") : tr("gym.nothing")
      );

      return;
    }

    const written = await writeCheckin(parsed.checkin);

    if (!written.ok) {
      console.error("[gym] sheet write failed:", written.reason, written.detail ?? "");

      await bot.sendMessage(
        chatId,
        tr(FAILURE_KEY[written.reason] ?? "gym.sheetFailed", { date: parsed.checkin.date })
      );

      return;
    }

    await bot.sendMessage(chatId, savedCard(tr, parsed.checkin));
  } catch (error) {
    console.error("[gym] /gym error:", error);

    try {
      await bot.sendMessage(chatId, tr("gym.error"));
    } catch (sendError) {
      console.error("[gym] could not send the error message:", sendError);
    }
  }
});

// What the free-text path wrote, echoed back. Only the fields it actually set.
function savedCard(tr, checkin) {
  const rows = FIELDS.filter(({ key }) => checkin[key] !== null).map(
    ({ key, label, unit, icon }) =>
      `${icon} ${tr(`gym.${label}`)}: ${checkin[key]}${unit}`
  );

  return `${tr("gym.saved")}

${tr("gym.date")} ${checkin.date}

${rows.join("\n")}

${tr("gym.resend")}`;
}

// Every gym button. Namespaced `gym:` so it can never collide with the
// bookkeeping callbacks, which are routed in a different file entirely.
bot.on("callback_query", async (query) => {
  const [namespace, action, iso, key, score] = String(query.data ?? "").split(":");

  if (namespace !== "gym") return;

  const chatId = query.message.chat.id;
  let tr = gtr(null);

  try {
    const { user } = await resolveShopkeeper(query.from, query.message.chat);

    tr = gtr(user);

    // Answered immediately so the button stops spinning. Telegram allows about
    // ten seconds before it shows its own error, and a write to Apps Script
    // takes four — so a score tap gets a toast saying so, while navigation
    // (served from cache) needs none.
    await bot.answerCallbackQuery(
      query.id,
      action === "s" ? { text: tr("gym.saving") } : undefined
    );

    // A write hands back the refreshed week, so setting a score is one round
    // trip rather than write-then-read. At four seconds each that is the
    // difference between a tap feeling slow and feeling broken.
    let week;

    if (action === "s") {
      const written = await saveOne(iso, key, Number(score));

      if (!written.ok) {
        console.error("[gym] write failed:", written.reason, written.detail ?? "");
        await bot.sendMessage(chatId, tr(FAILURE_KEY[written.reason] ?? "gym.sheetFailed", { date: iso }));

        return;
      }

      week = written.week;
    }

    week = week ?? (await readWeek(iso));

    if (!week.ok) {
      console.error("[gym] sheet read failed:", week.reason, week.detail ?? "");

      await bot.sendMessage(chatId, readFailure(tr, week.reason, iso));

      return;
    }

    if (action === "week") {
      await sendDayPicker(chatId, user, week, query.message.message_id);

      return;
    }

    if (action === "f") {
      const field = FIELD_BY_KEY[key];

      if (!field) return;

      if (field.input === "score") {
        await askForScore(chatId, user, week, iso, field);
      } else {
        await askForValue(chatId, user, iso, field);
      }

      return;
    }

    // "day", and the redraw after a score was set.
    await sendDayMenu(
      chatId,
      user,
      week,
      iso,
      action === "s" ? null : query.message.message_id
    );
  } catch (error) {
    console.error("[gym] callback error:", error);

    try {
      await bot.sendMessage(chatId, tr("gym.error"));
    } catch (sendError) {
      console.error("[gym] could not send the error message:", sendError);
    }
  }
});

// The answer to a force-reply.
//
// Recognised ONLY by the tag in the message being replied to, so an ordinary
// message can never be mistaken for one — and messages.js skips replies to the
// bot for the same reason, or a value like "82.5" would also be read as a
// transaction.
bot.on("message", async (message) => {
  const prompt = message.reply_to_message?.text;

  if (!prompt || !message.text) return;

  const tag = prompt.match(TAG);

  if (!tag) return;

  const [, iso, key] = tag;
  const field = FIELD_BY_KEY[key];

  if (!field) return;

  const chatId = message.chat.id;
  let tr = gtr(null);

  try {
    const { user } = await resolveShopkeeper(message.from, message.chat);

    tr = gtr(user);

    const parsed = parseValue(field, message.text);

    if (!parsed.ok) {
      await bot.sendMessage(
        chatId,
        tr(parsed.reason === "OUT_OF_RANGE" ? "gym.outOfRange" : "gym.notANumber", {
          field: tr(`gym.${field.label}`),
        })
      );

      return;
    }

    const written = await saveOne(iso, key, parsed.value);

    if (!written.ok) {
      console.error("[gym] write failed:", written.reason, written.detail ?? "");
      await bot.sendMessage(chatId, tr(FAILURE_KEY[written.reason] ?? "gym.sheetFailed", { date: iso }));

      return;
    }

    // Same one-round-trip trick as the score buttons.
    const week = written.week ?? (await readWeek(iso));

    if (week.ok !== false) {
      await sendDayMenu(chatId, user, week, iso);
    }
  } catch (error) {
    console.error("[gym] reply error:", error);

    try {
      await bot.sendMessage(chatId, tr("gym.error"));
    } catch (sendError) {
      console.error("[gym] could not send the error message:", sendError);
    }
  }
});
