import pg from "pg";
import "dotenv/config";

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


// Saves one transaction into the transactions table.
export async function createTransaction(transaction) {
  const result = await pool.query(
    `
    INSERT INTO transactions (
      user_id,
      transaction_type,
      description,
      category,
      quantity,
      amount,
      person,
      transaction_date,
      notes,
      telegram_message_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10)
    ON CONFLICT (telegram_message_id) DO NOTHING
    RETURNING *;
    `,
    [
      transaction.user_id,
      transaction.transaction_type,
      transaction.description,
      transaction.category,
      transaction.quantity,
      transaction.amount,
      transaction.person,
      transaction.transaction_date,
      transaction.notes,
      transaction.telegram_message_id,
    ]
  );

  // PostgreSQL returns the newly created row.
  return result.rows[0];
}

// Gets all transactions for a specific date.
export async function getTransactionsByDate(date) {
  const result = await pool.query(
    `
    SELECT *
    FROM transactions
    WHERE transaction_date = $1::date
    ORDER BY created_at DESC;
    `,
    [date]
  );

  return result.rows;
}

// Gets all transactions for a specific month.
export async function getTransactionsByMonth(year, month) {
  const result = await pool.query(
    `
    SELECT *
    FROM transactions
    WHERE transaction_date >= make_date($1, $2, 1)
      AND transaction_date < make_date($1, $2, 1) + INTERVAL '1 month'
    ORDER BY transaction_date DESC, created_at DESC;
    `,
    [year, month]
  );

  return result.rows;
}

// Saves every incoming Telegram message.
export async function createMessage(message) {
  const result = await pool.query(
    `
    INSERT INTO messages (
      user_id,
      telegram_message_id,
      message_text,
      status
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, telegram_message_id)
    DO NOTHING
    RETURNING *;
    `,
    [
      message.user_id,
      message.telegram_message_id,
      message.message_text,
      message.status,
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


// Confirms a pending message and creates its transaction atomically.
// Both database changes succeed together or both are rolled back.
export async function confirmMessageTransaction(
  messageId,
  userId
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

    // Create the final transaction using the same database client.
    const transactionResult = await client.query(
      `
      INSERT INTO transactions (
        user_id,
        transaction_type,
        description,
        category,
        quantity,
        amount,
        person,
        transaction_date,
        notes,
        telegram_message_id
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::date,
        $9,
        $10
      )
      RETURNING *;
      `,
      [
        userId,
        message.transaction_data.transaction_type,
        message.transaction_data.description,
        message.transaction_data.category,
        message.transaction_data.quantity,
        message.transaction_data.amount,
        message.transaction_data.person,
        message.transaction_data.transaction_date,
        message.transaction_data.notes,
        message.transaction_data.telegram_message_id,
      ]
    );

    const transaction = transactionResult.rows[0];

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
      transaction,
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