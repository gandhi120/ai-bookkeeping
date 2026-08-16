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
