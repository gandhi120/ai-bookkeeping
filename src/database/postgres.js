import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

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