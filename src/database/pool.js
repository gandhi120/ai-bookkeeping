import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

// The one connection pool for the whole app.
//
// ESM caches modules by URL, so every file importing this gets the SAME pool.
// That is what lets shutdown's pool.end() drain the connections every query
// function is using. A second Pool would leave the process hanging on exit.


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
