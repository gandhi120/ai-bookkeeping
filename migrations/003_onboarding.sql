-- 003_onboarding.sql
--
-- Adds ONBOARDING: a new user is walked through one real transaction, and the
-- practice entry is deleted afterwards so their real books open at zero.
--
-- DO NOT RUN AUTOMATICALLY. Review, then apply manually.
-- Wrapped in a single transaction: if any statement fails, nothing is applied.
--
-- What this does:
--   1. Adds users.onboarding_done_at — NULL means "still onboarding".
--   2. Backfills every existing user as done, so nobody already using the bot
--      is dropped back into the tutorial.
--   3. Adds messages.is_onboarding — marks a message as practice data.
--
-- Nothing is deleted, renamed or rewritten. Two nullable/defaulted columns are
-- added and one UPDATE runs. Existing behaviour is unchanged.

-- ---------------------------------------------------------------
-- PRE-FLIGHT (run these first, outside the transaction)
-- ---------------------------------------------------------------
-- Both must return 0 — the columns must not already exist:
--
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='users'
--      AND column_name='onboarding_done_at';
--
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='messages'
--      AND column_name='is_onboarding';
--
-- Note for later readers: transactions.telegram_message_id is TEXT while
-- messages.telegram_message_id is BIGINT. The cleanup query in
-- finishOnboarding() joins the two and therefore has to cast. This migration
-- does not change either column — fixing that mismatch is its own migration.

BEGIN;

-- ---------------------------------------------------------------
-- 1. users.onboarding_done_at
-- ---------------------------------------------------------------
-- NULL = this user has not finished onboarding yet. It is a timestamp rather
-- than a boolean because "when did they finish" costs the same to store and
-- answers questions a boolean cannot (drop-off, how long setup took).
--
-- No step number is stored. Each onboarding step is reached by tapping a
-- button that names the next action, so the position in the flow lives in the
-- callback data, exactly like the existing confirm:/cancel:/addws: buttons.
ALTER TABLE users ADD COLUMN onboarding_done_at timestamptz;

-- ---------------------------------------------------------------
-- 2. Backfill existing users as already onboarded
-- ---------------------------------------------------------------
-- THE IMPORTANT LINE IN THIS FILE. Without it every existing user has a NULL
-- here, which the bot reads as "still onboarding" — so on the next deploy they
-- would all be shown the tutorial again, and every message they sent would be
-- tagged as practice data and become eligible for deletion.
UPDATE users SET onboarding_done_at = now() WHERE onboarding_done_at IS NULL;

-- ---------------------------------------------------------------
-- 3. messages.is_onboarding
-- ---------------------------------------------------------------
-- Set at INSERT time when the sender is still onboarding. This is the key the
-- cleanup deletes by: practice transactions are found by joining back to the
-- messages that produced them, so `transactions` needs no flag of its own.
--
-- NOT NULL DEFAULT false means every one of the existing rows is excluded from
-- that cleanup by construction, not by remembering to filter them.
ALTER TABLE messages
  ADD COLUMN is_onboarding boolean NOT NULL DEFAULT false;

COMMIT;

-- ---------------------------------------------------------------
-- POST-CHECK (run after applying)
-- ---------------------------------------------------------------
-- Must return 0 — no existing user left in the onboarding state:
--
--   SELECT count(*) FROM users WHERE onboarding_done_at IS NULL;
--
-- Must return 0 — no existing message marked as practice data:
--
--   SELECT count(*) FROM messages WHERE is_onboarding;

-- ---------------------------------------------------------------
-- ROLLBACK (uncomment and run to undo)
-- ---------------------------------------------------------------
-- Fully reversible: both columns are new, and no existing row's data is
-- rewritten by this migration except the backfill above, which only fills a
-- column that is about to be dropped.
--
-- BEGIN;
-- ALTER TABLE messages DROP COLUMN IF EXISTS is_onboarding;
-- ALTER TABLE users    DROP COLUMN IF EXISTS onboarding_done_at;
-- COMMIT;
