-- 006_open_ledgers.sql
--
-- Two changes that only make sense together:
--
--   1. LEDGERS BECOME THE USER'S. Until now `workspaces.type` was
--      CHECK IN ('shopkeeper','household') with UNIQUE (user_id, type), which
--      literally says "one of each kind, and there are two kinds". This gives
--      them an emoji and a name they type, and as many ledgers as they want.
--
--   2. THE AI ANSWERS THE DIRECTION. A fixed transaction_type enum only works
--      if the code knows what each member MEANS -- that credit_sale is
--      goods-out-no-cash, that repayment is cash-but-not-revenue. That
--      knowledge is a lookup table, and a lookup table is the opposite of a
--      ledger the user invented. So the model answers the two questions the
--      table existed to answer: did money move, and did anyone's debt change.
--
-- DO NOT RUN AUTOMATICALLY. Review, then apply manually.
-- Wrapped in a single transaction: if any statement fails, nothing is applied.

-- ---------------------------------------------------------------
-- PRE-FLIGHT (run these first, outside the transaction)
-- ---------------------------------------------------------------
-- Must return 0 rows. Step 2 builds a unique index on lower(name) and will
-- abort the whole migration if one user already has two ledgers whose names
-- differ only in case:
--
--   SELECT user_id, lower(name), count(*)
--   FROM workspaces GROUP BY 1, 2 HAVING count(*) > 1;
--
-- Must be 12 or higher. Step 7 uses a GENERATED column:
--
--   SHOW server_version;

BEGIN;

-- ---------------------------------------------------------------
-- 1. The icon becomes data
-- ---------------------------------------------------------------
-- It used to be a constant looked up by type (WORKSPACE_KINDS in core.js).
-- Existing ledgers keep exactly the icon the UI already drew for them, so
-- nobody's shop silently turns into a notebook.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS emoji text NOT NULL DEFAULT '📒';

UPDATE workspaces SET emoji = '🏪' WHERE type = 'shopkeeper';
UPDATE workspaces SET emoji = '🏠' WHERE type = 'household';

-- ---------------------------------------------------------------
-- 2. Identity moves from type to name
-- ---------------------------------------------------------------
-- lower() for the same reason customers_user_name_unique uses it: "Bike" and
-- "bike" are the same ledger to the person who typed them. This is also what
-- keeps "+ New ledger" idempotent -- it is a Telegram button, and buttons get
-- double-tapped -- exactly as UNIQUE (user_id, type) used to.
DROP INDEX IF EXISTS workspaces_user_type_unique;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_user_name_unique
  ON workspaces (user_id, lower(name));

-- ---------------------------------------------------------------
-- 3. type stops meaning anything
-- ---------------------------------------------------------------
-- Kept as a nullable column for one release rather than dropped, so rolling
-- the code back needs no second migration. Drop it in 007.
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_type_check;
ALTER TABLE workspaces ALTER COLUMN type DROP NOT NULL;

-- ---------------------------------------------------------------
-- 4. One pending question at a time
-- ---------------------------------------------------------------
-- NULL means "the bot is not waiting for anything", which is every user
-- almost always. No default, for the same reason users.language has none: a
-- default cannot be told apart from a deliberate choice.
--
-- This is a column and not an in-memory Map because the bot restarts on every
-- deploy, and a Map would strand whoever was mid-question -- the same reason
-- the confirmation flow is database-backed.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pending_action text;

-- ---------------------------------------------------------------
-- 5. The two directions the AI now answers
-- ---------------------------------------------------------------
-- Two axes, not one, because they are independent: a credit sale moves debt
-- and no cash, a repayment moves both. That independence is why a single flat
-- enum kept needing new members -- it had to invent a name for every
-- combination.
--
-- These get CHECK constraints where transaction_type never had one. That was
-- a label; these are arithmetic. A typo here is a wrong total, not a wrong
-- word on a card.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS cash   text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS udhaar text NOT NULL DEFAULT 'none';

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_cash_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_cash_check
  CHECK (cash IN ('in', 'out', 'none'));

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_udhaar_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_udhaar_check
  CHECK (udhaar IN ('they_owe_more', 'they_owe_less',
                    'i_owe_more', 'i_owe_less', 'none'));

