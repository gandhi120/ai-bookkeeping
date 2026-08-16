-- 004_language.sql
--
-- Adds LANGUAGE: the user picks English, Hindi or Gujarati before anything
-- else, and the bot speaks only that language from then on.
--
-- DO NOT RUN AUTOMATICALLY. Review, then apply manually.
-- Wrapped in a single transaction: if any statement fails, nothing is applied.
--
-- What this does:
--   1. Adds users.language — NULL means "has not chosen yet".
--   2. Backfills every existing user as English, so nobody already using the
--      bot is stopped and asked a question they never had to answer before.
--
-- Nothing is deleted, renamed or rewritten. One nullable column is added and
-- one UPDATE runs. Existing behaviour is unchanged.

-- ---------------------------------------------------------------
-- PRE-FLIGHT (run this first, outside the transaction)
-- ---------------------------------------------------------------
-- Must return 0 — the column must not already exist:
--
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='users'
--      AND column_name='language';

BEGIN;

-- ---------------------------------------------------------------
-- 1. users.language
-- ---------------------------------------------------------------
-- NULL = this user has not chosen a language yet, exactly as a NULL
-- onboarding_done_at means "not finished". There is deliberately NO DEFAULT:
-- a default would make a brand-new user indistinguishable from one who
-- deliberately chose English, and the bot would never ask the question.
--
-- The CHECK is the same fail-closed guard the workspaces.type check is. It
-- must stay in step with LANGUAGES in src/i18n/index.js — tests/i18n.test.js
-- asserts the two lists match, so adding a language without a migration
-- fails `npm test` rather than failing at INSERT time in production.
ALTER TABLE users ADD COLUMN language text
  CHECK (language IN ('en', 'hi', 'gu'));

-- ---------------------------------------------------------------
-- 2. Backfill existing users as English
-- ---------------------------------------------------------------
-- THE IMPORTANT LINE IN THIS FILE. Without it every existing user has a NULL
-- here, which the bot reads as "has not chosen" — so on the next deploy every
-- one of them would be interrupted mid-use by the language picker before any
-- command would run.
--
-- They can still change it any time with /language.
UPDATE users SET language = 'en' WHERE language IS NULL;

COMMIT;

-- ---------------------------------------------------------------
-- POST-CHECK (run after applying)
-- ---------------------------------------------------------------
-- Must return 0 — no existing user left without a language:
--
--   SELECT count(*) FROM users WHERE language IS NULL;
--
-- Should show every user as 'en' at this point:
--
--   SELECT language, count(*) FROM users GROUP BY language;

-- ---------------------------------------------------------------
-- ROLLBACK (uncomment and run to undo)
-- ---------------------------------------------------------------
-- Fully reversible: the column is new, and the backfill above only fills a
-- column that is about to be dropped.
--
-- BEGIN;
-- ALTER TABLE users DROP COLUMN IF EXISTS language;
-- COMMIT;
