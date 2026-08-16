-- 005_multi_transaction.sql
--
-- Lets ONE Telegram message produce SEVERAL transactions.
--
-- DO NOT RUN AUTOMATICALLY. Review, then apply manually.
-- Wrapped in a single transaction: if any statement fails, nothing is applied.
--
-- What this does:
--   1. Adds transactions.seq — which entry within its message a row is.
--   2. Widens the (user_id, telegram_message_id) unique constraint to include
--      it, so N rows may share one message.
--
-- Why it is needed: a shopkeeper closing up types the day's entries in one
-- message ("400 nu dudh lavya, 300 no sabu lavya"). The AI already returns
-- both. The database is what refused them:
--
--   ALTER TABLE transactions
--     ADD CONSTRAINT transactions_user_msg_unique
--     UNIQUE (user_id, telegram_message_id);          -- 001, line 66
--
-- That constraint made "one message = one transaction" a physical law. Worse
-- than an error, actually: confirmMessageTransaction inserts with
-- ON CONFLICT ... DO NOTHING, so a loop over N entries would have silently
-- written the first and reported success for all of them.
--
-- Nothing is deleted or rewritten. One column is added with a default, and one
-- constraint is replaced by a wider one that permits everything the old one
-- permitted.

-- ---------------------------------------------------------------
-- PRE-FLIGHT (run these first, outside the transaction)
-- ---------------------------------------------------------------
-- Must return 0 — the column must not already exist:
--
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='transactions'
--      AND column_name='seq';
--
-- Must return 1 — the old constraint should still be in place:
--
--   SELECT count(*) FROM pg_constraint
--    WHERE conname = 'transactions_user_msg_unique';
--
-- Worth knowing before you run it: the DEFAULT 0 backfill is free only while
-- no message has produced more than one transaction, which is true by
-- construction right now because the old constraint forbade it.

BEGIN;

-- ---------------------------------------------------------------
-- 1. transactions.seq
-- ---------------------------------------------------------------
-- Which entry within its message this row is: 0 for the first, 1 for the
-- second, and so on. Every existing row is 0, because one message could only
-- ever have produced one transaction.
--
-- smallint rather than integer because the bot caps a message at 10 entries,
-- and NOT NULL DEFAULT 0 so no existing row and no un-updated caller has to
-- know this column exists.
ALTER TABLE transactions
  ADD COLUMN seq smallint NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------
-- 2. Widen the unique constraint
-- ---------------------------------------------------------------
-- Widened rather than dropped, deliberately. The narrow constraint is what
-- ON CONFLICT (user_id, telegram_message_id) DO NOTHING keys off in
-- confirmMessageTransaction, and that upsert is a real double-tap guard —
-- dropping the constraint outright would turn it from "second tap is a no-op"
-- into "second tap duplicates the books".
--
-- Adding seq keeps that guard working per entry: entry 2 of a message no
-- longer collides with entry 1, but a re-confirm of entry 2 still does.
--
-- (The SELECT ... FOR UPDATE on the message row is the primary guard and is
-- sufficient on its own. This is the belt to its braces, and the repo has
-- deliberately kept both elsewhere — see findOrCreateUser and createMessage.)
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_user_msg_unique;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_user_msg_seq_unique
  UNIQUE (user_id, telegram_message_id, seq);

COMMIT;

-- ---------------------------------------------------------------
-- POST-CHECK (run after applying)
-- ---------------------------------------------------------------
-- Must return 1 — the new constraint exists:
--
--   SELECT count(*) FROM pg_constraint
--    WHERE conname = 'transactions_user_msg_seq_unique';
--
-- Must return 0 — the old one is gone:
--
--   SELECT count(*) FROM pg_constraint
--    WHERE conname = 'transactions_user_msg_unique';
--
-- Must return 0 — nothing was left without a seq:
--
--   SELECT count(*) FROM transactions WHERE seq IS NULL;

-- ---------------------------------------------------------------
-- ROLLBACK (uncomment and run to undo)
-- ---------------------------------------------------------------
-- Reversible ONLY while no message has produced more than one transaction.
-- Once a real multi-entry message has been confirmed, restoring the narrow
-- constraint will fail on the duplicate (user_id, telegram_message_id) pairs
-- it now legitimately contains — and the fix at that point is to delete real
-- bookkeeping data, which is not something to do casually. Check first:
--
--   SELECT user_id, telegram_message_id, count(*)
--     FROM transactions
--    GROUP BY 1, 2 HAVING count(*) > 1;
--
-- BEGIN;
-- ALTER TABLE transactions
--   DROP CONSTRAINT IF EXISTS transactions_user_msg_seq_unique;
-- ALTER TABLE transactions
--   ADD CONSTRAINT transactions_user_msg_unique
--   UNIQUE (user_id, telegram_message_id);
-- ALTER TABLE transactions DROP COLUMN IF EXISTS seq;
-- COMMIT;
