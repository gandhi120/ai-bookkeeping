import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

// Creates a connection pool.
// The pool manages PostgreSQL connections for our Node.js app.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Saves one transaction into the transactions table.
export async function createTransaction(transaction) {
  const result = await pool.query(
    `
    INSERT INTO transactions (
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
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *;
    `,
    [
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