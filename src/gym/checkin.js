import { z } from "zod";

import { askGym } from "./ai.js";

// The daily gym check-in: one message in, one row of a coach's spreadsheet out.
//
// This is NOT bookkeeping and shares nothing with it. A transaction requires a
// positive `amount` and a cash direction; a check-in has neither, and putting
// "nutrition compliance 4" in an amount column would be exactly the mistake
// migration 006 was written to undo.

// The eight fields on the Check In Tracker, in the order the card shows them.
//
// One table rather than a list beside a label map, for the same reason the
// onboarding TOUR pairs each feature with its handler: a field can never gain
// a row on the card without a label, or a label with no row.
//
// `column` is text the Apps Script matches against the sheet's OWN header, not
// a column letter. The tracker is a merged-cell grid with week blocks and
// AVERAGES rows between them, so any hardcoded A1 range breaks the first time
// the coach inserts a row.
//
// `unit` is appended on the card only. The sheet gets the bare number, because
// the coach's columns already say KG and the averages row has to add them up.
// `input` is how the menu collects the value:
//   score  -> five buttons, 1-5. Matches the coach's dropdown exactly, so
//             there is nothing to type and nothing to get out of range.
//   number -> a force-reply, parsed here.
//   text   -> a force-reply, taken as written.
export const FIELDS = [
  { key: "bodyweight_kg", label: "bodyweight", column: "BODYWEIGHT",           unit: " kg", input: "number", icon: "⚖️" },
  { key: "sleep_hours",   label: "sleep",      column: "Quantity of Sleep",    unit: "h",   input: "number", icon: "😴" },
  { key: "steps",         label: "steps",      column: "Steps",                unit: "",    input: "number", icon: "👟" },
  { key: "off_plan",      label: "offPlan",    column: "Off Plan Meal",        unit: "",    input: "text",   icon: "🍔" },
  { key: "discomfort",    label: "discomfort", column: "discomfort",           unit: "",    input: "text",   icon: "🤕" },
  { key: "nutrition",     label: "nutrition",  column: "Nutrition Compliance", unit: "/5",  input: "score",  icon: "🥗" },
  { key: "hydration",     label: "hydration",  column: "Hydration",            unit: "/5",  input: "score",  icon: "💧" },
  { key: "exercise",      label: "exercise",   column: "Exercise Compliance",  unit: "/5",  input: "score",  icon: "🏃" },
];

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// Turns one typed reply into a value for one field.
//
// No AI call: a reply to "Bodyweight?" is one number, and spending a model
// round trip on it would be slower AND less predictable than a regex. The
// free-text /gym path still uses the model, because that is where a whole
// sentence has to be pulled apart.
//
// Returns { ok, value } or { ok: false, reason }.
export function parseValue(field, text) {
  const raw = String(text ?? "").trim();

  if (!raw) return { ok: false, reason: "EMPTY" };

  if (field.input === "text") {
    return { ok: true, value: raw.slice(0, 500) };
  }

  let value;

  if (field.key === "sleep_hours") {
    // "7h30" and "7:30" are half past seven, not seven point thirty.
    const hm = raw.match(/^(\d{1,2})\s*[h:]\s*(\d{1,2})$/i);

    value = hm
      ? Number(hm[1]) + Number(hm[2]) / 60
      : Number.parseFloat(raw.replace(/[^\d.]/g, ""));
  } else if (field.key === "steps") {
    // "8.2k" is eight thousand two hundred.
    const k = raw.match(/^([\d.]+)\s*k$/i);

    // Only separators are stripped, NOT the decimal point. Removing every
    // non-digit turned "8200.7" into 82007 — a tenfold error that looks like
    // a perfectly ordinary step count.
    value = k
      ? Number.parseFloat(k[1]) * 1000
      : Number.parseFloat(raw.replace(/[,\s]/g, ""));
  } else {
    // "82.5", "82.5 kg", "82,5" all mean the same number.
    value = Number.parseFloat(raw.replace(",", ".").replace(/[^\d.]/g, ""));
  }

  if (!Number.isFinite(value)) return { ok: false, reason: "NOT_A_NUMBER" };

  // The same schema the AI path is held to, applied to this one field — so a
  // typed 500 kg is refused in exactly the way a hallucinated one is.
  const single = CheckinSchema.shape[field.key].safeParse(
    field.key === "steps" ? Math.round(value) : value
  );

  if (!single.success) return { ok: false, reason: "OUT_OF_RANGE" };

  return { ok: true, value: single.data };
}

