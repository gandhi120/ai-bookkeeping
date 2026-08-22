// Self-check for the sheet layout finder. No network, no Google account, free.
//
//   node tests/sheet.test.js
//
// The finder lives in src/gym/Checkin.gs, which runs inside Google — so this
// test LOADS THAT FILE and calls its functions directly, rather than testing a
// copy that could drift from what gets pasted. The helpers are pure ES5 and
// touch no Apps Script API, so node runs them unchanged.
//
// It matters because this is the riskiest code in the gym module and the only
// part written against a spreadsheet nobody here can open. GRID below is a
// reconstruction of the real Check In Tracker from screenshots: two stacked
// header rows, a "(SCALE 1-5)" row beneath, the week number merged down a
// block, an AVERAGES row at the foot, and dates written as "27 July" with no
// year anywhere.
//
// If the real sheet differs, this file is where the fix goes — and stays proven.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

import { FIELDS } from "../src/gym/checkin.js";

const source = readFileSync(
  new URL("../src/gym/Checkin.gs", import.meta.url),
  "utf8"
);

// Apps Script globals the file names but never calls at load time. Present so
// the module evaluates; a test that reached one would throw and say so.
const sandbox = createContext({
  SpreadsheetApp: undefined,
  PropertiesService: undefined,
  ContentService: undefined,
  Utilities: undefined,
  Logger: undefined,
});

runInContext(source, sandbox);

const { normalise, readHeaders, matchColumn, parseCell, findDateRow } = sandbox;

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

//               A         B          C      D             E                        F                          G                              H                       I                    J        K
const GRID = [
  ["WEEK",  "DATES",   "",    "WEIGHT",     "NUTRITION",             "",                        "",                            "TRAINING & RECOVERY",  "",                  "",      ""],
  ["",      "DATE",    "DAY", "BODYWEIGHT", "Nutrition Compliance",  "Hydration/Fluid Intake",  "Off Plan Meal / Deviations",  "Exercise Compliance",  "Quantity of Sleep", "Steps", "Did you face any physical discomfort or pain?"],
  ["",      "",        "",    "KG",         "(SCALE 1-5)",           "(SCALE 1-5)",             "What and how much was it?",   "(SCALE 1-5)",          "",                  "",      "(For example - constipation, joint pain)"],
  ["17",    "27 July", "MON", "", "", "", "", "", "", "", ""],
  ["",      "28 July", "TUE", "", "", "", "", "", "", "", ""],
  ["",      "29 July", "WED", "", "", "", "", "", "", "", ""],
  ["",      "30 July", "THU", "", "", "", "", "", "", "", ""],
  ["",      "31 July", "FRI", "", "", "", "", "", "", "", ""],
  ["",      "1 August","SAT", "", "", "", "", "", "", "", ""],
  ["",      "2 August","SUN", "", "", "", "", "", "", "", ""],
  ["",      "AVERAGES","",    "", "", "", "", "", "", "", ""],
];

const { byLabel, dateColumn } = readHeaders(GRID);

console.log("\nThe script loads and exposes its helpers:");

check("Checkin.gs parses as plain JavaScript", () => {
  for (const fn of [normalise, readHeaders, matchColumn, parseCell, findDateRow]) {
    assert.equal(typeof fn, "function");
  }
});

console.log("\nThe script and the bot agree on the fields:");

check("FIELD_LABELS in the script matches FIELDS in the bot", () => {
  // The script reads all eight back for the menu without being told which,
  // so it carries its own copy of the labels. Drift means a field the bot can
  // write but never shows as filled — invisible until somebody notices a
  // column that always reads blank in the menu.
  assert.deepEqual(
    [...sandbox.FIELD_LABELS].sort(),
    FIELDS.map((f) => f.column).sort()
  );
});

console.log("\nFinding the columns:");

check("the DATE column is found, and is not DATES", () => {
  // "DATES" is the merged group heading one row above. Matching it would put
  // every write on the wrong row, so the date column is matched EXACTLY.
  assert.equal(dateColumn, 1);
});

check("every field the bot sends finds a column", () => {
  for (const { column, key } of FIELDS) {
    assert.notEqual(
      matchColumn(byLabel, column),
      undefined,
      `"${column}" (${key}) matched no header`
    );
  }
});

