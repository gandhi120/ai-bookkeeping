import pg from "pg";
import "dotenv/config";

import { isCustomerTransaction } from "../schemas/transaction.schema.js";
import { isLanguage } from "../i18n/index.js";

const { Pool } = pg;


// Returns a dedicated PostgreSQL client for
// operations that need to run inside one transaction.
export async function getDatabaseClient() {
  return await pool.connect();
}

// Creates a connection pool.
// The pool manages PostgreSQL connections for our Node.js app.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Finds an existing Telegram user or creates a new one.
export async function findOrCreateUser(user) {
  const result = await pool.query(
    `
    INSERT INTO users (
      telegram_user_id,
      telegram_chat_id,
      first_name,
      username
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET
      telegram_chat_id = EXCLUDED.telegram_chat_id,
      first_name = EXCLUDED.first_name,
      username = EXCLUDED.username,
      updated_at = NOW()
    RETURNING *;
    `,
    [
      user.telegram_user_id,
      user.telegram_chat_id,
      user.first_name,
      user.username,
    ]
  );

  return result.rows[0];
}


// --------------------------------------------------
// Workspaces (which ledger the user is writing to)
// --------------------------------------------------
//
// A workspace is a ledger owned by one user — their shop or their home.
// It has no login and no members; the user just switches between their own.
// Every transaction read below is scoped by workspace_id, which is what keeps
// the grocery bill out of the shop's /summary.

// Lists the user's workspaces, oldest first so the switcher order is stable.
export async function getWorkspaces(userId) {
  const result = await pool.query(
    `
    SELECT *
    FROM workspaces
    WHERE user_id = $1
    ORDER BY created_at;
    `,
    [userId]
  );

  return result.rows;
}

// Returns the workspace the user is currently working in, or undefined when
// they have not chosen one yet (a brand new user, before onboarding).
export async function getActiveWorkspace(userId) {
  const result = await pool.query(
    `
    SELECT w.*
    FROM users u
    JOIN workspaces w ON w.id = u.active_workspace_id
    WHERE u.id = $1;
    `,
    [userId]
  );

  return result.rows[0];
}

// Creates a workspace, or returns the existing one of that type.
//
// The upsert matters because "+ Add Household" is a Telegram button and
// buttons get double-tapped. ON CONFLICT on the (user_id, type) unique index
// means the second tap returns the same workspace instead of creating a
// second home.
export async function createWorkspace(userId, name, type) {
  const result = await pool.query(
    `
    INSERT INTO workspaces (user_id, name, type)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, type)
    DO UPDATE SET updated_at = NOW()
    RETURNING *;
    `,
    [userId, name, type]
  );

  return result.rows[0];
}

// Switches which workspace the user is working in.
//
// The subquery is the security check, not a lookup: callback_data comes from
// the client, so `ws:<some-other-users-uuid>` is a thing someone can send.
// Requiring the workspace to belong to this user means a forged id updates
// nothing and returns undefined.
export async function setActiveWorkspace(userId, workspaceId) {
  const result = await pool.query(
    `
    UPDATE users
    SET
      active_workspace_id = $2,
      updated_at = NOW()
    WHERE id = $1
      AND EXISTS (
        SELECT 1
        FROM workspaces
        WHERE id = $2
          AND user_id = $1
      )
    RETURNING *;
    `,
    [userId, workspaceId]
  );

  return result.rows[0];
}

// Sets the language the bot speaks to this user.
//
// NULL in this column means "has not chosen yet", which is what puts the
// picker in front of a new user before anything else. Once set it is only
// ever changed by /language or the picker, never inferred.
//
// isLanguage() is the whitelist. The column has a CHECK constraint too, but
// that would surface as a thrown error mid-callback; refusing here means a
// forged `lang:xx` from a patched Telegram client is a no-op that returns
// undefined, exactly like a forged workspace uuid above.
export async function setUserLanguage(userId, language) {
  if (!isLanguage(language)) return undefined;

  const result = await pool.query(
    `
    UPDATE users
    SET
      language = $2,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *;
    `,
    [userId, language]
  );

  return result.rows[0];
}


