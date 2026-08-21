// Self-check for the language catalogs.
//
// The check that matters here is COMPLETENESS. t() falls back to English for
// a missing key, which is what lets the catalogs grow one screen at a time —
// but it also means a forgotten translation is invisible at runtime: the
// Gujarati user just sees an English line and assumes the bot is broken.
// This test is the thing that makes it loud instead.
//
//   node tests/i18n.test.js
//
// No database and no API key needed — pure data.

import assert from "node:assert/strict";

// The transaction types that existed before migration 006. The AI does not
// produce these any more — it writes its own label in the user's language —
// but rows recorded before 006 still carry them, and enumLabel() renders those
// through type.*. Delete this list when those rows are gone, not before.
const LEGACY_TYPES = [
  "sale",
  "purchase",
  "expense",
  "payment_received",
  "payment_sent",
  "credit_sale",
  "repayment",
  "income",
  "other",
];
import { readFileSync, readdirSync } from "node:fs";

import {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  t,
  translator,
  isLanguage,
  enumLabel,
  formatDate,
  formatMonth,
} from "../src/i18n/index.js";
import en from "../src/i18n/en.js";
import hi from "../src/i18n/hi.js";
import gu from "../src/i18n/gu.js";
import {
  COMMON_CATEGORIES,
} from "../src/schemas/transaction.schema.js";

let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

const CATALOGS = { en, hi, gu };

// English is the reference: every other catalog is measured against it.
const REFERENCE_KEYS = Object.keys(en);

console.log("\ni18n: catalogs\n");

check("English catalog is not empty", () => {
  assert.ok(REFERENCE_KEYS.length > 0);
});

check("every language in LANGUAGES has a catalog", () => {
  for (const code of Object.keys(LANGUAGES)) {
    assert.ok(CATALOGS[code], `no catalog for ${code}`);
  }
});

check("every catalog is a language in LANGUAGES", () => {
  for (const code of Object.keys(CATALOGS)) {
    assert.ok(LANGUAGES[code], `${code} has a catalog but is not offered`);
  }
});

check("the default language has a catalog", () => {
  assert.ok(CATALOGS[DEFAULT_LANGUAGE]);
});

check("every language has a label in its own script", () => {
  for (const [code, { label }] of Object.entries(LANGUAGES)) {
    assert.ok(label && label.trim().length > 0, `${code} has no label`);
  }
});

// THE IMPORTANT ONE. A key added to en.js and forgotten in hi.js renders in
// English to a Hindi user — correct-looking code, broken product.
for (const [code, catalog] of Object.entries(CATALOGS)) {
  if (code === DEFAULT_LANGUAGE) continue;

  check(`${code}: has every English key`, () => {
    const missing = REFERENCE_KEYS.filter((key) => !(key in catalog));

    assert.deepEqual(missing, [], `missing keys: ${missing.join(", ")}`);
  });

  check(`${code}: has no key English lacks`, () => {
    const extra = Object.keys(catalog).filter((key) => !(key in en));

    assert.deepEqual(extra, [], `unknown keys: ${extra.join(", ")}`);
  });

  check(`${code}: no value is empty`, () => {
    const blank = Object.entries(catalog)
      .filter(([, value]) => typeof value !== "string" || value.trim() === "")
      .map(([key]) => key);

    assert.deepEqual(blank, [], `blank values: ${blank.join(", ")}`);
  });

  // Catches a copy-paste stub: a key that was duplicated from en.js and never
  // actually translated. Button labels that are the same in every language by
  // design would need listing here as exceptions; there are none today.
  check(`${code}: no value is still the English text`, () => {
    const untranslated = REFERENCE_KEYS.filter(
      (key) => catalog[key] === en[key]
    );

    assert.deepEqual(
      untranslated,
      [],
      `untranslated: ${untranslated.join(", ")}`
    );
  });

  // A placeholder dropped in translation renders a sentence with a hole in it
  // — "{person} now owes" with no name. Comparing the sets both ways also
  // catches a typo'd {persn}, which would print the placeholder verbatim.
  check(`${code}: every value uses the same placeholders as English`, () => {
    const placeholders = (text) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

    for (const key of REFERENCE_KEYS) {
      assert.deepEqual(
        placeholders(catalog[key]),
        placeholders(en[key]),
        `${key} placeholders differ`
      );
    }
  });
}

console.log("\ni18n: t()\n");

check("returns the string for a known language and key", () => {
  assert.equal(t("en", "tour.more"), en["tour.more"]);
  assert.equal(t("gu", "tour.more"), gu["tour.more"]);
});

