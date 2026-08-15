# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot that turns natural-language messages ("Bought a laptop for ₹50,000") into bookkeeping transactions. Groq (llama-3.3-70b-versatile) extracts structured JSON from the message, Zod validates it, the user confirms via inline Telegram buttons, and the confirmed transaction is stored in PostgreSQL.

## Commands

```bash
npm start        # runs src/server.js (Fastify health endpoint on port 3000 — NOT the bot)
npm run dev      # same, with --watch
node src/telegram/bot.js   # runs the actual Telegram bot (polling mode)
```

Note: `src/server.js` does not import the bot — the Fastify server and the Telegram bot are separate entry points. All real functionality lives behind the bot.

There are no tests and no linter configured.

Required env vars (in `.env`, loaded via `dotenv/config`): `GROQ_API_KEY`, `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`.

Optional: `GEMINI_API_KEY` enables the Gemini fallback (see below); `GEMINI_MODEL` overrides the default `gemini-2.0-flash`.

## Architecture

ES modules throughout (`"type": "module"`). Flow for an incoming message:

1. **`src/telegram/bot.js`** — all Telegram handling: slash commands (`/start`, `/help`, `/summary`, `/transactions`, `/monthly`), free-text message handler, and the confirm/cancel `callback_query` handler. This is the orchestrator.
2. **`src/services/transaction.service.js`** — `processTransaction()`: asks Groq, `JSON.parse`s the reply, validates with `TransactionSchema` (Zod), attaches the Telegram message ID. Does not touch the database.
3. **`src/ai/groq.service.js`** — exports `askAI()`, which tries **Gemini** (`gemini-3.1-flash-lite`) first and falls back to **Groq** (`llama-3.3-70b-versatile`) on any failure. Gemini leads because its limit is per-minute (15 rpm, recovers in a minute) while Groq's is per-day (100k tokens, then the shop is down until tomorrow). Also holds `buildSystemPrompt()` — the single extraction prompt both providers share (transaction types, udhaar rules, language handling, date defaulting) — and strips markdown fences from either response. Without `GEMINI_API_KEY` it calls Groq directly, exactly as before the fallback existed.

   Model IDs are pinned deliberately — never use Gemini's `-latest` aliases, which Google repoints without warning, and note that Google *retires* models outright (`gemini-2.0-flash` now 404s).
4. **`src/database/postgres.js`** — all SQL lives here (pg `Pool`, raw queries). No ORM, no migration files in the repo — the `users`, `messages`, and `transactions` tables are assumed to exist already.
5. **`src/services/summary.service.js` / `monthly-summary.service.js`** — aggregate totals in JS over rows fetched by date/month.

## Key design points

- **Confirmation flow is database-backed, not in-memory.** An incoming message is saved to the `messages` table and moved through a status lifecycle: `RECEIVED → PROCESSING → PENDING_CONFIRMATION → CONFIRMED | CANCELLED | FAILED`. The AI-extracted transaction is stored as JSONB in `messages.transaction_data` while awaiting confirmation. Callback data on the buttons is just `confirm:<telegram_message_id>` / `cancel:<telegram_message_id>`; everything else is looked up in Postgres.
- **Confirmation is atomic and race-safe:** `confirmMessageTransaction()` in `postgres.js` uses `BEGIN` + `SELECT ... FOR UPDATE` to lock the message row, inserts the transaction, and marks the message `CONFIRMED` in one transaction. It returns `{success, reason}` objects (`NOT_FOUND`, `ALREADY_PROCESSED`, `TRANSACTION_DATA_MISSING`) rather than throwing for expected failures.
- **Idempotency via upserts:** `findOrCreateUser` upserts on `telegram_user_id`; `createMessage` and `createTransaction` use `ON CONFLICT ... DO NOTHING` on `(user_id, telegram_message_id)` / `telegram_message_id`.
- **All dates/times use the `Asia/Kolkata` timezone** and amounts are displayed in ₹ (INR). Dates are formatted with `toLocaleDateString("en-CA")` to get `YYYY-MM-DD` strings passed to SQL as `::date`.
- Transaction types recognized by the prompt: `sale | purchase | expense | payment_received | payment_sent | other`. Summaries only aggregate `sale`, `purchase`, and `expense`.
