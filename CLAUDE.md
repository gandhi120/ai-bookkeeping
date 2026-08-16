# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot that turns natural-language messages ("Bought a laptop for ₹50,000") into bookkeeping transactions. Groq (llama-3.3-70b-versatile) extracts structured JSON from the message, Zod validates it, the user confirms via inline Telegram buttons, and the confirmed transaction is stored in PostgreSQL.

`ARCHITECTURE.md` is the long-form version of this file: every table, every relationship, the reasoning behind each design decision, with worked examples and annotated code. This file stays short; that one teaches.

`FUTURE_FEATURES.md` is the roadmap from bookkeeping to business intelligence — product catalog → inventory → analytics → AI insights — with what each layer needs and why the order cannot be changed.

## Commands

```bash
npm start        # runs the bot (src/telegram/bot.js) — the only entry point
npm run dev      # same, with --watch
```

`src/server.js` (Fastify) and the `fastify` dependency are dead since the bot
grew its own webhook server — nothing imports either.

```bash
npm test         # schema + summary + ratelimit. No DB, no API key, free.
npm run test:db  # tests/udhaar.integration.js — real Postgres. Needs DATABASE_URL.
npm run test:ws  # tests/workspace.integration.js — workspace isolation. Needs DATABASE_URL.
npm run test:onb # tests/onboarding.integration.js — onboarding + practice-data cleanup. Needs DATABASE_URL.
npm run test:ai  # tests/ai.test.js — live AI classification. Needs an API key, costs calls.
```

No linter is configured. The two integration suites create throwaway users and delete everything they create in a `finally` block; existing data is never touched.

Required env vars (in `.env`, loaded via `dotenv/config`): `GROQ_API_KEY`, `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`.

Optional: `GEMINI_API_KEY` enables the Gemini fallback (see below); `GEMINI_MODEL` overrides the default `gemini-3.1-flash-lite`.

## Transport: polling vs webhook

`WEBHOOK_URL` is the switch, and it is the *only* switch. Set to the public
https origin (`https://app.up.railway.app`) the bot runs its own webhook
server; unset it polls. Production sets it, a laptop does not, so local
development needs no ngrok and no code change.

- **The bot token in the URL path is the authentication.** The library answers
  `401` to any request whose path does not contain the token, which is
  Telegram's own recommended scheme — the token is unguessable and the path is
  only ever seen by Telegram over TLS. No separate secret to manage.
- **`/healthz` answers 200 without the token** so the host's health check
  passes without being handed a credential.
- **The webhook server speaks plain HTTP.** Railway/Render/Fly terminate TLS in
  front of it. Passing `key`/`cert` would make it serve HTTPS itself, which is
  only needed on a bare VPS.
- **`PORT` is injected by the host**; 8443 is the fallback.
- **`setWebhook()` runs on every boot** and overwrites the previous
  registration, so redeploying on a new URL needs no manual step. If it fails
  the process exits — a bot Telegram cannot reach should crashloop visibly, not
  sit there looking healthy.
## Running in production

- **Importing `bot.js` does nothing.** The constructor is passed
  `polling: false` / `autoOpen: false`, and `start()` at the bottom runs only
  when `import.meta.url` matches `process.argv[1]`. That is what lets
  `tests/ratelimit.test.js` import the module without the bot going live, and
  it is the hook `server.js` would use if HTTP ever comes back for WhatsApp.
- **`start()` checks the env vars first and exits 1 on any missing.** The list
  is reported in full, so one restart names every typo rather than one per
  redeploy. This only works because nothing constructs a client at import time
  — `groq.service.js` builds its SDK client lazily for exactly this reason,
  since ESM imports run before any line of the entry point.
- **SIGTERM stops the transport, then `pool.end()`.** Every redeploy sends it.
  Closing the transport first means no new update is accepted on the way out,
  and `pool.end()` waits for in-flight queries — so a Confirm tapped during a
  deploy commits instead of being severed mid-`BEGIN`. Data is safe either way;
  this is about the user not seeing a spurious failure.
- **The flood guard sits in front of the AI, not the database.** `overRateLimit`
  in `bot.js` allows 20 free-text messages per user per minute. The budget it
  protects is shared and daily, so one person pasting a hundred lines does not
  inconvenience themselves — it takes the shop down until tomorrow. Commands
  skip it because they are pure reads. It replies only on the message that
  crosses, so a flood earns one warning, not a hundred.
