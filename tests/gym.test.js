// Self-check for the gym check-in validator. No database, no API key, free.
//
//   node tests/gym.test.js
//
// The trust boundary is the same shape as the bookkeeping one — a model can
// return anything and whatever passes goes into a coach's spreadsheet — but
// what it guards is different. There are no amounts and no directions here;
// the risk is a number landing in the wrong column, or a compliance score the
// sheet's 1-5 dropdown cannot display.

import assert from "node:assert/strict";

import {
  CheckinSchema,
  FIELDS,
  FIELD_BY_KEY,
  isEmpty,
  parseValue,
} from "../src/gym/checkin.js";
import { gt, GYM_CATALOGS } from "../src/gym/text.js";

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

// A full check-in. Everything except the date is nullable, so this is the
// maximal case rather than the minimal one.
function checkin(overrides = {}) {
  return {
    date: "2026-08-22",
    bodyweight_kg: 82.5,
    nutrition: 4,
    hydration: 3,
    exercise: 5,
    sleep_hours: 7,
    steps: 8200,
    off_plan: null,
    discomfort: null,
    ...overrides,
  };
}

console.log("\nA check-in is accepted:");

check("a full one", () => {
  const r = CheckinSchema.parse(checkin());
  assert.equal(r.bodyweight_kg, 82.5);
  assert.equal(r.steps, 8200);
});

check("weight only — the before-breakfast case", () => {
  // The sheet is full of blank cells. Somebody who steps on the scale and
  // nothing else must be able to send just that.
  const r = CheckinSchema.parse(
    checkin({
      nutrition: null, hydration: null, exercise: null,
      sleep_hours: null, steps: null,
    })
  );
  assert.equal(r.bodyweight_kg, 82.5);
});

check("the two free-text fields carry any script", () => {
  const r = CheckinSchema.parse(
    checkin({ off_plan: "2 સમોસા", discomfort: "ઘૂંટણમાં દુખાવો" })
  );
  assert.equal(r.off_plan, "2 સમોસા");
});

check("half hours survive", () => {
  assert.equal(CheckinSchema.parse(checkin({ sleep_hours: 7.5 })).sleep_hours, 7.5);
});

console.log("\nThe sheet's dropdown cannot show these, so neither do we:");

check("a compliance score above 5 is rejected", () => {
  for (const field of ["nutrition", "hydration", "exercise"]) {
    assert.equal(
      CheckinSchema.safeParse(checkin({ [field]: 7 })).success,
      false,
      `${field} accepted 7`
    );
  }
});

check("a compliance score of 0 is rejected", () => {
  // Not pedantry: 0 would read on the sheet as the worst possible day, when
  // what it really means is that the message never mentioned it. That case is
  // null, and null is a different cell.
  assert.equal(CheckinSchema.safeParse(checkin({ nutrition: 0 })).success, false);
});

check("a fractional compliance score is rejected", () => {
  assert.equal(CheckinSchema.safeParse(checkin({ exercise: 4.5 })).success, false);
});

console.log("\nNumbers that would be nonsense in the sheet:");

check("a negative or zero bodyweight is rejected", () => {
  assert.equal(CheckinSchema.safeParse(checkin({ bodyweight_kg: 0 })).success, false);
  assert.equal(CheckinSchema.safeParse(checkin({ bodyweight_kg: -80 })).success, false);
});

check("a bodyweight in pounds-shaped numbers is rejected", () => {
  // 182 lb unconverted is still a plausible-looking number; 500 is not. The
  // cap catches the model forgetting to convert entirely.
  assert.equal(CheckinSchema.safeParse(checkin({ bodyweight_kg: 500 })).success, false);
});

check("more than 24 hours of sleep is rejected", () => {
  assert.equal(CheckinSchema.safeParse(checkin({ sleep_hours: 30 })).success, false);
});

check("fractional steps are rejected", () => {
  assert.equal(CheckinSchema.safeParse(checkin({ steps: 8200.5 })).success, false);
});