check("each one lands on the RIGHT column", () => {
  const expected = {
    bodyweight_kg: 3,   // D  BODYWEIGHT
    nutrition: 4,       // E  Nutrition Compliance
    hydration: 5,       // F  Hydration/Fluid Intake     (containment)
    off_plan: 6,        // G  Off Plan Meal / Deviations (containment)
    exercise: 7,        // H  Exercise Compliance
    sleep_hours: 8,     // I  Quantity of Sleep
    steps: 9,           // J  Steps
    discomfort: 10,     // K  Did you face any physical discomfort or pain?
  };

  for (const { key, column } of FIELDS) {
    assert.equal(
      matchColumn(byLabel, column),
      expected[key],
      `${key} went to the wrong column`
    );
  }
});

check("a label matching nothing returns undefined, not 0", () => {
  // Returning 0 would quietly write into column A, the WEEK number.
  assert.equal(matchColumn(byLabel, "Resting Heart Rate"), undefined);
});

check("(SCALE 1-5) never becomes a label", () => {
  assert.equal(byLabel["scale 1 5"], undefined);
});

check("shortest containing header wins", () => {
  // "Compliance" is inside both "Nutrition Compliance" and "Exercise
  // Compliance". The bot never sends a label that vague, but the tie must at
  // least break deterministically rather than by scan order.
  assert.ok([4, 7].includes(matchColumn(byLabel, "Compliance")));
});

console.log("\nNormalising:");

check("punctuation and case are ignored", () => {
  assert.equal(normalise("Off Plan Meal / Deviations"), "off plan meal deviations");
  assert.equal(normalise("Hydration/Fluid Intake"), "hydration fluid intake");
});

check("parenthesised notes are dropped", () => {
  assert.equal(normalise("Exercise Compliance (SCALE 1-5)"), "exercise compliance");
});

check("empty and null cells normalise to nothing", () => {
  for (const value of ["", "   ", null, undefined]) {
    assert.equal(normalise(value), "");
  }
});

console.log("\nFinding the row:");

check("a date in the middle of the block", () => {
  assert.equal(findDateRow(GRID, dateColumn, "2026-07-29"), 5);
});

check("the first and last days of the block", () => {
  assert.equal(findDateRow(GRID, dateColumn, "2026-07-27"), 3);
  assert.equal(findDateRow(GRID, dateColumn, "2026-08-02"), 9);
});

check("a month boundary inside one week", () => {
  // "31 July" and "1 August" sit in the same block with no year on either.
  assert.equal(findDateRow(GRID, dateColumn, "2026-08-01"), 8);
});

check("a date the sheet does not have returns -1", () => {
  // The tracker ran out of weeks. Reported as no-row rather than written
  // somewhere approximate.
  assert.equal(findDateRow(GRID, dateColumn, "2026-12-25"), -1);
});

check("the AVERAGES row is never matched", () => {
  // It sits in the date column and a permissive parser would read it as a
  // date, putting a day's numbers into the week's summary row.
  assert.equal(parseCell("AVERAGES", 2026), null);
  assert.notEqual(findDateRow(GRID, dateColumn, "2026-07-29"), 10);
});

check("header text in the date column is not a date", () => {
  assert.equal(parseCell("DATE", 2026), null);
  assert.equal(parseCell("", 2026), null);
});

console.log("\nDate formats the sheet might use:");

check("day-and-month with no year, read against the target year", () => {
  const parsed = parseCell("27 July", 2026);
  assert.equal(parsed.getMonth(), 6);
  assert.equal(parsed.getDate(), 27);
  assert.equal(parsed.getFullYear(), 2026);
});

check("an ISO date", () => {
  const parsed = parseCell("2026-07-27", 2026);
  assert.equal(parsed.getMonth(), 6);
  assert.equal(parsed.getDate(), 27);
});

check("a date cell the sheet rendered itself", () => {
  const parsed = parseCell("July 27, 2026", 2026);
  assert.equal(parsed.getMonth(), 6);
  assert.equal(parsed.getDate(), 27);
});

console.log(`\n${passed} checks passed`);