// Gets all transactions for ONE workspace on a specific date.
//
// Scoped by workspace_id, not user_id: the same user owns both their shop and
// their home, so user_id alone would show the household groceries inside the
// shop's /summary. user_id is kept in the WHERE as well — it is implied by
// the workspace, but checking both means a wrong id can never cross tenants.
export async function getTransactionsByDate(userId, workspaceId, date) {
  const result = await pool.query(
    `
    SELECT *
    FROM transactions
    WHERE user_id = $1
      AND workspace_id = $2
      AND transaction_date = $3::date
    ORDER BY created_at DESC;
    `,
    [userId, workspaceId, date]
  );

  return result.rows;
}

// Gets all transactions for ONE workspace in a specific month.
// Scoped by workspace_id for the same isolation reason as above.
export async function getTransactionsByMonth(userId, workspaceId, year, month) {
  const result = await pool.query(
    `
    SELECT *
    FROM transactions
    WHERE user_id = $1
      AND workspace_id = $2
      AND transaction_date >= make_date($3, $4, 1)
      AND transaction_date < make_date($3, $4, 1) + INTERVAL '1 month'
    ORDER BY transaction_date DESC, created_at DESC;
    `,
    [userId, workspaceId, year, month]
  );

  return result.rows;
}

// Saves every incoming Telegram message.
//
// workspace_id is stamped here, at arrival, and never re-read from the user's
// current setting afterwards. That is what makes confirmation safe: the user
// can switch workspaces between typing a message and tapping Confirm, and the
// transaction still lands in the ledger they typed it into.
export async function createMessage(message) {
  const result = await pool.query(
    `
    INSERT INTO messages (
      user_id,
      workspace_id,
      telegram_message_id,
      message_text,
      status,
      is_onboarding
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id, telegram_message_id)
    DO NOTHING
    RETURNING *;
    `,
    [
      message.user_id,
      message.workspace_id,
      message.telegram_message_id,
      message.message_text,
      message.status,
      // Coerced with Boolean() rather than passed through: the column is
      // NOT NULL, and node-pg turns a missing key into SQL NULL, which would
      // reject the insert. A caller that does not care gets `false`.
      Boolean(message.is_onboarding),
    ]
  );

  return result.rows[0];
}

// Updates the processing status of a Telegram message.
export async function updateMessageStatus(messageId, status) {
  const result = await pool.query(
    `
    UPDATE messages
    SET
      status = $1,
      updated_at = NOW()
    WHERE id = $2
    RETURNING *;
    `,
    [status, messageId]
  );

  return result.rows[0];
}

// Stores the AI-generated transaction data for a message.
export async function updateMessageTransactionData(
  messageId,
  transactionData
) {
  const result = await pool.query(
    `
    UPDATE messages
    SET
      transaction_data = $1::jsonb,
      updated_at = NOW()
    WHERE id = $2
    RETURNING *;
    `,
    [
      JSON.stringify(transactionData),
      messageId,
    ]
  );

  return result.rows[0];
}

// Finds a Telegram message belonging to a user.
export async function getMessageByTelegramMessageId(
  userId,
  telegramMessageId
) {
  const result = await pool.query(
    `
    SELECT *
    FROM messages
    WHERE user_id = $1
      AND telegram_message_id = $2;
    `,
    [userId, telegramMessageId]
  );

  return result.rows[0];
}


// --------------------------------------------------
// Customers (the shopkeeper's khata / udhaar book)
// --------------------------------------------------
//
// A customer is a PASSIVE RECORD owned by one shopkeeper. Customers never
// use the bot. Every function below takes userId first, because User A's
// "Raj" and User B's "Raj" are two completely different people.

// Finds the shopkeeper's customer by name, or creates them if this is the
// first time that name is used.
//
// IMPORTANT: this takes the caller's `client` instead of using the pool.
// The pool hands out separate connections, and a BEGIN on one connection is
// invisible to another. Passing the client in means creating the customer
// happens INSIDE the caller's transaction, so if the confirmation rolls
// back, the customer creation rolls back with it.
//
// The upsert avoids a race: two messages arriving together cannot create
// two "Raj" rows, because the unique index decides the winner.
export async function findOrCreateCustomer(client, userId, name) {
  const result = await client.query(
    `
    INSERT INTO customers (user_id, name)
    VALUES ($1, $2)
    ON CONFLICT (user_id, lower(name))
    DO UPDATE SET updated_at = NOW()
    RETURNING *;
    `,
    [userId, name.trim()]
  );

  return result.rows[0];
}

