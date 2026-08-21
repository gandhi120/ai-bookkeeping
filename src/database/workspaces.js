import { pool } from "./pool.js";

// --------------------------------------------------
// Workspaces (which ledger the user is writing to)
// --------------------------------------------------
//
// A workspace is a ledger owned by one user, named by them — "Kirana Store",
// "Bike", "Farm". It has no login and no members; the user just switches
// between their own. Until migration 006 there were exactly two, a shop and a
// home, and `type` was their identity; now the NAME is.
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

// Creates a ledger, or returns the user's existing one of that name.
//
// The upsert matters because "+ New ledger" is a Telegram button and buttons
// get double-tapped. ON CONFLICT on the (user_id, lower(name)) unique index
// means the second tap returns the same ledger instead of making a duplicate —
// the same guarantee UNIQUE (user_id, type) used to give, moved onto the name.
//
// lower() because "Bike" and "bike" are the same ledger to whoever typed them.
// Postgres accepts ON CONFLICT against an expression index as long as the
// expression matches the index exactly — findOrCreateCustomer already does
// this with the same shape.
//
// The emoji is updated on conflict but the name is not: re-sending
// "🏍️ bike" when "Bike" exists should not silently re-case the ledger the
// user is looking at in their switcher.
export async function createWorkspace(userId, emoji, name) {
  const result = await pool.query(
    `
    INSERT INTO workspaces (user_id, emoji, name)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, lower(name))
    DO UPDATE SET
      emoji = EXCLUDED.emoji,
      updated_at = NOW()
    RETURNING *;
    `,
    [userId, emoji, name]
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