// EVERY field is nullable except the date — the opposite of the transaction
// schema, and deliberate. The sheet has blank cells all over it, and somebody
// who only knows their weight before breakfast should be able to send just
// that. A missing field writes nothing rather than failing.
//
// The ranges are not decoration. The three compliance columns are 1-5
// dropdowns in the sheet: a 7 would be rejected there, and a 0 would read as a
// terrible day rather than as no answer. Refusing here means the user is told,
// instead of the sheet silently holding a value it cannot display.
export const CheckinSchema = z.object({
  // Machine format, YYYY-MM-DD. It is the key the sheet row is found by.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  bodyweight_kg: z.number().positive().max(400).nullable(),

  nutrition: z.number().int().min(1).max(5).nullable(),
  hydration: z.number().int().min(1).max(5).nullable(),
  exercise: z.number().int().min(1).max(5).nullable(),

  sleep_hours: z.number().min(0).max(24).nullable(),
  steps: z.number().int().min(0).max(200000).nullable(),

  // The two free-text columns, written in the user's own language. The coach
  // reads these; no code ever does.
  off_plan: z.string().min(1).nullable(),
  discomfort: z.string().min(1).nullable(),
});

// True when nothing worth writing came back. Every field null means the
// message was not a check-in at all — a greeting, or a transaction typed into
// the wrong command. Better to say so than to touch the sheet.
export function isEmpty(checkin) {
  return FIELDS.every(({ key }) => checkin[key] === null);
}

// Terse on purpose: it ships with every check-in, and the free tier's daily
// token budget is the binding limit for the whole bot.
function buildPrompt(today, aiLanguage) {
  const writeIn = aiLanguage
    ? `\nWrite "off_plan" and "discomfort" in ${aiLanguage}.\n`
    : "";

  return `
Daily fitness check-in for one person. Turn their message into ONE JSON object.

Return ONLY JSON, exactly these keys, null for anything not mentioned:
{"date":"YYYY-MM-DD","bodyweight_kg":number|null,"nutrition":1-5|null,
 "hydration":1-5|null,"exercise":1-5|null,"sleep_hours":number|null,
 "steps":integer|null,"off_plan":string|null,"discomfort":string|null}

nutrition, hydration and exercise are COMPLIANCE SCORES out of 5 — how well
they stuck to the plan that day. "nutrition 4", "diet 4/5", "khavanu 4" are
all 4. A weight is never a score and a score is never a weight.

bodyweight_kg is always KILOGRAMS. Convert pounds (1 lb = 0.4536 kg).
sleep_hours is a number: "7h30", "saade saat", "7.5 hours" -> 7.5.
steps is a plain integer: "8.2k", "8,200" -> 8200.
off_plan    = anything eaten off the plan ("2 samosas", "cheat meal").
discomfort  = any physical complaint ("knee pain", "constipation", "hungry").

NEVER invent a number. Anything the message does not say is null.
No date mentioned -> use ${today}.
${writeIn}
"82.5kg, nutrition 4, water 3, exercise 5, slept 7h, 8200 steps"
-> {"date":"${today}","bodyweight_kg":82.5,"nutrition":4,"hydration":3,
    "exercise":5,"sleep_hours":7,"steps":8200,"off_plan":null,"discomfort":null}

"aaj 83 kg, 2 samosa khadha, ghutan ma dukhavo"
-> {"date":"${today}","bodyweight_kg":83,"nutrition":null,"hydration":null,
    "exercise":null,"sleep_hours":null,"steps":null,
    "off_plan":"2 samosa","discomfort":"ghutan ma dukhavo"}
`;
}

// Reads one check-in message and validates what comes back.
//
// Returns { ok: true, checkin } or { ok: false, reason }. Reasons rather than
// throws for the expected failures, matching confirmMessageTransaction: a
// message that is not a check-in is an answer, not an exception.
export async function parseCheckin(messageText, today, aiLanguage = null) {
  const reply = await askGym(messageText, buildPrompt(today, aiLanguage));

  let parsed;

  try {
    // A model told to return one object occasionally returns a list of one.
    parsed = [JSON.parse(reply)].flat()[0];
  } catch {
    return { ok: false, reason: "NOT_JSON" };
  }

  // The date is OURS, not the model's. It is the key the sheet row is found
  // by, so a hallucinated one would overwrite a different day.
  const result = CheckinSchema.safeParse({ ...parsed, date: today });

  if (!result.success) {
    return { ok: false, reason: "INVALID", issues: result.error.issues };
  }

  if (isEmpty(result.data)) {
    return { ok: false, reason: "NOTHING_TO_RECORD" };
  }

  return { ok: true, checkin: result.data };
}