check("a string where a number belongs is rejected", () => {
  // The model is told to send numbers. "82.5kg" as a string would reach the
  // sheet as text and silently break the AVERAGES row that sums the column.
  assert.equal(CheckinSchema.safeParse(checkin({ bodyweight_kg: "82.5" })).success, false);
  assert.equal(CheckinSchema.safeParse(checkin({ steps: "8200" })).success, false);
});

check("an empty free-text string is rejected, not stored", () => {
  // "" would overwrite whatever the coach wrote in that cell with nothing.
  assert.equal(CheckinSchema.safeParse(checkin({ off_plan: "" })).success, false);
});

console.log("\nThe date is ours, not the model's:");

check("a missing date is rejected", () => {
  const { date, ...noDate } = checkin();
  assert.equal(CheckinSchema.safeParse(noDate).success, false);
});

check("a non-ISO date is rejected", () => {
  // The date is the key the sheet row is found by. "27 July" would match
  // nothing, and "08/22/2026" would match the wrong day in a d/m sheet.
  for (const bad of ["27 July", "22/08/2026", "2026-8-22", "today"]) {
    assert.equal(
      CheckinSchema.safeParse(checkin({ date: bad })).success,
      false,
      `"${bad}" was accepted`
    );
  }
});

console.log("\nNothing to record:");

check("all-null is recognised as empty", () => {
  const blank = { date: "2026-08-22" };
  for (const { key } of FIELDS) blank[key] = null;
  assert.equal(isEmpty(CheckinSchema.parse(blank)), true);
});

check("one field is not empty", () => {
  assert.equal(isEmpty(CheckinSchema.parse(checkin({ steps: null }))), false);
});

check("isEmpty covers every field", () => {
  // Add a ninth field to the schema and forget FIELDS, and a check-in
  // containing only that field would be reported as nothing to record.
  const shape = Object.keys(CheckinSchema.shape).filter((k) => k !== "date");
  assert.deepEqual(
    shape.sort(),
    FIELDS.map((f) => f.key).sort(),
    "FIELDS and the schema have drifted apart"
  );
});

console.log("\nTyped replies are parsed without an AI call:");

// A reply to "Bodyweight?" is one number. Spending a model round trip on it
// would be slower AND less predictable than a regex — the free-text /gym path
// is where a whole sentence genuinely needs pulling apart.

const parse = (key, text) => parseValue(FIELD_BY_KEY[key], text);

check("a plain number", () => {
  assert.deepEqual(parse("bodyweight_kg", "82.5"), { ok: true, value: 82.5 });
});

check("the unit is ignored if they type it", () => {
  assert.deepEqual(parse("bodyweight_kg", "82.5 kg"), { ok: true, value: 82.5 });
});

check("a comma decimal, as half of India writes it", () => {
  assert.deepEqual(parse("bodyweight_kg", "82,5"), { ok: true, value: 82.5 });
});

check("hours and minutes are not a decimal", () => {
  // "7h30" is half past seven, not seven point three. Reading it as 7.3 would
  // be wrong by twelve minutes every night and never look wrong.
  assert.deepEqual(parse("sleep_hours", "7h30"), { ok: true, value: 7.5 });
  assert.deepEqual(parse("sleep_hours", "6:45"), { ok: true, value: 6.75 });
});

check("a decimal hour still works", () => {
  assert.deepEqual(parse("sleep_hours", "7.5"), { ok: true, value: 7.5 });
});

check("thousands, however they are written", () => {
  assert.deepEqual(parse("steps", "8200"), { ok: true, value: 8200 });
  assert.deepEqual(parse("steps", "8,200"), { ok: true, value: 8200 });
  assert.deepEqual(parse("steps", "8.2k"), { ok: true, value: 8200 });
});

check("text fields are taken as written, in any script", () => {
  assert.deepEqual(parse("off_plan", "2 સમોસા"), { ok: true, value: "2 સમોસા" });
});

check("nonsense is refused, not guessed at", () => {
  assert.equal(parse("bodyweight_kg", "abc").ok, false);
  assert.equal(parse("steps", "").ok, false);
  assert.equal(parse("off_plan", "   ").ok, false);
});

