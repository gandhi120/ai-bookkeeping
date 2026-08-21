import { pool } from "./pool.js";

import { isCustomerTransaction } from "../schemas/transaction.schema.js";
import { findOrCreateCustomer } from "./customers.js";

// Reads of the books, and the one write that puts anything in them.

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

// Every ledger's month in ONE round trip, tagged with which ledger each row
// came from. Powers "this month, everywhere" on /menu.
//
// Scoped by user_id alone ON PURPOSE — this is the one view that is meant to
// cross ledgers. The join to workspaces is what keeps it inside the user
// regardless: a row can only appear if its workspace belongs to them.
//
// Ordered by w.created_at so ledgers come back in the same order the switcher
// lists them. A summary whose sections move around between months is unreadable.
//
// No new index needed: transactions_user_date_idx is (user_id, transaction_date),
// which is exactly this shape.
export async function getTransactionsByMonthAllWorkspaces(userId, year, month) {
  const result = await pool.query(
    `
    SELECT
      t.*,
      w.id    AS ws_id,
      w.emoji AS ws_emoji,
      w.name  AS ws_name
    FROM transactions t
    JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.user_id = $1
      AND t.transaction_date >= make_date($2, $3, 1)
      AND t.transaction_date <  make_date($2, $3, 1) + INTERVAL '1 month'
    ORDER BY w.created_at, t.transaction_date DESC, t.created_at DESC;
    `,
    [userId, year, month]
  );

  return result.rows;
}

// Confirms a pending message and creates its transaction atomically.
// Both database changes succeed together or both are rolled back.
//
// `clarification` is used when the AI could not tell what a payment meant and
// the user answered the question — `{ cash, udhaar }`. Passing their answer in
// here (instead of updating transaction_data first and confirming after) keeps
// it a single atomic step, so a double tap still produces one row.
export async function confirmMessageTransaction(
  messageId,
  userId,
  clarification = null
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

    // For udhaar entries — anything whose `udhaar` is not "none" — the customer
    // is resolved BEFORE inserting, on the same client, so the customer and the
    // row are created together or not at all. Everything else keeps
    // customer_id null.
    //
    // Sequential rather than concurrent on purpose: they share one client, and
    // two entries naming the same new customer must not race to create it.
    const rows = [];

    for (const [index, entry] of entries.entries()) {
      // The user's clarification wins over what the AI stored. For a
      // single-entry message the override applies to it; for several, the bot
      // has already written each answer back into the stored data, so the
      // override is only ever used when there is exactly one entry.
      const answered =
        (entries.length === 1 ? clarification : null) ?? {};

      const resolved = { ...entry, ...answered };

      let customerId = null;

      if (isCustomerTransaction(resolved) && entry.person) {
        const customer = await findOrCreateCustomer(client, userId, entry.person);

        customerId = customer.id;
      }

      rows.push({
        entry: resolved,
        customerId,
        // Position within the message. Stored so the widened unique
        // constraint can tell entry 2 from entry 1 while still refusing a
        // second copy of either.
        seq: entry.seq ?? index,
      });
    }

    // The column order, declared once. `params` below pushes values in this
    // exact order, and the INSERT names them in it — so the three cannot drift.
    const INSERT_COLUMNS = [
      "user_id",
      "workspace_id",
      "transaction_type",
      "cash",
      "udhaar",
      "description",
      "category",
      "quantity",
      "amount",
      "person",
      "transaction_date",
      "notes",
      "telegram_message_id",
      "customer_id",
      "seq",
    ];

    // One statement, N rows, inside the transaction that is already open —
    // so a failure on entry 3 leaves entries 1 and 2 unwritten too. That is
    // what the single Confirm button promises.
    //
    // ON CONFLICT keys on seq as well, which is what makes it idempotent per
    // entry rather than per message: a re-confirm is still a no-op, but entry
    // 2 no longer collides with entry 1. See migrations/005_multi_transaction.
    const values = rows
      .map((_, index) => {
        // `at` is where this row's placeholders start, so the numbering keeps
        // running across rows: with 15 columns, entry 2 uses $16..$30.
        const at = index * INSERT_COLUMNS.length;

        const placeholders = INSERT_COLUMNS.map((column, offset) =>
          // transaction_date is the only one needing a cast; everything else
          // Postgres infers from the column it is inserted into. Found by NAME,
          // not by a hardcoded position — adding `cash` and `udhaar` shifted
          // this from the 9th column to the 11th, and a fixed index would have
          // quietly cast the amount instead.
          column === "transaction_date"
            ? `$${at + offset + 1}::date`
            : `$${at + offset + 1}`
        );

        return `(${placeholders.join(", ")})`;
      })
      .join(",\n        ");

    const params = rows.flatMap(({ entry, customerId, seq }) => [
      userId,
      // Taken from the locked MESSAGE row, never from the user's current
      // active workspace — see the comment on createMessage.
      message.workspace_id,
      entry.transaction_type,
      // The two the totals are built from. Defaulted rather than assumed
      // present: the column is NOT NULL DEFAULT 'none', and an entry that
      // somehow arrives without them should land as "nothing moved" rather
      // than throw mid-BEGIN.
      entry.cash ?? "none",
      entry.udhaar ?? "none",
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
      INSERT INTO transactions (${INSERT_COLUMNS.join(", ")})
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
