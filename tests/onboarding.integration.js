// Integration test against the REAL database, exercising the REAL functions.
//
//   npm run test:onb
//
// Creates two throwaway users, runs a full onboarding for each, then deletes
// everything it created. Existing data is never touched.
//
// This is the suite that guards the only destructive code path in src/.
// finishOnboarding() is the one function that can delete a user's rows, so the
// checks that matter most here are the ones proving what it must NOT remove:
// the other user's data, the workspace, and anything not flagged as practice.

import "dotenv/config";

import {
  pool,
  findOrCreateUser,
  createMessage,
  updateMessageStatus,
  updateMessageTransactionData,
  confirmMessageTransaction,
  countOnboardingTransactions,
  finishOnboarding,
  getCustomerByName,
  getCustomerBalance,
  getTransactionsByDate,
  createWorkspace,
  setActiveWorkspace,
  getActiveWorkspace,
} from "../src/database/postgres.js";

const A_TG = 999000101;
const B_TG = 999000102;
const TODAY = new Date().toLocaleDateString("en-CA", {
  timeZone: "Asia/Kolkata",
});

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

// Reads the onboarding flag straight off the users row, the same value
// isOnboarding() in bot.js branches on.
async function onboardingDoneAt(userId) {
  const result = await pool.query(
    "SELECT onboarding_done_at FROM users WHERE id = $1",
    [userId]
  );

  return result.rows[0].onboarding_done_at;
}

async function messageCount(userId, onboardingOnly) {
  const result = await pool.query(
    `SELECT count(*)::int AS c FROM messages WHERE user_id = $1${
      onboardingOnly ? " AND is_onboarding" : ""
    }`,
    [userId]
  );

  return result.rows[0].c;
}

// Pushes one transaction through the real confirmation flow, exactly as the
// bot does: save the message with its onboarding flag, move it through the
// status lifecycle, then confirm it.
async function submitAndConfirm(user, workspace, msgId, transaction, isOnboarding) {
  const saved = await createMessage({
    user_id: user.id,
    workspace_id: workspace.id,
    telegram_message_id: msgId,
    message_text: transaction.description,
    status: "RECEIVED",
    is_onboarding: isOnboarding,
  });

  await updateMessageStatus(saved.id, "PROCESSING");
  await updateMessageTransactionData(saved.id, {
    ...transaction,
    telegram_message_id: msgId,
  });
  await updateMessageStatus(saved.id, "PENDING_CONFIRMATION");

  await confirmMessageTransaction(saved.id, user.id, null);

  return saved;
}

function txn(type, person, amount, description) {
  return {
    transaction_type: type,
    description,
    category: "test",
    quantity: 1,
    amount,
    person,
    transaction_date: TODAY,
    notes: null,
  };
}

const userA = await findOrCreateUser({
  telegram_user_id: A_TG,
  telegram_chat_id: A_TG,
  first_name: "OnbA",
  username: "onb_a",
});

const userB = await findOrCreateUser({
  telegram_user_id: B_TG,
  telegram_chat_id: B_TG,
  first_name: "OnbB",
  username: "onb_b",
});

const SHOP = {};

