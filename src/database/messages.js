import { pool } from "./pool.js";

// Every incoming Telegram message and its status lifecycle. The confirmation
// that turns one into transactions lives in transactions.js.

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
