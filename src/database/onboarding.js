import { pool } from "./pool.js";

// --------------------------------------------------
// Onboarding
// --------------------------------------------------

// Finds the practice transactions belonging to a user.
//
// A transaction carries no onboarding flag of its own: it is reached through
// the message that produced it. Since 005 one message can produce SEVERAL
// transactions, so this join fans out — which is correct for both users of
// it, because the count and the delete fan out identically: a practice
// message with three entries is counted as three and deletes three.
//
// The ::text cast is load bearing. messages.telegram_message_id is bigint
// while transactions.telegram_message_id is text — a mismatch that predates
// this feature — and Postgres will not compare the two without it.
const ONBOARDING_TRANSACTIONS_WHERE = `
  t.user_id = $1
  AND m.user_id = $1
  AND m.is_onboarding
  AND t.telegram_message_id = m.telegram_message_id::text
`;

// Counts the practice entries a user is about to delete.
//
// Shown in the "clear this?" question, and deliberately built from the same
// WHERE clause as the delete below, so the number the user is told is exactly
// the number of rows that disappear.
export async function countOnboardingTransactions(userId) {
  const result = await pool.query(
    `
    SELECT count(*)::int AS count
    FROM transactions t
    JOIN messages m ON ${ONBOARDING_TRANSACTIONS_WHERE};
    `,
    [userId]
  );

  return result.rows[0].count;
}

// Ends onboarding for a user, optionally deleting everything they entered
// while practising.
//
// THIS IS THE ONLY FUNCTION IN src/ THAT DELETES ANYTHING. Guard rails:
//   - every statement is scoped `WHERE user_id = $1`, so one user's cleanup
//     can never touch another's rows;
//   - only rows reached through `messages.is_onboarding` are removed;
//   - `users` and `workspaces` are never touched — the workspace the user
//     just created is the whole point of onboarding and must survive;
//   - it all runs in one transaction, so a failure half way leaves the
//     practice data intact rather than partly deleted.
//
// `clear: false` keeps the data and just clears the flags, so a user who
// chose to keep their first entries can never have them deleted by some
// later run.
//
// Returns { cleared, transactions, messages, customers } — the counts are
// what the caller reports back and what the tests assert on.
export async function finishOnboarding(userId, { clear }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let deletedTransactions = 0;
    let deletedMessages = 0;
    let deletedCustomers = 0;

    if (clear) {
      // Leaves first. transactions reference customers AND workspaces with
      // NO ACTION (not CASCADE), so deleting in any other order fails on a
      // foreign key violation.
      const transactions = await client.query(
        `
        DELETE FROM transactions t
        USING messages m
        WHERE ${ONBOARDING_TRANSACTIONS_WHERE};
        `,
        [userId]
      );

      deletedTransactions = transactions.rowCount;

      const messages = await client.query(
        `
        DELETE FROM messages
        WHERE user_id = $1
          AND is_onboarding;
        `,
        [userId]
      );

      deletedMessages = messages.rowCount;

      // A practice "Raj took goods on udhaar" opens a khata for Raj. Now that
      // the transactions are gone he has an empty ledger, so the customer row
      // is dropped too — otherwise a name the shopkeeper only ever typed as
      // an example would sit in their customer list forever.
      //
      // Scoped to customers with NO transactions at all, which after the
      // delete above is exactly the practice ones. A real customer always has
      // at least the entry that created them.
      const customers = await client.query(
        `
        DELETE FROM customers c
        WHERE c.user_id = $1
          AND NOT EXISTS (
            SELECT 1
            FROM transactions t
            WHERE t.customer_id = c.id
          );
        `,
        [userId]
      );

      deletedCustomers = customers.rowCount;
    } else {
      // Keeping the data. The flags are cleared so these rows are no longer
      // reachable by the delete above under any future call.
      await client.query(
        `
        UPDATE messages
        SET is_onboarding = false
        WHERE user_id = $1
          AND is_onboarding;
        `,
        [userId]
      );
    }

    // Marks onboarding finished. Runs on both paths, and is what stops the
    // tutorial being shown again.
    await client.query(
      `
      UPDATE users
      SET
        onboarding_done_at = NOW(),
        updated_at = NOW()
      WHERE id = $1;
      `,
      [userId]
    );

    await client.query("COMMIT");

    return {
      cleared: Boolean(clear),
      transactions: deletedTransactions,
      messages: deletedMessages,
      customers: deletedCustomers,
    };
  } catch (error) {
    // Nothing is deleted unless everything is.
    await client.query("ROLLBACK");

    throw error;
  } finally {
    client.release();
  }
}
