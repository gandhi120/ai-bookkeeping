import { pool } from "./pool.js";

// --------------------------------------------------
// Workspaces (which ledger the user is writing to)
// --------------------------------------------------
//
// A workspace is a ledger owned by one user — their shop or their home.
// It has no login and no members; the user just switches between their own.
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

// Creates a workspace, or returns the existing one of that type.
//
// The upsert matters because "+ Add Household" is a Telegram button and
// buttons get double-tapped. ON CONFLICT on the (user_id, type) unique index
// means the second tap returns the same workspace instead of creating a
// second home.
export async function createWorkspace(userId, name, type) {
  const result = await pool.query(
    `
    INSERT INTO workspaces (user_id, name, type)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, type)
    DO UPDATE SET updated_at = NOW()
    RETURNING *;
    `,
    [userId, name, type]
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
