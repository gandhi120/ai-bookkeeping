import { FIELDS } from "./checkin.js";

// Sends one check-in to the Apps Script that writes it into the coach's sheet.
//
// The script does ALL the work: finding today's row, matching each value to a
// column, handling the merged-cell grid. See src/gym/Checkin.gs. That is why
// this file is short — layout knowledge belongs next to the layout, where
// getDataRange() hands the script the whole thing in one call.
//
// The alternative was the Sheets API with a service account, which would mean
// a Google Cloud project, a JSON key, JWT signing, and about two hundred lines
// here reconstructing the grid from a rectangle of strings. A standalone Apps
// Script needs none of it and runs as the user, who already has edit rights.
//
// The cost, stated plainly: the deployment URL is a bearer secret. Anyone
// holding it can post. GYM_SHEET_SECRET is checked inside the script so the
// URL alone is not enough, and both live in .env — proportionate for one
// person's gym log, not for anything that matters more.

// Not read at import time. The bot's boot check in bot.js lists the variables
// it cannot start without, and these are deliberately NOT among them: a
// missing gym URL must never stop the bookkeeping bot from starting.
export function isConfigured() {
  return Boolean(process.env.GYM_SHEET_URL && process.env.GYM_SHEET_SECRET);
}

// What the script can answer, mapped to a reason the handler has words for.
// Anything unrecognised falls through to UNEXPECTED with the body attached,
// so a new script reply is visible in the logs rather than silently "fine".
const REPLIES = {
  ok: null,
  "no-tab": "NO_TAB",
  forbidden: "FORBIDDEN",
  "no-date-column": "NO_DATE_COLUMN",
  "no-row": "NO_ROW",
  "nothing-written": "NOTHING_TO_WRITE",
};

// One POST to the script, with whatever body the action needs.
async function post(payload) {
  return await fetch(process.env.GYM_SHEET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: process.env.GYM_SHEET_SECRET, ...payload }),
    // Apps Script answers /exec with a 302 to a googleusercontent.com URL that
    // carries the actual body. Node's fetch follows it correctly; saying so
    // makes it deliberate rather than a behaviour someone might "fix". (curl
    // -L downgrades the POST to a GET here and gets an error page instead —
    // worth knowing before debugging this with curl.)
    redirect: "follow",
    // Apps Script cold-starts. A hung fetch would hold the handler open until
    // Telegram gave up on the whole update.
    signal: AbortSignal.timeout(20000),
  });
}

// The last week read, kept in memory for a minute.
//
// Apps Script costs ~4 seconds a call whatever you ask it for — that is its
// per-request overhead, not the size of the read, so narrowing the range did
// not move it. The menu redraws on every tap, and without this, walking
// day -> back -> another day is twelve seconds of waiting for data that has
// not changed.
//
// ONE entry, because one person is looking at one week. A Map keyed by week
// would be the same code and more of it.
//
// Every write replaces this with what the sheet returned, so the bot's own
// changes are never stale. What the minute bounds is somebody editing the
// spreadsheet by hand while the menu is open — they see it a minute late,
// which is the right trade for making every tap instant.
const CACHE_MS = 60_000;

let cached = null;

function fromCache(date) {
  if (!cached || Date.now() - cached.at > CACHE_MS) return null;

  // Any date in the block is a hit: the menu asks by day, and a week holds
  // seven of them.
  return cached.week.days.some((day) => day.date === date) ? cached.week : null;
}

function remember(week) {
  if (week?.days?.length) cached = { week, at: Date.now() };

  return week;
}

// Drops the cache, so the next read goes to the sheet. For when something
// wrote and did NOT hand back the new state.
export function forgetWeek() {
  cached = null;
}

// Reads back the week containing `date`: its days, what is already filled for
// each, and the week's shared values.
//
// Powers the menu, which shows current values rather than a list of blanks —
// so filling in a missed day starts from what is actually there.
export async function readWeek(date, { fresh = false } = {}) {
  if (!isConfigured()) {
    return { ok: false, reason: "NOT_CONFIGURED" };
  }

  if (!fresh) {
    const hit = fromCache(date);

    if (hit) return hit;
  }

  let response;

  try {
    response = await post({ action: "read", date });
  } catch (error) {
    return { ok: false, reason: "UNREACHABLE", detail: error.message };
  }

  const body = (await response.text()).trim();

  if (!response.ok) {
    return { ok: false, reason: "HTTP", detail: `${response.status}: ${body.slice(0, 200)}` };
  }

  // The script answers a bare word on failure and JSON on success, so a
  // non-JSON body is a failure code rather than something to parse.
  if (REPLIES[body] !== undefined) {
    return { ok: false, reason: REPLIES[body] ?? "UNEXPECTED" };
  }

  try {
    return remember({ ok: true, ...JSON.parse(body) });
  } catch {
    return { ok: false, reason: "UNEXPECTED", detail: body.slice(0, 200) };
  }
}

// Returns { ok: true } or { ok: false, reason }, the same shape as
// parseCheckin and confirmMessageTransaction — expected failures are answers,
// not exceptions.
export async function writeCheckin(checkin) {
  if (!isConfigured()) {
    return { ok: false, reason: "NOT_CONFIGURED" };
  }

  // Send the sheet's own column labels alongside the values, so the script
  // never needs a copy of the field list. FIELDS in checkin.js stays the one
  // place that says what a check-in contains.
  const values = {};

  for (const { key, column } of FIELDS) {
    if (checkin[key] !== null && checkin[key] !== undefined) {
      values[column] = checkin[key];
    }
  }

  let response;

  try {
    response = await post({ date: checkin.date, values });
  } catch (error) {
    return { ok: false, reason: "UNREACHABLE", detail: error.message };
  }

  const body = (await response.text()).trim();

  if (!response.ok) {
    return {
      ok: false,
      reason: "HTTP",
      detail: `${response.status}: ${body.slice(0, 200)}`,
    };
  }

  if (body === "ok") return { ok: true };

  if (REPLIES[body]) return { ok: false, reason: REPLIES[body] };

  // A successful write answers with the refreshed week, so the caller can
  // redraw without a second round trip.
  if (body.startsWith("{")) {
    try {
      const week = remember({ ok: true, ...JSON.parse(body) });

      return { ok: true, week };
    } catch {
      /* falls through to UNEXPECTED */
    }
  }

  // Anything else means the sheet may have moved without us seeing how.
  forgetWeek();

  // A column the script could not place, named. This is what a renamed header
  // looks like, and the detail carries the exact labels that missed.
  if (body.startsWith("unmatched:")) {
    return { ok: false, reason: "UNMATCHED", detail: body.slice(10).trim() };
  }

  // Including "error: ..." thrown inside the script — a login page, a revoked
  // permission, a deployment serving stale code.
  return { ok: false, reason: "UNEXPECTED", detail: body.slice(0, 200) };
}