check("interpolates named variables", () => {
  assert.equal(
    t("en", "workspace.ready", { workspace: "🏪 My Shop" }),
    "🏪 My Shop is ready."
  );
});

check("interpolates the same variable in every language", () => {
  for (const code of Object.keys(CATALOGS)) {
    assert.match(
      t(code, "khata.nowOwes", { person: "Raj", amount: "₹500" }),
      /Raj/
    );
  }
});

check("a zero count still renders, rather than vanishing", () => {
  // `?? ` on a 0 would blank the number. Object.hasOwn is what avoids that.
  assert.match(t("en", "finish.cleared", { count: 0 }), /0/);
});

check("an unknown language falls back to English", () => {
  assert.equal(t("fr", "tour.more"), en["tour.more"]);
});

check("a missing language falls back to English", () => {
  assert.equal(t(undefined, "tour.more"), en["tour.more"]);
  assert.equal(t(null, "tour.more"), en["tour.more"]);
});

check("an unknown key returns the key itself, not undefined", () => {
  assert.equal(t("gu", "no.such.key"), "no.such.key");
});

check("an unfilled placeholder is left visible, not blanked", () => {
  assert.equal(t("en", "workspace.ready"), "{workspace} is ready.");
});

console.log("\ni18n: translator() and isLanguage()\n");

check("translator uses the user's language", () => {
  assert.equal(translator({ language: "gu" })("tour.more"), gu["tour.more"]);
});

check("translator falls back to English for a user with no language", () => {
  assert.equal(translator({})("tour.more"), en["tour.more"]);
  assert.equal(translator(null)("tour.more"), en["tour.more"]);
  assert.equal(translator(undefined)("tour.more"), en["tour.more"]);
});

check("isLanguage accepts every offered language", () => {
  for (const code of Object.keys(LANGUAGES)) {
    assert.equal(isLanguage(code), true);
  }
});

check("isLanguage rejects anything else", () => {
  for (const forged of ["fr", "", "pick", "en; DROP TABLE users", "toString"]) {
    assert.equal(isLanguage(forged), false, `accepted ${forged}`);
  }
});

console.log("\ni18n: enum labels\n");

// Every database identifier the user can see needs a word in every language.
// A missing one is how "Type: credit_sale" ended up in the middle of a
// Gujarati card in the first place.
for (const [code, catalog] of Object.entries(CATALOGS)) {
  check(`${code}: every transaction type has a label`, () => {
    const missing = LEGACY_TYPES.filter((type) => !(`type.${type}` in catalog));

    assert.deepEqual(missing, [], `no label for: ${missing.join(", ")}`);
  });

  check(`${code}: every household category has a label`, () => {
    const missing = COMMON_CATEGORIES.filter((c) => !(`cat.${c}` in catalog));

    assert.deepEqual(missing, [], `no label for: ${missing.join(", ")}`);
  });
}

check("enumLabel translates a known type", () => {
  assert.equal(enumLabel("gu", "type", "expense"), gu["type.expense"]);
  assert.equal(enumLabel("hi", "type", "credit_sale"), hi["type.credit_sale"]);
});

// `category` is a free z.string() in the schema, so the AI can return a word
// no catalog has. Showing "chai" is fine; showing "cat.chai" is not.
check("enumLabel falls back to the raw value, never the key", () => {
  assert.equal(enumLabel("gu", "cat", "chai"), "chai");
  assert.equal(enumLabel("en", "type", "barter"), "barter");
});

check("enumLabel on an unknown language still translates via English", () => {
  assert.equal(enumLabel("fr", "type", "expense"), en["type.expense"]);
});

console.log("\ni18n: dates\n");

const AUG = "2026-08-16";

check("formatDate gives a different month name per language", () => {
  const names = ["en", "hi", "gu"].map((code) => formatDate(code, AUG));

  assert.equal(new Set(names).size, 3, `not all distinct: ${names.join(" | ")}`);
});

check("formatDate has no comma — Gujarati adds one by default", () => {
  for (const code of ["en", "hi", "gu"]) {
    assert.doesNotMatch(formatDate(code, AUG), /,/);
  }
});

check("formatDate keeps Latin digits in every language", () => {
  for (const code of ["en", "hi", "gu"]) {
    const text = formatDate(code, AUG);

    assert.match(text, /16/, `day missing from ${code}: ${text}`);
    assert.match(text, /2026/, `year missing from ${code}: ${text}`);
    // Devanagari and Gujarati digit blocks.
    assert.doesNotMatch(text, /[०-९૦-૯]/, text);
  }
});

