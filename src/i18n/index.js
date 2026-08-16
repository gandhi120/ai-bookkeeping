// The language module.
//
// Three catalogs of the same keys, and one function to read them. No i18n
// dependency: everything a Telegram bot with 45 strings needs is below, and
// a library would be more code to configure than this is to write.
//
// Adding a language is four steps and no new machinery:
//   1. copy en.js to the new code, translate the values
//   2. import it and add it to LANGUAGES and CATALOGS here
//   3. widen the CHECK constraint in a new migration
//   4. `npm test` — tests/i18n.test.js will name any key you missed

import en from "./en.js";
import hi from "./hi.js";
import gu from "./gu.js";

// The languages a user can choose. The keys are what is stored in
// users.language, so they must match the CHECK constraint in
// migrations/004_language.sql — tests/i18n.test.js asserts the two agree.
//
// `label` is shown on the picker button in that language's own script, never
// translated: somebody who cannot read English still recognises "ગુજરાતી".
//
// `aiName` is what the AI prompt is told to write the description in. It is
// null for English so that the prompt gets no extra line at all — the prompt
// ships with every message and the token budget is the binding production
// limit, so English users pay nothing for this feature.
export const LANGUAGES = {
  en: { label: "English", aiName: null },
  hi: { label: "हिंदी", aiName: "Hindi (Devanagari script)" },
  gu: { label: "ગુજરાતી", aiName: "Gujarati (Gujarati script)" },
};

const CATALOGS = { en, hi, gu };

// The default, used for anyone who has not chosen yet and as the fallback
// below. English rather than Hindi because it is the language the rest of
// bot.js is still written in.
export const DEFAULT_LANGUAGE = "en";

// Look up one string.
//
// Falls back twice: an unknown language falls back to English, and so does a
// key that language is missing. That second fallback is what lets the
// catalogs grow one screen at a time — a key added to en.js and not yet
// translated renders in English instead of printing "undefined" to a user.
//
// The last resort is the key itself, which is ugly on purpose: it is
// unmistakable in a screenshot, unlike a blank message.
export function t(language, key, vars = {}) {
  const text = CATALOGS[language]?.[key] ?? CATALOGS[DEFAULT_LANGUAGE][key] ?? key;

  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    // A placeholder with no value left in place rather than blanked, for the
    // same reason: a visible {amount} is a bug report, an empty gap is not.
    Object.hasOwn(vars, name) ? vars[name] : whole
  );
}

// Binds t() to one user's language, so a handler reads `tr("tour.more")`
// rather than repeating the language on every line.
//
// Takes the whole user row because that is what resolveShopkeeper() already
// returns — language rides along on a row the bot has fetched anyway, at no
// extra query cost. Tolerates a missing user so a call site can never crash
// on a message it failed to attribute.
export function translator(user) {
  const language = user?.language ?? DEFAULT_LANGUAGE;

  return (key, vars) => t(language, key, vars);
}

// True if `code` is a language we actually have. The whitelist for anything
// arriving from a user's Telegram client.
export function isLanguage(code) {
  return Object.hasOwn(LANGUAGES, code);
}

// Translates a database identifier — a transaction type or a category — into
// a word the user reads.
//
// Falls back to the RAW VALUE, not to the key, and that is the whole point:
// `category` is a free z.string() in the schema (the prompt asks for the
// known list, nothing enforces it), so the AI can return "chai" and we have
// no label for it. Showing "chai" is fine; showing "cat.chai" is not.
export function enumLabel(language, prefix, value) {
  const key = `${prefix}.${value}`;
  const text = t(language, key);

  return text === key ? value : text;
}

// The locale used for month names.
//
// `-u-nu-latn` pins Latin digits. Node's ICU already defaults to them for
// Hindi and Gujarati, but the production image is a different build, and a
// date in Devanagari numerals sitting beside a ₹ amount in Latin ones is
// exactly the kind of thing that ships unnoticed.
function dateLocale(language) {
  return `${language === "hi" ? "hi-IN" : language === "gu" ? "gu-IN" : "en-IN"}-u-nu-latn`;
}

// "16 ઑગસ્ટ 2026", or "16 ઑગસ્ટ" without the year.
//
// Assembled from formatToParts rather than taken from toLocaleDateString,
// because Gujarati renders "16 ઑગસ્ટ, 2026" — with a comma — and the parts
// let us drop it. Month names are always the LONG form: the short form in
// Hindi is "अग॰", which reads as a typo rather than an abbreviation.
export function formatDate(language, date, { year = true } = {}) {
  const parts = new Intl.DateTimeFormat(dateLocale(language), {
    day: "numeric",
    month: "long",
    ...(year ? { year: "numeric" } : {}),
    timeZone: "Asia/Kolkata",
  }).formatToParts(new Date(date));

  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return year
    ? `${value.day} ${value.month} ${value.year}`
    : `${value.day} ${value.month}`;
}

// "ઑગસ્ટ 2026" — the /monthly header.
export function formatMonth(language, date) {
  return new Date(date).toLocaleDateString(dateLocale(language), {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}
