-- 002_workspaces.sql
--
-- Adds WORKSPACES so one user can keep a shop ledger and a household ledger
-- side by side without the two ever mixing.
--
-- DO NOT RUN AUTOMATICALLY. Review, then apply manually.
-- Wrapped in a single transaction: if any statement fails, nothing is applied.
--
-- What this does:
--   1. Adds a `workspaces` table (one shopkeeper and/or one household per user).
--   2. Adds users.active_workspace_id — which ledger the bot is writing to now.
--   3. Adds workspace_id to transactions and messages.
--   4. Backfills: every existing user becomes a shopkeeper with "My Shop",
--      and all their existing data is filed under it.
--   5. Adopts the pre-ownership orphan transactions into that shop (step 5).
--
-- Nothing is deleted, renamed or rewritten. Existing shopkeeper behaviour is
-- unchanged: after this runs, the current user is already inside "My Shop"
-- with every transaction they can see today still visible.

-- ---------------------------------------------------------------
-- PRE-FLIGHT (run these first, outside the transaction)
-- ---------------------------------------------------------------
-- Must return 0, or the messages backfill below leaves rows behind and the
-- SET NOT NULL at the end will abort the whole migration:
--
--   SELECT count(*) FROM messages WHERE user_id IS NULL;
--
-- Must return 1. Step 5 adopts ownerless rows into "the" shop, which only
-- has one possible meaning while there is exactly one user:
--
--   SELECT count(*) FROM users;

BEGIN;

-- ---------------------------------------------------------------
-- 1. workspaces
-- ---------------------------------------------------------------
-- A workspace is a ledger, not an account. It has no login and no members:
-- it belongs to exactly one user, who switches between their own workspaces.
-- `type` drives everything downstream — which transaction types are legal,
-- which system prompt the AI gets, and how /summary renders.
CREATE TABLE IF NOT EXISTS workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('shopkeeper', 'household')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One workspace per type per user. This is what makes "+ Add Household"
-- idempotent — a double tap hits ON CONFLICT instead of creating a second
-- home — and keeps the switcher to at most two rows.
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_user_type_unique
  ON workspaces (user_id, type);

-- ---------------------------------------------------------------
-- 2. users.active_workspace_id
-- ---------------------------------------------------------------
-- The switcher's state. Nullable on purpose: a brand new user has no
-- workspace until they pick one during onboarding, and the bot uses NULL
-- to know it must ask instead of guessing.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active_workspace_id uuid REFERENCES workspaces(id);

-- ---------------------------------------------------------------
-- 3. workspace_id on the two tables that hold ledger data
-- ---------------------------------------------------------------
-- messages needs it as well as transactions, not just for reporting: the
-- confirm button is tapped some time after the message arrives, and the user
-- may have switched workspaces in between. Confirmation reads the workspace
-- off the MESSAGE, so a transaction always lands in the ledger it was typed
-- into.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);

-- ---------------------------------------------------------------
-- 4. Backfill
-- ---------------------------------------------------------------
-- Every user who exists today is a shopkeeper. They keep the name "My Shop"
-- so nothing they see changes.
INSERT INTO workspaces (user_id, name, type)
  SELECT id, 'My Shop', 'shopkeeper'
  FROM users
  ON CONFLICT (user_id, type) DO NOTHING;

UPDATE users u
  SET active_workspace_id = w.id
  FROM workspaces w
  WHERE w.user_id = u.id
    AND w.type = 'shopkeeper'
    AND u.active_workspace_id IS NULL;

UPDATE transactions t
  SET workspace_id = w.id
  FROM workspaces w
  WHERE w.user_id = t.user_id
    AND w.type = 'shopkeeper'
    AND t.workspace_id IS NULL;

UPDATE messages m
  SET workspace_id = w.id
  FROM workspaces w
  WHERE w.user_id = m.user_id
    AND w.type = 'shopkeeper'
    AND m.workspace_id IS NULL;

-- ---------------------------------------------------------------
-- 5. Adopt the pre-ownership orphan transactions
-- ---------------------------------------------------------------
-- This database still holds rows created before transactions had a user_id
-- at all (commit ebcb1a0). They have user_id IS NULL, so step 4 could not
-- reach them, and they are invisible to every query in the app — all of
-- which filter on user_id.
--
-- They belong to the only user there has ever been, so they are adopted into
-- that user's shop rather than left as unreachable rows. This makes them
-- visible in /transactions and /monthly for the dates they carry, which is
-- the point: they are real transactions that were orphaned by a schema
-- change, not junk.
--
-- The subquery guard is what keeps this honest — with more than one user
-- there is no single correct owner, and this updates nothing.
UPDATE transactions t
  SET user_id = w.user_id,
      workspace_id = w.id
  FROM workspaces w
  WHERE w.type = 'shopkeeper'
    AND t.user_id IS NULL
    AND (SELECT count(*) FROM users) = 1;

-- ---------------------------------------------------------------
-- 6. Isolation is only real if the column can never be null
-- ---------------------------------------------------------------
-- Every row now has a workspace. If any slipped through, these abort and the
-- whole migration rolls back — which is the correct outcome, not a failure.
ALTER TABLE messages
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE transactions
  ALTER COLUMN workspace_id SET NOT NULL;

-- ---------------------------------------------------------------
-- 7. Index
-- ---------------------------------------------------------------
-- /summary and /transactions now filter on (workspace_id, transaction_date),
-- the same shape as the existing (user_id, transaction_date) index.
CREATE INDEX IF NOT EXISTS transactions_workspace_date_idx
  ON transactions (workspace_id, transaction_date);

COMMIT;


-- ===============================================================
-- ROLLBACK (run manually only if this migration must be undone)
-- ===============================================================
-- Note: this does NOT un-adopt the orphan transactions from step 5. Their
-- user_id stays set, so they remain visible. To restore them to ownerless:
--
--   UPDATE transactions SET user_id = NULL WHERE id IN (...);
--
-- with the ids recorded before the migration ran — which is why step 5 is
-- the one part of this file that is not cleanly reversible.
--
-- BEGIN;
--   DROP INDEX IF EXISTS transactions_workspace_date_idx;
--
--   ALTER TABLE messages     ALTER COLUMN workspace_id DROP NOT NULL;
--   ALTER TABLE transactions ALTER COLUMN workspace_id DROP NOT NULL;
--
--   ALTER TABLE users        DROP COLUMN IF EXISTS active_workspace_id;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS workspace_id;
--   ALTER TABLE messages     DROP COLUMN IF EXISTS workspace_id;
--
--   DROP TABLE IF EXISTS workspaces;
-- COMMIT;