check("formatDate can drop the year, for khata rows", () => {
  assert.doesNotMatch(formatDate("gu", AUG, { year: false }), /2026/);
  assert.match(formatDate("gu", AUG, { year: false }), /16/);
});

check("formatMonth gives the month and year, no day", () => {
  for (const code of ["en", "hi", "gu"]) {
    const text = formatMonth(code, AUG);

    assert.match(text, /2026/);
    assert.doesNotMatch(text, /16/, `day leaked into ${code}: ${text}`);
  }
});

// A short month in Hindi is "अग॰", which reads as a typo. The helper is
// supposed to use long month names everywhere.
check("formatDate uses long month names", () => {
  assert.doesNotMatch(formatDate("hi", AUG), /॰/);
});

console.log("\ni18n: telegram wiring\n");

// EVERY file in src/telegram/, not just bot.js.
//
// These two checks read the handlers as text. When bot.js was one file that
// meant one readFileSync; now that it is eight, reading only the entry point
// would leave both checks passing while covering ~100 lines of boot code and
// none of the handlers they exist to guard. A test that quietly stops testing
// is worse than no test, so this globs the directory — a ninth file is covered
// the day it is added, with no edit here.
const TELEGRAM = new URL("../src/telegram/", import.meta.url);

const BOT_FILES = readdirSync(TELEGRAM)
  .filter((name) => name.endsWith(".js"))
  .sort()
  .map((name) => ({
    name,
    src: readFileSync(new URL(name, TELEGRAM), "utf8"),
  }));

// THE BUG THIS EXISTS FOR. `user` is resolved inside a handler's try block, so
// a catch block that calls translator(user) throws ReferenceError — and an
// unhandled rejection in a Telegram handler takes the whole process down. It
// shipped in seven handlers at once, and every one of them looked fine.
//
// Catch blocks must use the hoisted `language` (via sendError or t()), never
// `user`. Crude brace matching is enough here: these are all shallow blocks
// and a false positive is a one-line fix, not a mystery.
check("no catch block in src/telegram/ references `user`", () => {
  const offenders = [];

  for (const { name, src: BOT } of BOT_FILES) {
    for (const match of BOT.matchAll(/\}\s*catch\s*\(\w+\)\s*\{/g)) {
      let depth = 1;
      let i = match.index + match[0].length;

      while (i < BOT.length && depth > 0) {
        if (BOT[i] === "{") depth++;
        else if (BOT[i] === "}") depth--;
        i++;
      }

      const body = BOT.slice(match.index + match[0].length, i);
      const line = BOT.slice(0, match.index).split("\n").length;

      // console.error(...) is fine — it never runs user-facing code.
      const withoutLogs = body.replace(/console\.\w+\([^;]*\);/g, "");

      if (/\buser\b/.test(withoutLogs)) offenders.push(`${name}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `catch blocks using \`user\` (use the hoisted \`language\`): ${offenders.join(", ")}`
  );
});

// Every key the handlers ask for must exist, or the user gets the key printed
// back at them.
check("every t()/tr() key used in src/telegram/ exists in the catalog", () => {
  const used = new Set(
    BOT_FILES.flatMap(({ src }) => [
      ...src.matchAll(/\b(?:tr|t)\(\s*(?:[\w.]+,\s*)?["']([a-z]+\.[A-Za-z_]+)["']/g),
    ])
      .map((match) => match[1])
      // type.* and cat.* are built at runtime by enumLabel from the enums,
      // and those are covered by the checks above.
      .filter((key) => !key.startsWith("type.") && !key.startsWith("cat."))
  );

  const missing = [...used].filter((key) => !(key in en)).sort();

  assert.deepEqual(missing, [], `keys used but not defined: ${missing.join(", ")}`);
});

console.log("\ni18n: migration\n");

// The CHECK constraint and LANGUAGES are two lists of the same thing in two
// files. Adding a language to the code without a migration would fail at
// UPDATE time in production; this fails it at `npm test` instead.
check("the migration's CHECK matches LANGUAGES", () => {
  const sql = readFileSync(
    new URL("../migrations/004_language.sql", import.meta.url),
    "utf8"
  );

  const constraint = sql.match(/CHECK \(language IN \(([^)]+)\)\)/);

  assert.ok(constraint, "no CHECK constraint found in 004_language.sql");

  const allowed = [...constraint[1].matchAll(/'(\w+)'/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(allowed, Object.keys(LANGUAGES).sort());
});

console.log(`\n${passed} checks passed\n`);