// Looks up one of the shopkeeper's customers by name, case-insensitively
// so "raj", "Raj" and "RAJ" all find the same khata.
// Returns undefined when this shopkeeper has no such customer.
export async function getCustomerByName(userId, name) {
  const result = await pool.query(
    `
    SELECT *
    FROM customers
    WHERE user_id = $1
      AND lower(name) = lower($2);
    `,
    [userId, name.trim()]
  );

  return result.rows[0];
}

// Calculates how much a customer currently owes.
//
// The balance is DERIVED by summing the ledger, never stored in a column.
// A stored number would drift out of sync the moment any insert failed;
// a sum recalculated from the rows themselves cannot lie.
//
//   credit_sale -> customer took goods, owes MORE  (+)
//   repayment   -> customer paid back,   owes LESS (-)
//
// Returns a Number. Postgres returns numeric as a string in node-postgres
// (to avoid float precision loss), so it is converted explicitly.
export async function getCustomerBalance(userId, customerId) {
  const result = await pool.query(
    `
    SELECT COALESCE(SUM(
      CASE
        WHEN transaction_type = 'credit_sale' THEN amount
        WHEN transaction_type = 'repayment'   THEN -amount
        ELSE 0
      END
    ), 0) AS outstanding
    FROM transactions
    WHERE user_id = $1
      AND customer_id = $2;
    `,
    [userId, customerId]
  );

  return Number(result.rows[0].outstanding);
}

// Gets a customer's udhaar entries, newest first, for "Show Raj's transactions".
// Filtered on user_id AND customer_id: customer_id already implies the user,
// but checking both means a wrong id can never leak another shopkeeper's data.
export async function getCustomerTransactions(userId, customerId, limit = 20) {
  const result = await pool.query(
    `
    SELECT *
    FROM transactions
    WHERE user_id = $1
      AND customer_id = $2
    ORDER BY transaction_date DESC, created_at DESC
    LIMIT $3;
    `,
    [userId, customerId, limit]
  );

  return result.rows;
}

// Lists every customer of this shopkeeper who still owes money,
// largest debt first. Powers the /udhaar overview command.
// HAVING filters on the summed total, because WHERE cannot see aggregates.
export async function getAllOutstanding(userId) {
  const result = await pool.query(
    `
    SELECT
      c.id,
      c.name,
      SUM(
        CASE
          WHEN t.transaction_type = 'credit_sale' THEN t.amount
          WHEN t.transaction_type = 'repayment'   THEN -t.amount
          ELSE 0
        END
      ) AS outstanding
    FROM customers c
    JOIN transactions t
      ON t.customer_id = c.id
     AND t.user_id = c.user_id
    WHERE c.user_id = $1
    GROUP BY c.id, c.name
    HAVING SUM(
      CASE
        WHEN t.transaction_type = 'credit_sale' THEN t.amount
        WHEN t.transaction_type = 'repayment'   THEN -t.amount
        ELSE 0
      END
    ) <> 0
    ORDER BY outstanding DESC;
    `,
    [userId]
  );

  return result.rows;
}