-- ---------------------------------------------------------------
-- 6. Backfill from the retired enum
-- ---------------------------------------------------------------
-- The ONLY place the old type names appear from here on. All seven are named
-- even though this database only holds four of them -- being clever about
-- which ones exist costs a query and saves nothing.
--
-- 'other' and 'credit_sale' are deliberately absent from both lists: neither
-- moves cash. credit_sale is handled by the udhaar backfill below.
UPDATE transactions SET cash = 'in'
  WHERE transaction_type IN ('sale', 'income', 'payment_received', 'repayment');

UPDATE transactions SET cash = 'out'
  WHERE transaction_type IN ('purchase', 'expense', 'payment_sent');

UPDATE transactions SET udhaar = 'they_owe_more'
  WHERE transaction_type = 'credit_sale';

UPDATE transactions SET udhaar = 'they_owe_less'
  WHERE transaction_type = 'repayment';

-- ---------------------------------------------------------------
-- 7. The sign, derived once, by the database
-- ---------------------------------------------------------------
-- Positive = they owe the user. Negative = the user owes them. One signed
-- number answers both questions, so /udhaar is one list split on the sign.
--
-- GENERATED rather than written by the app because the sign is DERIVED from
-- udhaar -- computing it here means it can never disagree with the column
-- beside it. It also collapses five copies of this CASE into one: three in
-- database/customers.js, one in telegram/khata.js, one in telegram/cards.js.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS owed_delta numeric
  GENERATED ALWAYS AS (
    CASE udhaar
      WHEN 'they_owe_more' THEN  amount   -- gave goods or money on credit
      WHEN 'they_owe_less' THEN -amount   -- they paid the user back
      WHEN 'i_owe_more'    THEN -amount   -- the user borrowed from them
      WHEN 'i_owe_less'    THEN  amount   -- the user paid them back
      ELSE 0
    END
  ) STORED;

COMMIT;


-- ===============================================================
-- POST-CHECK (run after applying)
-- ===============================================================
-- Every pre-existing row should now be classified. Rows still reading
-- none/none are the old 'other' type, which is correct -- anything else
-- sitting at none/none means the backfill missed a name:
--
--   SELECT transaction_type, cash, udhaar, count(*)
--   FROM transactions GROUP BY 1, 2, 3 ORDER BY 1;
--
-- And the generated column should agree with udhaar on every row:
--
--   SELECT udhaar, sign(owed_delta), count(*)
--   FROM transactions GROUP BY 1, 2 ORDER BY 1;


-- ===============================================================
-- ROLLBACK (run manually only if this migration must be undone)
-- ===============================================================
-- Note: step 2 is only cleanly reversible while no user has made a third
-- ledger. If one has, the old UNIQUE (user_id, type) cannot be rebuilt and
-- the extra ledgers must be dealt with by hand first.
--
-- BEGIN;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS owed_delta;
--   ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_cash_check;
--   ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_udhaar_check;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS cash;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS udhaar;
--
--   ALTER TABLE users DROP COLUMN IF EXISTS pending_action;
--
--   DROP INDEX IF EXISTS workspaces_user_name_unique;
--   CREATE UNIQUE INDEX workspaces_user_type_unique
--     ON workspaces (user_id, type);
--   ALTER TABLE workspaces ALTER COLUMN type SET NOT NULL;
--   ALTER TABLE workspaces ADD CONSTRAINT workspaces_type_check
--     CHECK (type IN ('shopkeeper', 'household'));
--   ALTER TABLE workspaces DROP COLUMN IF EXISTS emoji;
-- COMMIT;
