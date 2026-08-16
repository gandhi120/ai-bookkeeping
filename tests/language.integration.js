// Integration test against the REAL database, exercising the REAL functions.
//
//   npm run test:lang
//
// Creates two throwaway users, moves their language around, then deletes
// everything it created. Existing data is never touched.
//
// tests/i18n.test.js already covers the catalogs and the helpers, but every
// check in it is pure — it never opens a connection. This suite covers the
// half that lives in Postgres: the users.language column, the CHECK
// constraint, and the rule the whole language picker rests on, that NULL
// means "has not chosen yet".
//
// The two checks that matter most are the ones proving what must NOT change
// it. findOrCreateUser runs on every single message and finishOnboarding
// rewrites the same row — either could quietly reset a user's language, and
// the symptom would be the picker reappearing mid-use with no error anywhere.

import "dotenv/config";

import { pool } from "../src/database/pool.js";
import { findOrCreateUser, setUserLanguage } from "../src/database/users.js";
import {
  createWorkspace,
  setActiveWorkspace,
  getActiveWorkspace,
} from "../src/database/workspaces.js";
import { createMessage } from "../src/database/messages.js";
import { finishOnboarding } from "../src/database/onboarding.js";

import { LANGUAGES } from "../src/i18n/index.js";

const A_TG = 999000301;
const B_TG = 999000302;

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

// Reads the language straight from the table, bypassing every helper. Used
// wherever the question is "what is actually stored", not "what did the
// function return".
async function storedLanguage(userId) {
  const result = await pool.query("SELECT language FROM users WHERE id = $1", [
    userId,
  ]);

  return result.rows[0]?.language;
}

let userA;
let userB;