- **One transport per token, still.** A webhook registered in production
  silently starves a laptop's `getUpdates`. Use a second BotFather token for
  local work — the same one-instance rule polling always had.

## Architecture

ES modules throughout (`"type": "module"`). Flow for an incoming message:

1. **`src/telegram/bot.js`** — all Telegram handling: slash commands (`/start`, `/help`, `/summary`, `/transactions`, `/monthly`, `/udhaar`, `/workspace`), free-text message handler, and the `callback_query` handler (confirm/cancel, payment clarification, workspace switching). This is the orchestrator. `resolveShopkeeper()` is the single chokepoint that resolves both the user and their active workspace.
2. **`src/services/transaction.service.js`** — `processMessage(text, telegramMessageId, workspaceType)`: asks the AI, `JSON.parse`s the reply, validates with `MessageSchema` (Zod), enforces the workspace type guard, attaches the Telegram message ID. Does not touch the database.
3. **`src/ai/groq.service.js`** — exports `askAI(message, workspaceType)`, which tries **Gemini** (`gemini-3.1-flash-lite`) first and falls back to **Groq** (`llama-3.3-70b-versatile`) on any failure. Gemini leads because its limit is per-minute (15 rpm, recovers in a minute) while Groq's is per-day (100k tokens, then the shop is down until tomorrow). Also holds `buildSystemPrompt(workspaceType)` — both providers share it, so they cannot drift — and strips markdown fences from either response. Without `GEMINI_API_KEY` it calls Groq directly, exactly as before the fallback existed.

   Model IDs are pinned deliberately — never use Gemini's `-latest` aliases, which Google repoints without warning, and note that Google *retires* models outright (`gemini-2.0-flash` now 404s).
4. **`src/database/postgres.js`** — all SQL lives here (pg `Pool`, raw queries). No ORM. Schema changes live in `migrations/` as numbered `.sql` files, wrapped in one `BEGIN`/`COMMIT` with commented rollback at the bottom. They are **never run automatically** — review and apply them by hand. The `users`, `messages` and `transactions` tables predate the repo and have no `CREATE TABLE` on disk.
5. **`src/services/summary.service.js` / `monthly-summary.service.js`** — `summarize(rows, workspaceType)` lives in the first and is imported by the second, so a new transaction type is only added in one place.

## Workspaces

A user keeps one or more ledgers: a `shopkeeper` workspace, a `household` workspace, or both. `users.active_workspace_id` is the switcher state; `/workspace` shows it.

- **`workspace.type` drives everything downstream** — which system prompt `buildSystemPrompt()` returns, which transaction types `isTypeAllowedInWorkspace()` accepts, and how `/summary` and `/monthly` render.
- **Two separate prompts, not one with a switch.** The prompt ships with every message, so a combined prompt would make every shop message pay for household rules it can never use. `buildShopkeeperPrompt()` is the original text, unchanged; `buildHouseholdPrompt()` is much shorter because a household has no khata.
- **Isolation is by `workspace_id`, not `user_id`** — the same person owns both ledgers, so `user_id` alone would show the groceries inside the shop's `/summary`. Every transaction read filters on both.
- **The workspace is stamped on the message at arrival and read back off the locked row at confirmation**, never from the user's current setting. Otherwise switching workspaces between typing and tapping Confirm would misfile the transaction.
- **The AI is instructed, never trusted.** The prompt is told which types exist; `isTypeAllowedInWorkspace()` in `src/schemas/transaction.schema.js` is what actually enforces it, so a hallucinated `credit_sale` on a grocery message cannot open a khata.
- `transactions.workspace_id` is deliberately nullable: rows predating `ebcb1a0` have no `user_id`, so they cannot be backfilled. They are invisible to every query either way — see `migrations/002_workspaces.sql`.

## Onboarding

A new user is walked through recording one **real** transaction, then offered
the chance to delete it so their real books open at zero.

- **It never assumes `/start`.** Most people open a bot and type "hii". Every
  command and the free-text handler check `if (!workspace)` and route to
  `askToChooseWorkspace()`, so onboarding begins from any first contact. That
  check runs *before* the AI call, so a first message costs nothing.
- **Choosing a workspace is the gate.** No workspace means no ledger, so
  nothing else in the bot can run until the question is answered. This is why
  the picker is sent from ten places rather than one.
