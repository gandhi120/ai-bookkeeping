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

// Calculates what stands between the user and this person.
//
// The balance is DERIVED by summing the ledger, never stored in a column.
// A stored number would drift out of sync the moment any insert failed;
// a sum recalculated from the rows themselves cannot lie.
//
// SIGNED, and the sign is the whole answer:
//   POSITIVE -> they owe the user
//   NEGATIVE -> the user owes them
//
// `owed_delta` is a GENERATED column (migration 006). The four-way udhaar ->
// plus-or-minus rule lives in the schema and nowhere else — it used to be
// written out three times in this file alone, plus once in khata.js and once
// in cards.js, and every copy had to be updated together.
//
// It is also what makes one khata cover both directions. A person you lend to
// and borrow from is one row and one number, not two half-truths.
//
// Returns a Number. Postgres returns numeric as a string in node-postgres
// (to avoid float precision loss), so it is converted explicitly.
export async function getCustomerBalance(userId, customerId) {
  const result = await pool.query(
    `
    SELECT COALESCE(SUM(owed_delta), 0) AS outstanding
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

// Lists everyone with an open khata, in either direction. Powers /udhaar.
//
// Ordered DESC so the biggest debts owed TO the user come first and the people
// the user owes sit at the bottom — /udhaar renders that as two blocks. abs()
// would interleave them, which is exactly the wrong reading.
//
// HAVING filters on the summed total, because WHERE cannot see aggregates.
// Note it can reference SUM(owed_delta) directly: Postgres will not accept an
// output alias in HAVING, so before the generated column existed this query
// had to spell the whole CASE out a second time.
//
// Settled khatas drop out. Someone who paid up in March should not sit in the
// list at zero forever.
export async function getAllOutstanding(userId) {
  const result = await pool.query(
    `
    SELECT
      c.id,
      c.name,
      SUM(t.owed_delta) AS outstanding
    FROM customers c
    JOIN transactions t
      ON t.customer_id = c.id
     AND t.user_id = c.user_id
    WHERE c.user_id = $1
    GROUP BY c.id, c.name
    HAVING SUM(t.owed_delta) <> 0
    ORDER BY outstanding DESC;
    `,
    [userId]
  );

  return result.rows;
}