try {
  // ------------------------------------------------------------------
  // The migration is actually applied
  // ------------------------------------------------------------------
  //
  // First, because every check below is meaningless on a database that never
  // ran 004. tests/i18n.test.js compares the migration's FILE TEXT against
  // LANGUAGES, which a database that never ran it passes happily.
  console.log("\n--- MIGRATION 004 IS APPLIED ---");

  const column = (
    await pool.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'language'`
    )
  ).rows[0];

  check("users.language exists", Boolean(column), true);
  check("it is text", column?.data_type, "text");
  check("it is nullable — NULL is the 'not chosen yet' state", column?.is_nullable, "YES");

  // A default would make a brand-new user indistinguishable from one who
  // deliberately chose English, and the picker would never be shown.
  check("it has NO default", column?.column_default, null);

  const constraintSql = (
    await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%language%'`
    )
  ).rows[0]?.def;

  check("a CHECK constraint guards it", Boolean(constraintSql), true);

  // The constraint and LANGUAGES are the same list written in two files.
  const allowed = [...(constraintSql ?? "").matchAll(/'(\w+)'/g)]
    .map((match) => match[1])
    .sort();

  check("and it allows exactly the offered languages", allowed, Object.keys(LANGUAGES).sort());

  // ------------------------------------------------------------------
  // NULL is the gate
  // ------------------------------------------------------------------
  console.log("\n--- A NEW USER HAS NO LANGUAGE ---");

  userA = await findOrCreateUser({
    telegram_user_id: A_TG,
    telegram_chat_id: A_TG,
    first_name: "LangA",
    username: "langa",
  });

  userB = await findOrCreateUser({
    telegram_user_id: B_TG,
    telegram_chat_id: B_TG,
    first_name: "LangB",
    username: "langb",
  });

  // This single fact is what puts the picker in front of a new user.
  check("a brand new user's language is NULL", userA.language, null);

  // resolveShopkeeper hands this row to every handler, which is why reading
  // the language costs no extra query — but only if it is actually on it.
  check("the row carries a `language` key at all", "language" in userA, true);

  console.log("\n--- SETTING IT ---");

  const setA = await setUserLanguage(userA.id, "gu");

  check("setUserLanguage returns the updated row", setA?.language, "gu");
  check("and it persisted, not just returned", await storedLanguage(userA.id), "gu");

  const setAgain = await setUserLanguage(userA.id, "hi");

  check("changing it again works", await storedLanguage(userA.id), "hi");
  check("the returned row agrees", setAgain?.language, "hi");

  // ------------------------------------------------------------------
  // The guard holds at both layers
  // ------------------------------------------------------------------
  console.log("\n--- A FORGED LANGUAGE IS REFUSED ---");

  // callback_data comes from the user's Telegram client, so `lang:fr` is a
  // thing somebody can send. isLanguage() refuses before any SQL runs.
  const forged = await setUserLanguage(userA.id, "fr");

  check("setUserLanguage returns undefined for an unknown code", forged, undefined);
  check("and the stored language is untouched", await storedLanguage(userA.id), "hi");

  check(
    "SQL injection in the code is refused the same way",
    await setUserLanguage(userA.id, "en'; DROP TABLE users; --"),
    undefined
  );

  // The application guard is the first line; the constraint is the second.
  // Proving it is real rather than decoration means going around the helper.
  let constraintCode = null;

  try {
    await pool.query("UPDATE users SET language = 'fr' WHERE id = $1", [userA.id]);
  } catch (error) {
    constraintCode = error.code;
  }

  check("the database itself rejects an unlisted language", constraintCode, "23514");
  check("and the row survived that attempt unchanged", await storedLanguage(userA.id), "hi");

  // ------------------------------------------------------------------
  // Nothing else clobbers it
  // ------------------------------------------------------------------
  //
  // The two live hazards. Both of these functions rewrite the users row for
  // reasons that have nothing to do with language, and if either took the
  // language with it, the symptom would be the picker reappearing mid-use
  // with no error logged anywhere.
  console.log("\n--- NOTHING ELSE RESETS IT ---");

  // findOrCreateUser runs on EVERY message. Its ON CONFLICT DO UPDATE touches
  // telegram_chat_id, first_name and username — adding `language` to that
  // list, or switching the whole thing to EXCLUDED.*, would send every user
  // back to the picker on their next message.
  const returning = await findOrCreateUser({
    telegram_user_id: A_TG,
    telegram_chat_id: A_TG,
    first_name: "LangA Renamed",
    username: "langa2",
  });

  check("findOrCreateUser still updates the name", returning.first_name, "LangA Renamed");
  check("but LEAVES THE LANGUAGE ALONE", returning.language, "hi");

  // finishOnboarding sets onboarding_done_at in the same transaction that
  // deletes practice rows. Same exposure.
  const workspaceA = await createWorkspace(userA.id, "Lang Shop", "shopkeeper");

  await setActiveWorkspace(userA.id, workspaceA.id);

  await createMessage({
    user_id: userA.id,
    workspace_id: workspaceA.id,
    telegram_message_id: 970001,
    message_text: "practice entry",
    status: "RECEIVED",
    is_onboarding: true,
  });

  await finishOnboarding(userA.id, { clear: true });

  check("finishOnboarding LEAVES THE LANGUAGE ALONE", await storedLanguage(userA.id), "hi");

  // The workspace read is on the same row, and is what every handler calls
  // right after resolving the user.
  check(
    "the workspace still resolves afterwards",
    (await getActiveWorkspace(userA.id))?.id,
    workspaceA.id
  );

  // ------------------------------------------------------------------
  // It is per user, not global
  // ------------------------------------------------------------------
  console.log("\n--- ONE LANGUAGE PER PERSON ---");

  await setUserLanguage(userB.id, "gu");

  check("B is Gujarati", await storedLanguage(userB.id), "gu");
  check("A is still Hindi", await storedLanguage(userA.id), "hi");

  await setUserLanguage(userA.id, "en");

  check("changing A does not move B", await storedLanguage(userB.id), "gu");
  check("B never had a language forced on it by A's setup", userB.language, null);
} finally {
  console.log("\n--- CLEANUP ---");

  for (const user of [userA, userB]) {
    if (!user) continue;

    await pool.query("DELETE FROM transactions WHERE user_id=$1", [user.id]);
    await pool.query("DELETE FROM messages WHERE user_id=$1", [user.id]);
    await pool.query("DELETE FROM customers WHERE user_id=$1", [user.id]);
    // users.active_workspace_id points AT workspaces, so it has to let go
    // before the workspace row can be deleted.
    await pool.query("UPDATE users SET active_workspace_id=NULL WHERE id=$1", [
      user.id,
    ]);
    await pool.query("DELETE FROM workspaces WHERE user_id=$1", [user.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [user.id]);
  }

  const left = (
    await pool.query(
      "SELECT COUNT(*)::int c FROM users WHERE telegram_user_id IN ($1,$2)",
      [A_TG, B_TG]
    )
  ).rows[0].c;

  console.log(`  test users remaining: ${left} (should be 0)`);

  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
