import { pool } from "./pool.js";

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