check("the schema's ranges still apply to a typed value", () => {
  // The same guard the AI path gets. A typed 500 kg is refused exactly as a
  // hallucinated one is — the check lives in one place.
  assert.equal(parse("bodyweight_kg", "500").reason, "OUT_OF_RANGE");
  assert.equal(parse("sleep_hours", "30").reason, "OUT_OF_RANGE");
});

check("a typed step count is rounded to an integer", () => {
  assert.deepEqual(parse("steps", "8200.7"), { ok: true, value: 8201 });
});

console.log("\nThe menu's field table:");

check("every field says how its value is entered", () => {
  for (const field of FIELDS) {
    assert.ok(
      ["score", "number", "text"].includes(field.input),
      `${field.key} has no input type`
    );
    assert.ok(field.icon, `${field.key} has no icon`);
  }
});

check("the three 1-5 fields are the score fields", () => {
  // They are buttons precisely because the sheet has dropdowns there. If this
  // drifts, the menu offers a keyboard where the coach expects one of five.
  assert.deepEqual(
    FIELDS.filter((f) => f.input === "score").map((f) => f.key).sort(),
    ["exercise", "hydration", "nutrition"]
  );
});

check("FIELD_BY_KEY covers every field", () => {
  assert.equal(Object.keys(FIELD_BY_KEY).length, FIELDS.length);
});

console.log("\nStrings:");

check("all three catalogs have identical keys", () => {
  // Same guarantee tests/i18n.test.js gives the bookkeeping catalogs. gt()
  // falls back to English twice, which is what lets a translation lag — and
  // is also what makes a forgotten one invisible at runtime.
  const en = Object.keys(GYM_CATALOGS.en).sort();

  for (const language of ["hi", "gu"]) {
    assert.deepEqual(
      Object.keys(GYM_CATALOGS[language]).sort(),
      en,
      `${language} has drifted from en`
    );
  }
});

check("every field's label exists in all three", () => {
  for (const { label } of FIELDS) {
    for (const language of ["en", "hi", "gu"]) {
      assert.notEqual(
        GYM_CATALOGS[language][`gym.${label}`],
        undefined,
        `gym.${label} missing from ${language}`
      );
    }
  }
});

check("every typed field has a hint and a placeholder", () => {
  // The reply box is the only instruction the user gets. A missing hint shows
  // the raw key, which is how "gym.hint.steps" ends up on somebody's screen.
  for (const field of FIELDS) {
    if (field.input === "score") continue;

    for (const language of ["en", "hi", "gu"]) {
      for (const prefix of ["hint", "ph"]) {
        assert.notEqual(
          GYM_CATALOGS[language][`gym.${prefix}.${field.label}`],
          undefined,
          `gym.${prefix}.${field.label} missing from ${language}`
        );
      }
    }
  }
});

check("no translation was left as a copy of the English", () => {
  for (const language of ["hi", "gu"]) {
    for (const [key, value] of Object.entries(GYM_CATALOGS[language])) {
      // These name env vars or are numeric examples, so they stay ASCII.
      if (key === "gym.notConfigured") continue;
      if (key === "gym.blank") continue;
      if (key.startsWith("gym.ph.") && /^[\d.hk]+$/.test(value)) continue;
      assert.notEqual(value, GYM_CATALOGS.en[key], `${language} ${key} is untranslated`);
    }
  }
});

check("placeholders match across languages", () => {
  const names = (text) => (text.match(/\{(\w+)\}/g) ?? []).sort().join(",");

  for (const [key, value] of Object.entries(GYM_CATALOGS.en)) {
    for (const language of ["hi", "gu"]) {
      assert.equal(
        names(GYM_CATALOGS[language][key]),
        names(value),
        `${language} ${key} has different placeholders`
      );
    }
  }
});

check("gt fills placeholders and falls back to English", () => {
  assert.match(gt("en", "gym.noRow", { date: "2026-08-22" }), /2026-08-22/);
  assert.equal(gt("fr", "gym.saved"), GYM_CATALOGS.en["gym.saved"]);
  assert.equal(gt("en", "gym.nonexistent"), "gym.nonexistent");
});

console.log(`\n${passed} checks passed`);
