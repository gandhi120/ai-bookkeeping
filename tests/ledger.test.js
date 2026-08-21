// Ledger naming. No database, no API key, free.
//
//   node tests/ledger.test.js
//
// parseLedger() splits "🏍️ Bike" into an emoji and a name. It is four lines of
// code and gets its own test file because the interesting part is Unicode:
// an emoji is not one character to JavaScript, and getting that wrong puts
// half a glyph at the front of somebody's ledger name.

import {
  parseLedger,
  MAX_LEDGER_NAME,
} from "../src/telegram/onboarding.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);

  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(
      `  FAIL  ${name}\n        expected ${JSON.stringify(
        expected
      )}, got ${JSON.stringify(actual)}`
    );
  }
}

console.log("\n--- Emoji and name together ---");
check("emoji then space then name", parseLedger("🏍️ Bike"), {
  emoji: "🏍️",
  name: "Bike",
});
check("no space between them", parseLedger("🏪Kirana"), {
  emoji: "🏪",
  name: "Kirana",
});
check("extra whitespace all round", parseLedger("   🌾   Farm   "), {
  emoji: "🌾",
  name: "Farm",
});

console.log("\n--- The Unicode case this function exists for ---");
// 👨🏽‍🌾 is FIVE code points: man + skin tone + ZWJ + ear of rice + VS.
// A /^\p{Extended_Pictographic}/u regex takes the first one and leaves the
// rest glued to the name, so the ledger comes out called "🏽‍🌾 Farm".
// Intl.Segmenter walks grapheme clusters and returns it whole.
check("ZWJ sequence with a skin tone stays intact", parseLedger("👨🏽‍🌾 Farm"), {
  emoji: "👨🏽‍🌾",
  name: "Farm",
});
check("flag (two regional indicators)", parseLedger("🇮🇳 Import"), {
  emoji: "🇮🇳",
  name: "Import",
});

console.log("\n--- No emoji sent ---");
check("plain name gets the default", parseLedger("Bike"), {
  emoji: "📒",
  name: "Bike",
});
check("Gujarati name, no emoji", parseLedger("દુકાન"), {
  emoji: "📒",
  name: "દુકાન",
});
check("a name that starts with a digit is not an emoji", parseLedger("2nd Shop"), {
  emoji: "📒",
  name: "2nd Shop",
});

console.log("\n--- Nothing usable ---");
// The caller REFUSES both of these rather than creating them. Without that
// check the upsert would happily make a ledger called "", which the switcher
// renders as a lone icon with nothing beside it.
check("empty string", parseLedger(""), { emoji: "📒", name: "" });
check("whitespace only", parseLedger("   "), { emoji: "📒", name: "" });
check("emoji with no name", parseLedger("🏍️"), { emoji: "🏍️", name: "" });
check("null does not throw", parseLedger(null), { emoji: "📒", name: "" });

console.log("\n--- Length ---");
check(
  "a long name is truncated, not rejected",
  parseLedger("x".repeat(60)).name.length,
  MAX_LEDGER_NAME
);
check(
  "the emoji does not count toward the limit",
  parseLedger(`🏪${"x".repeat(60)}`).name.length,
  MAX_LEDGER_NAME
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
