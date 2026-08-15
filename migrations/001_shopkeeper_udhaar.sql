-- 001_shopkeeper_udhaar.sql
--
-- Adds customer (khata) support and udhaar/credit tracking for shopkeepers.
--
-- DO NOT RUN AUTOMATICALLY. Review, then apply manually.
-- Wrapped in a single transaction: if any statement fails, nothing is applied.
--
-- What this does:
--   1. Adds a user-scoped `customers` table (shopkeeper's khata).
--   2. Links transactions to a customer via a NULLABLE customer_id.
--   3. FIXES a cross-user bug: transactions.telegram_message_id was globally
--      UNIQUE, but Telegram message ids are only unique per chat.
--   4. Allows the new ANSWERED message status for natural-language queries.

BEGIN;

-- ---------------------------------------------------------------
-- 1. customers — the shopkeeper's khata
-- ---------------------------------------------------------------
-- A customer is a PASSIVE RECORD owned by one shopkeeper. Customers never
-- use the bot, so there is deliberately no telegram id, no auth, no status.
-- `phone` is for the shopkeeper's own reference only.
CREATE TABLE IF NOT EXISTS customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- user_id is part of the key, so User A's "Raj" and User B's "Raj" are two
-- different rows. lower(name) so "raj" / "Raj" / "RAJ" resolve to one khata.
CREATE UNIQUE INDEX IF NOT EXISTS customers_user_name_unique
  ON customers (user_id, lower(name));

-- Fast "all customers for this shopkeeper" lookups.
CREATE INDEX IF NOT EXISTS customers_user_idx
  ON customers (user_id);

-- ---------------------------------------------------------------
-- 2. transactions -> customers
-- ---------------------------------------------------------------
-- NULLABLE on purpose: normal purchases/sales/expenses have no customer and
-- must keep working exactly as before. Only credit_sale/repayment set it.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id);

-- Outstanding-balance queries filter on (user_id, customer_id).
CREATE INDEX IF NOT EXISTS transactions_customer_idx
  ON transactions (user_id, customer_id);

-- /summary and /transactions filter on (user_id, transaction_date).
CREATE INDEX IF NOT EXISTS transactions_user_date_idx
  ON transactions (user_id, transaction_date);

-- ---------------------------------------------------------------
-- 3. BUG FIX: make the Telegram message id unique PER SHOPKEEPER
-- ---------------------------------------------------------------
-- Telegram message ids restart per chat, so two shopkeepers both produce
-- message id 42. The old global UNIQUE made the second shopkeeper's insert
-- fail, rolling back their confirmation. Scope the uniqueness to the user.
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS unique_telegram_message;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_user_msg_unique
  UNIQUE (user_id, telegram_message_id);

-- ---------------------------------------------------------------
-- 4. Allow the ANSWERED status
-- ---------------------------------------------------------------
-- "How much does Raj owe me?" is a question, not a transaction. It is
-- answered immediately and never enters the confirmation flow.
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_status_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_status_check CHECK (status IN (
    'RECEIVED',
    'PROCESSING',
    'PENDING_CONFIRMATION',
    'CONFIRMED',
    'CANCELLED',
    'FAILED',
    'ANSWERED'
  ));

COMMIT;


-- ===============================================================
-- ROLLBACK (run manually only if this migration must be undone)
-- ===============================================================
-- BEGIN;
--   ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
--   ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN (
--     'RECEIVED','PROCESSING','PENDING_CONFIRMATION','CONFIRMED','CANCELLED','FAILED'));
--
--   ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_user_msg_unique;
--   ALTER TABLE transactions ADD CONSTRAINT unique_telegram_message
--     UNIQUE (telegram_message_id);
--
--   DROP INDEX IF EXISTS transactions_user_date_idx;
--   DROP INDEX IF EXISTS transactions_customer_idx;
--   ALTER TABLE transactions DROP COLUMN IF EXISTS customer_id;
--   DROP TABLE IF EXISTS customers;
-- COMMIT;