try {
  for (const u of [userA, userB]) {
    SHOP[u.id] = await createWorkspace(u.id, "My Shop", "shopkeeper");
    await setActiveWorkspace(u.id, SHOP[u.id].id);
  }

  // A findOrCreateUser upsert must not stamp onboarding as finished — a brand
  // new user has to land in the tutorial.
  console.log("\n--- 1. a new user starts out onboarding ---");
  check("user A has not finished onboarding", await onboardingDoneAt(userA.id), null);
  check("user B has not finished onboarding", await onboardingDoneAt(userB.id), null);

  // --------------------------------------------------
  // User A: practises, then clears.
  // --------------------------------------------------
  console.log("\n--- 2. practice entries are flagged ---");

  await submitAndConfirm(
    userA,
    SHOP[userA.id],
    910001,
    txn("purchase", null, 600, "Bought 10 kg rice"),
    true
  );

  // A practice udhaar entry opens a khata, which is the case that makes the
  // cleanup more than a single DELETE.
  await submitAndConfirm(
    userA,
    SHOP[userA.id],
    910002,
    txn("credit_sale", "PracticeRaj", 2000, "Raj took goods on udhaar"),
    true
  );

  check("A has 2 onboarding messages", await messageCount(userA.id, true), 2);
  check("A's practice khata exists", Boolean(await getCustomerByName(userA.id, "PracticeRaj")), true);

  const practiceRaj = await getCustomerByName(userA.id, "PracticeRaj");
  check("A's practice khata shows the debt", await getCustomerBalance(userA.id, practiceRaj.id), 2000);

  // The number shown in the "clear this?" question has to be the number that
  // actually disappears, or the user is agreeing to something else.
  console.log("\n--- 3. the count matches what gets deleted ---");
  const countedBefore = await countOnboardingTransactions(userA.id);
  check("A has 2 practice transactions", countedBefore, 2);

  // --------------------------------------------------
  // User B: practises too, and must be untouched by A's cleanup.
  // --------------------------------------------------
  await submitAndConfirm(
    userB,
    SHOP[userB.id],
    920001,
    txn("sale", null, 999, "B's own entry"),
    true
  );

  console.log("\n--- 4. clearing removes exactly the practice data ---");
  const cleared = await finishOnboarding(userA.id, { clear: true });

  check("reported transactions deleted", cleared.transactions, countedBefore);
  check("reported it cleared", cleared.cleared, true);
  check("A has no transactions left", (await getTransactionsByDate(userA.id, SHOP[userA.id].id, TODAY)).length, 0);
  check("A has no messages left", await messageCount(userA.id, false), 0);
  check("A's practice khata is gone", await getCustomerByName(userA.id, "PracticeRaj"), undefined);
  check("A is marked onboarded", Boolean(await onboardingDoneAt(userA.id)), true);

  // The workspace is what onboarding CREATED. Deleting it would undo the one
  // thing the user actually accomplished.
  console.log("\n--- 5. what must survive ---");
  check("A's workspace survives", Boolean(await getActiveWorkspace(userA.id)), true);
  check("A's user row survives", Boolean(await findOrCreateUser({ telegram_user_id: A_TG, telegram_chat_id: A_TG, first_name: "OnbA", username: "onb_a" })), true);

  // The check that must never fail.
  console.log("\n--- 6. the other user is untouched (isolation) ---");
  check("B still has their transaction", (await getTransactionsByDate(userB.id, SHOP[userB.id].id, TODAY)).length, 1);
  check("B still has their message", await messageCount(userB.id, false), 1);
  check("B is still onboarding", await onboardingDoneAt(userB.id), null);

  // --------------------------------------------------
  // After onboarding: new messages are real data.
  // --------------------------------------------------
  console.log("\n--- 7. post-onboarding messages are not practice ---");
  await submitAndConfirm(
    userA,
    SHOP[userA.id],
    910003,
    txn("sale", null, 1500, "A real sale"),
    false
  );

  check("A's real message is not flagged", await messageCount(userA.id, true), 0);
  check("A's real transaction exists", (await getTransactionsByDate(userA.id, SHOP[userA.id].id, TODAY)).length, 1);

  // Re-running the cleanup must not touch data that was never practice.
  console.log("\n--- 8. finishing twice is harmless ---");
  const again = await finishOnboarding(userA.id, { clear: true });
  check("nothing left to delete", again.transactions, 0);
  check("A's real transaction survives", (await getTransactionsByDate(userA.id, SHOP[userA.id].id, TODAY)).length, 1);

  // --------------------------------------------------
  // User B chooses to keep their practice entry.
  // --------------------------------------------------
  console.log("\n--- 9. 'Keep it' deletes nothing ---");
  const kept = await finishOnboarding(userB.id, { clear: false });

  check("reported it did not clear", kept.cleared, false);
  check("reported no deletions", kept.transactions, 0);
  check("B keeps their transaction", (await getTransactionsByDate(userB.id, SHOP[userB.id].id, TODAY)).length, 1);
  check("B keeps their message", await messageCount(userB.id, false), 1);
  check("B is marked onboarded", Boolean(await onboardingDoneAt(userB.id)), true);

  // Flags are cleared on the keep path so a later call can never delete rows
  // the user explicitly chose to keep.
  check("B's kept message is no longer flagged", await messageCount(userB.id, true), 0);

  const keptAgain = await finishOnboarding(userB.id, { clear: true });
  check("a later clear cannot touch kept data", keptAgain.transactions, 0);
  check("B still has their transaction", (await getTransactionsByDate(userB.id, SHOP[userB.id].id, TODAY)).length, 1);

  console.log(`\n${passed} passed, ${failed} failed\n`);
} finally {
  // Same order as the other suites: leaves first, then the upward FK from
  // users to workspaces is released, then the roots.
  console.log("--- CLEANUP ---");

  for (const u of [userA, userB]) {
    await pool.query("DELETE FROM transactions WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM messages WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM customers WHERE user_id=$1", [u.id]);
    // users.active_workspace_id points AT workspaces, so it has to let go
    // before the workspace row can be deleted.
    await pool.query("UPDATE users SET active_workspace_id=NULL WHERE id=$1", [u.id]);
    await pool.query("DELETE FROM workspaces WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [u.id]);
  }

  const left = (
    await pool.query(
      "SELECT COUNT(*)::int c FROM users WHERE telegram_user_id IN ($1,$2)",
      [A_TG, B_TG]
    )
  ).rows[0].c;

  console.log(`  test users remaining: ${left} (should be 0)`);

  const total = (await pool.query("SELECT COUNT(*)::int c FROM transactions")).rows[0].c;

  console.log(`  transactions table back to: ${total} rows`);

  await pool.end();
}

process.exit(failed ? 1 : 0);