// Confirms a pending message and creates its transaction atomically.
// Both database changes succeed together or both are rolled back.
//
// typeOverride is used when the AI could not tell what a payment meant and
// the shopkeeper answered the clarification question. Passing their answer
// in here (instead of updating transaction_data first and confirming after)
// keeps it a single atomic step, so a double tap still produces one row.
export async function confirmMessageTransaction(
  messageId,
  userId,
  typeOverride = null
) {
  const client = await pool.connect();

  try {
    // Start the PostgreSQL transaction.
    await client.query("BEGIN");

    // Lock the message row so two Confirm requests
    // cannot process the same message at the same time.
    const messageResult = await client.query(
      `
      SELECT
        id,
        user_id,
        workspace_id,
        status,
        transaction_data
      FROM messages
      WHERE id = $1
        AND user_id = $2
      FOR UPDATE;
      `,
      [messageId, userId]
    );

    const message = messageResult.rows[0];

    // Message doesn't exist.
    if (!message) {
      await client.query("ROLLBACK");

      return {
        success: false,
        reason: "NOT_FOUND",
      };
    }

    // Message was already confirmed/cancelled/failed.
    if (message.status !== "PENDING_CONFIRMATION") {
      await client.query("ROLLBACK");

      return {
        success: false,
        reason: "ALREADY_PROCESSED",
        status: message.status,
      };
    }

    // Transaction data should exist before confirmation.
    if (!message.transaction_data) {
      await client.query("ROLLBACK");

      return {
        success: false,
        reason: "TRANSACTION_DATA_MISSING",
      };
    }

    // One message can record several entries — "400 nu dudh, 300 no sabu" is
    // two. Older rows hold a bare object, so normalize; `[x].flat()` accepts
    // either and keeps messages saved before this feature confirmable.
    const entries = [message.transaction_data].flat();

    if (entries.length === 0) {
      await client.query("ROLLBACK");

      return {
        success: false,
        reason: "TRANSACTION_DATA_MISSING",
      };
    }

    // For udhaar entries (credit_sale / repayment), the customer is resolved
    // BEFORE inserting, on the same client, so the customer and the row are
    // created together or not at all. Everything else keeps customer_id null.
    //
    // Sequential rather than concurrent on purpose: they share one client, and
    // two entries naming the same new customer must not race to create it.
    const rows = [];

    for (const [index, entry] of entries.entries()) {
      // The shopkeeper's clarification wins over what the AI stored. For a
      // single-entry message the override applies to it; for several, the bot
      // has already written each answer back into the stored data, so the
      // override is only ever used when there is exactly one entry.
      const transactionType =
        (entries.length === 1 ? typeOverride : null) ?? entry.transaction_type;

      let customerId = null;

      if (isCustomerTransaction(transactionType) && entry.person) {
        const customer = await findOrCreateCustomer(client, userId, entry.person);

        customerId = customer.id;
      }

      rows.push({
        entry,
        transactionType,
        customerId,
        // Position within the message. Stored so the widened unique
        // constraint can tell entry 2 from entry 1 while still refusing a
        // second copy of either.
        seq: entry.seq ?? index,
      });
    }

    // One statement, N rows, inside the transaction that is already open —
    // so a failure on entry 3 leaves entries 1 and 2 unwritten too. That is
    // what the single Confirm button promises.
    //
    // ON CONFLICT keys on seq as well, which is what makes it idempotent per
    // entry rather than per message: a re-confirm is still a no-op, but entry
    // 2 no longer collides with entry 1. See migrations/005_multi_transaction.
    const values = rows
      .map((_, index) => {
        const at = index * 13;

        return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${
          at + 6
        }, $${at + 7}, $${at + 8}, $${at + 9}::date, $${at + 10}, $${at + 11}, $${
          at + 12
        }, $${at + 13})`;
      })
      .join(",\n        ");

    const params = rows.flatMap(({ entry, transactionType, customerId, seq }) => [
      userId,
      // Taken from the locked MESSAGE row, never from the user's current
      // active workspace — see the comment on createMessage.
      message.workspace_id,
      transactionType,
      entry.description,
      entry.category,
      entry.quantity,
      entry.amount,
      entry.person,
      entry.transaction_date,
      entry.notes,
      entry.telegram_message_id,
      customerId,
      seq,
    ]);

    await client.query(
      `
      INSERT INTO transactions (
        user_id,
        workspace_id,
        transaction_type,
        description,
        category,
        quantity,
        amount,
        person,
        transaction_date,
        notes,
        telegram_message_id,
        customer_id,
        seq
      )
      VALUES
        ${values}
      ON CONFLICT (user_id, telegram_message_id, seq) DO NOTHING;
      `,
      params
    );

    // Read the rows back rather than using RETURNING, because DO NOTHING
    // returns nothing for an entry an earlier attempt already saved. Selecting
    // gives the same answer whether this call wrote the rows or found them.
    const saved = await client.query(
      `
      SELECT *
      FROM transactions
      WHERE user_id = $1
        AND telegram_message_id = $2
      ORDER BY seq;
      `,
      [userId, entries[0].telegram_message_id]
    );

    // Mark the original message as confirmed.
    await client.query(
      `
      UPDATE messages
      SET
        status = 'CONFIRMED',
        updated_at = NOW()
      WHERE id = $1;
      `,
      [message.id]
    );

    // Both operations succeeded.
    await client.query("COMMIT");

    return {
      success: true,
      transactions: saved.rows,
    };
  } catch (error) {
    // Something failed, so undo everything in this transaction.
    await client.query("ROLLBACK");

    throw error;
  } finally {
    // Always return the connection to the pool.
    client.release();
  }
}

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