- **Two columns hold all the state, and there is no step counter.**
  `users.onboarding_done_at` (NULL = still onboarding) and
  `messages.is_onboarding` (stamped at insert, the key the cleanup deletes by).
  Which step the user is on is carried by the button they tap next
  (`onb:summary`, `onb:finish`, `onb:clear`, `onb:keep`) — the same pattern as
  `confirm:` / `cancel:` / `addws:`.
- **`transactions` has no onboarding flag.** Practice transactions are reached
  by joining back to the message that created them. That join **must cast**:
  `messages.telegram_message_id` is `bigint` while
  `transactions.telegram_message_id` is `text`.
- **`finishOnboarding()` is the only function in `src/` that deletes anything.**
  Everything is scoped `WHERE user_id = $1`, gated on `is_onboarding`, and run
  in one transaction. It deletes leaves-first (transactions → messages →
  customers left with no ledger) because those FKs are `NO ACTION`, not
  cascade. **`users` and `workspaces` are never touched** — the workspace is
  what onboarding created. Balances need no repair since `getCustomerBalance`
  is a `SUM` over the ledger.
- **"Keep it" clears the flags** rather than leaving them set, so data the user
  chose to keep can never be deleted by a later call.
- **The count is the safety rail.** Everything typed while onboarding is open
  is flagged, so a user who ignores the finish button accumulates real data
  under the practice flag. The clear prompt states the exact number
  ("You have 47 practice entries"), which is what makes a wrong tap visible.
- **The feature tour is buttons, not steps.** After the practice entry is
  confirmed, one card offers every other feature the ledger has; each tap runs
  the *real* command against the user's own data and re-offers the card. So
  the whole product is covered without adding a single required step — trying
  everything takes about ten seconds, trying nothing takes one tap. It appears
  only *after* a confirmed transaction, because `/summary` and `/monthly` have
  no empty state and would otherwise open on a wall of ₹0.
- **`FEATURES_BY_WORKSPACE` in `src/schemas/transaction.schema.js` is the one
  place that declares what each ledger can DO**, as `TYPES_BY_WORKSPACE` beside
  it declares what each can RECORD. The tour builds its buttons from
  `featuresForWorkspace()`, so a household is never offered a khata. It is
  `?? []` fail-closed, and it is pure — which is the only way to test any of
  this, since importing `bot.js` starts the bot polling.
- **`TOUR` in `bot.js` holds each feature's label and handler in one entry**,
  rather than a label map beside an action map that could drift and caption a
  button "undefined". `ONBOARDING_STEPS` is derived from its keys: a step
  missing from that whitelist does not reach "Unknown action", it falls
  through to the transaction path and reports "Transaction not found."
- **Skip is an alias for finish, not a second path.** The skip button carries
  `onb:finish`, so it ends onboarding and still offers to clear anything
  already recorded. It appears from the practice prompt onward but never on
  the ledger question — with no workspace the user can do nothing at all.

## Key design points

- **Confirmation flow is database-backed, not in-memory.** An incoming message is saved to the `messages` table and moved through a status lifecycle: `RECEIVED → PROCESSING → PENDING_CONFIRMATION → CONFIRMED | CANCELLED | FAILED`. The AI-extracted transaction is stored as JSONB in `messages.transaction_data` while awaiting confirmation. Callback data on the buttons is just `confirm:<telegram_message_id>` / `cancel:<telegram_message_id>`; everything else is looked up in Postgres.
- **Confirmation is atomic and race-safe:** `confirmMessageTransaction()` in `postgres.js` uses `BEGIN` + `SELECT ... FOR UPDATE` to lock the message row, inserts the transaction, and marks the message `CONFIRMED` in one transaction. It returns `{success, reason}` objects (`NOT_FOUND`, `ALREADY_PROCESSED`, `TRANSACTION_DATA_MISSING`) rather than throwing for expected failures.
- **Idempotency via upserts:** `findOrCreateUser` upserts on `telegram_user_id`; `createMessage` and `createTransaction` use `ON CONFLICT ... DO NOTHING` on `(user_id, telegram_message_id)` / `telegram_message_id`.
- **All dates/times use the `Asia/Kolkata` timezone** and amounts are displayed in ₹ (INR). Dates are formatted with `toLocaleDateString("en-CA")` to get `YYYY-MM-DD` strings passed to SQL as `::date`.
- Transaction types: a shop uses `sale | purchase | expense | payment_received | payment_sent | credit_sale | repayment | other`; a household uses `expense | income | other`. `expense` is the only one both share.
