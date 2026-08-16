# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot that turns natural-language messages ("Bought a laptop for ₹50,000") into bookkeeping transactions. Groq (llama-3.3-70b-versatile) extracts structured JSON from the message, Zod validates it, the user confirms via inline Telegram buttons, and the confirmed transaction is stored in PostgreSQL.

`ARCHITECTURE.md` is the index to `docs/` — the long-form version of this file, split into 14 pages: every table, every relationship, the reasoning behind each design decision, with worked examples and annotated code. This file stays short; those teach. Start at `docs/01-what-it-is.md`, or jump straight to `docs/09-code-map.md` for which file holds what.

`FUTURE_FEATURES.md` is the roadmap from bookkeeping to business intelligence — product catalog → inventory → analytics → AI insights — with what each layer needs and why the order cannot be changed.

## Commands

```bash
npm start        # runs the bot (src/telegram/bot.js) — the only entry point
npm run dev      # same, with --watch
```

`src/server.js` (Fastify) and the `fastify` dependency are dead since the bot
grew its own webhook server — nothing imports either.

```bash
npm test         # schema + summary + ratelimit + i18n. No DB, no API key, free.
npm run test:db  # tests/udhaar.integration.js — real Postgres. Needs DATABASE_URL.
npm run test:ws  # tests/workspace.integration.js — workspace isolation. Needs DATABASE_URL.
npm run test:onb # tests/onboarding.integration.js — onboarding + practice-data cleanup. Needs DATABASE_URL.
npm run test:lang # tests/language.integration.js — users.language, the CHECK, and what must not reset it. Needs DATABASE_URL.
npm run test:ai  # tests/ai.test.js — live AI classification. Needs an API key, costs calls.
```

No linter is configured. Every integration suite creates throwaway users and deletes everything it creates in a `finally` block; existing data is never touched. `npm run test:all` runs all of them except `test:ai`, which is left out because it costs API calls.

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

- **Importing `bot.js` does nothing.** The constructor (in `telegram/core.js`)
  is passed `polling: false` / `autoOpen: false`, and `start()` in `bot.js` runs
  only when `import.meta.url` matches `process.argv[1]`. That is what lets
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
  in `telegram/messages.js` allows 20 free-text messages per user per minute. The budget it
  protects is shared and daily, so one person pasting a hundred lines does not
  inconvenience themselves — it takes the shop down until tomorrow. Commands
  skip it because they are pure reads. It replies only on the message that
  crosses, so a flood earns one warning, not a hundred.
- **One transport per token, still.** A webhook registered in production
  silently starves a laptop's `getUpdates`. Use a second BotFather token for
  local work — the same one-instance rule polling always had.

## Architecture

ES modules throughout (`"type": "module"`). Flow for an incoming message:

1. **`src/telegram/`** — all Telegram handling, split into eight files by
   responsibility: `core.js` (the `bot` instance, `resolveShopkeeper()`, the
   setup gate, `money`/`today`/`sendError`), `cards.js` (rendering +
   `askToConfirm()`), `commands.js`, `khata.js`, `messages.js` (flood guard +
   free text), `onboarding.js`, `callbacks.js`, and `bot.js` (boot/shutdown
   only). **`core.js` imports nothing from its siblings** — that is what keeps
   the graph acyclic; handlers register as an import side effect, so import
   order in `bot.js` is registration order. Slash commands (`/start`, `/help`, `/summary`, `/transactions`, `/monthly`, `/udhaar`, `/workspace`, `/language`), free-text message handler, and the `callback_query` handler (confirm/cancel, payment clarification, workspace switching, language selection). This is the orchestrator. `resolveShopkeeper()` is the single chokepoint that resolves both the user and their active workspace — the language rides along on the same `users` row, so reading it costs nothing extra.
2. **`src/services/transaction.service.js`** — `processMessage(text, telegramMessageId, workspaceType, language)`: asks the AI, `JSON.parse`s the reply, validates with `MessageSchema` (Zod), enforces the workspace type guard, attaches the Telegram message ID. Does not touch the database.
3. **`src/ai/groq.service.js`** — exports `askAI(message, workspaceType, language)`, which tries **Gemini** (`gemini-3.1-flash-lite`) first and falls back to **Groq** (`llama-3.3-70b-versatile`) on any failure. Gemini leads because its limit is per-minute (15 rpm, recovers in a minute) while Groq's is per-day (100k tokens, then the shop is down until tomorrow). Also holds `buildSystemPrompt(workspaceType, language)` — both providers share it, so they cannot drift — and strips markdown fences from either response. Without `GEMINI_API_KEY` it calls Groq directly, exactly as before the fallback existed.

   Model IDs are pinned deliberately — never use Gemini's `-latest` aliases, which Google repoints without warning, and note that Google *retires* models outright (`gemini-2.0-flash` now 404s).
4. **`src/database/`** — all SQL lives here (pg `Pool`, raw queries), one file
   per concern: `pool.js` (imports nothing local, so `pool` stays a singleton and
   `pool.end()` drains what every query uses), `users.js`, `workspaces.js`,
   `transactions.js` (incl. `confirmMessageTransaction()`), `messages.js`,
   `customers.js`, `onboarding.js`. No ORM. Schema changes live in `migrations/` as numbered `.sql` files, wrapped in one `BEGIN`/`COMMIT` with commented rollback at the bottom. They are **never run automatically** — review and apply them by hand. The `users`, `messages` and `transactions` tables predate the repo and have no `CREATE TABLE` on disk.
5. **`src/services/summary.service.js` / `monthly-summary.service.js`** — `summarize(rows, workspaceType)` lives in the first and is imported by the second, so a new transaction type is only added in one place.

## Workspaces

A user keeps one or more ledgers: a `shopkeeper` workspace, a `household` workspace, or both. `users.active_workspace_id` is the switcher state; `/workspace` shows it.

- **`workspace.type` drives everything downstream** — which system prompt `buildSystemPrompt()` returns, which transaction types `isTypeAllowedInWorkspace()` accepts, and how `/summary` and `/monthly` render.
- **Two separate prompts, not one with a switch.** The prompt ships with every message, so a combined prompt would make every shop message pay for household rules it can never use. `buildShopkeeperPrompt()` is the original text, unchanged; `buildHouseholdPrompt()` is much shorter because a household has no khata.
- **Isolation is by `workspace_id`, not `user_id`** — the same person owns both ledgers, so `user_id` alone would show the groceries inside the shop's `/summary`. Every transaction read filters on both.
- **The workspace is stamped on the message at arrival and read back off the locked row at confirmation**, never from the user's current setting. Otherwise switching workspaces between typing and tapping Confirm would misfile the transaction.
- **The AI is instructed, never trusted.** The prompt is told which types exist; `isTypeAllowedInWorkspace()` in `src/schemas/transaction.schema.js` is what actually enforces it, so a hallucinated `credit_sale` on a grocery message cannot open a khata.
- `transactions.workspace_id` is deliberately nullable: rows predating `ebcb1a0` have no `user_id`, so they cannot be backfilled. They are invisible to every query either way — see `migrations/002_workspaces.sql`.

## Languages

English, Hindi and Gujarati. `src/i18n/` holds one catalog per language
(`en.js` is the reference, ~127 keys) plus `index.js` with `LANGUAGES`, `t()`,
`translator()`, `isLanguage()`, `enumLabel()`, `formatDate()` and
`formatMonth()`. No i18n dependency.

**Every user-facing string in the bot goes through the catalog.** The one
deliberate exception is the language picker itself, which is sent before the
language is known and therefore carries all three at once.

- **`users.language` NULL means "has not chosen yet"**, exactly as NULL
  `onboarding_done_at` means "not finished". No column default, because a
  default cannot be told apart from a deliberate choice of English.
  `migrations/004_language.sql` backfills existing users to `'en'` so nobody
  already using the bot is stopped and asked.
- **The language is asked before the ledger**, because every other word
  depends on it. `startSetup()` is the single gate: it sends the language
  picker, then the ledger picker, and the eight `if (!user.language ||
  !workspace)` sites all call it.
- **The picker is the one message that cannot be translated** — it is sent
  before the answer exists — so it carries all three languages and leans on
  buttons written in their own scripts.
- **Changing it later: `/language`, the 🌐 row on `/workspace`, or a line in
  `/help`.** All three reuse `askToChooseLanguage()` and the `lang:` callback;
  `lang:pick` reopens the picker, `lang:<code>` sets it. `handleLanguageAction`
  passes `{ ...user, language: code }` onward, because `user` was read before
  the update and the confirmation must arrive in the *new* language.
- **`t()` falls back to English twice** — unknown language, then unknown key —
  which is what lets the catalogs grow one screen at a time. That same
  fallback makes a forgotten translation invisible at runtime, so
  `tests/i18n.test.js` asserts the three catalogs have identical keys,
  identical placeholders, no blanks and no untranslated copies. It also checks
  `LANGUAGES` against the migration's `CHECK` constraint.
- **The AI is told the language for one field only:** `buildSystemPrompt`
  appends `Write "description" in <language>.` English appends nothing, so it
  pays zero extra prompt tokens. `person` and `category` stay in English
  letters — that is what keeps the `(user_id, lower(name))` customer lookup
  matching a name typed two ways.
- **Database identifiers never reach the user.** `enumLabel(lang, "type", x)`
  and `enumLabel(lang, "cat", x)` turn `credit_sale` and `groceries` into
  words. It falls back to the **raw value**, not the key — `category` is a
  free `z.string()` in the schema, so the AI can return `chai` and showing
  `chai` beats showing `cat.chai`. The message `status` enum was removed from
  its message rather than given labels: "already confirmed" vs "already
  answered" is not something a user can act on.
- **`formatDate()` / `formatMonth()` own every user-facing date.** Two ICU
  traps they exist to avoid: Gujarati's `toLocaleDateString` inserts a comma
  (`16 ઑગસ્ટ, 2026`), so the parts are assembled by hand; and `month: "short"`
  in Hindi is `अग॰`, which reads as a typo — long month names everywhere.
  `-u-nu-latn` pins Latin digits so a date can never come back in Devanagari
  numerals beside a ₹ amount in Latin ones.
- **`money()` and `today()` are not localized.** `en-IN` grouping and ₹ are
  right for all three. `today()` is a MACHINE format feeding a SQL `::date`
  cast — never send it to a user; three display sites used to.
- **Workspace names are translated at creation** (`WORKSPACE_KINDS[].nameKey`).
  The name is stored on the row, so existing ledgers keep what they were
  called and only new ones follow the user's language.

### The confirmation card

Three rows, not six — the shape was rewritten after a native Gujarati speaker
could not read it:

```
📝 લખું?

ખર્ચ: કરિયાણું          ← the TYPE is the label, the thing is the value
રકમ: ₹500
તારીખ: 16 ઑગસ્ટ 2026
```

- **The transaction type is the first row's LABEL.** `Type: expense` plus
  `Description: groceries` were saying the same thing twice, once as a raw
  identifier and once in the user's language. `transactionCard()` builds this
  and is shared by the confirm card and the saved card, so tapping Confirm
  does not reshuffle the message.
- **Category is not shown.** It cannot be corrected from the card, it only
  feeds the `/monthly` breakdown, and it was the row duplicating the
  description.
- **Quantity appears only when it is more than 1.** `કેટલું: 1` on every
  ordinary entry was noise, and it read as a second amount above the real one.
- **The khata block is one arrow line** (`રાજનું બાકી: ₹5,000 → ₹7,000`)
  rather than the old `Currently owes:` / `After this entry:` pair.

### `/help` is `/start`

`/help` used to be a second near-copy of `sendWelcomeHelp` that showed the
shop commands to household users and patched it with a footnote. It now calls
`sendWelcomeHelp(chatId, user, workspace)`, which branches on ledger type — so
a household user is never shown `/udhaar`. Slash command NAMES stay ASCII
(Telegram requires it); only the description beside each one is translated.

## Onboarding

A new user picks a language, then is walked through recording one **real**
transaction, then offered the chance to delete it so their real books open at
zero.

- **It never assumes `/start`.** Most people open a bot and type "hii". Every
  command and the free-text handler check `if (!user.language || !workspace)`
  and route to `startSetup()`, so onboarding begins from any first contact.
  That check runs *before* the AI call, so a first message costs nothing.
- **Language, then workspace, are the gate.** No workspace means no ledger, so
  nothing else in the bot can run until both questions are answered. This is
  why `startSetup()` is called from eight places rather than one.
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

- **Confirmation flow is database-backed, not in-memory.** An incoming message is saved to the `messages` table and moved through a status lifecycle: `RECEIVED → PROCESSING → PENDING_CONFIRMATION → CONFIRMED | CANCELLED | FAILED`. The AI-extracted entries are stored as JSONB in `messages.transaction_data` while awaiting confirmation. Callback data on the buttons is just `confirm:<telegram_message_id>` / `cancel:<telegram_message_id>`; everything else is looked up in Postgres.
- **Confirmation is atomic and race-safe:** `confirmMessageTransaction()` in `database/transactions.js` uses `BEGIN` + `SELECT ... FOR UPDATE` to lock the message row, inserts the transactions, and marks the message `CONFIRMED` in one transaction. It returns `{success, reason}` objects (`NOT_FOUND`, `ALREADY_PROCESSED`, `TRANSACTION_DATA_MISSING`) rather than throwing for expected failures. There is no separate `createTransaction` — the INSERT inside this function is the only place transaction rows are created.
- **Idempotency via upserts:** `findOrCreateUser` upserts on `telegram_user_id`; `createMessage` uses `ON CONFLICT ... DO NOTHING` on `(user_id, telegram_message_id)`, and the transaction insert on `(user_id, telegram_message_id, seq)`.
- **All dates/times use the `Asia/Kolkata` timezone** and amounts are displayed in ₹ (INR). `today()` formats with `toLocaleDateString("en-CA")` to get the `YYYY-MM-DD` string SQL takes as `::date` — that is a machine format and must never be sent to a user; `formatDate()` in `src/i18n/` is what the user sees.

## One message, several entries

A shopkeeper closing up types the day in one go — *"400 nu dudh lavya, 300 no
kpda dhova no sabu lavya"*. Both prompts ask for a **JSON list always**, and
`processMessage` returns `{ intent: "transaction", transactions: [...], skipped }`.

- **`migrations/005_multi_transaction.sql` is what made it possible.** Until
  then `UNIQUE (user_id, telegram_message_id)` meant one message could hold
  exactly one transaction — and because the insert used `ON CONFLICT ... DO
  NOTHING`, a loop would have written the first entry and reported success for
  all of them. The constraint was **widened** with a `seq` column rather than
  dropped, so that upsert stays a working double-tap guard per entry.
- **One card, one tap, all or nothing.** `askToConfirm()` in `bot.js` shows
  `transactionListCard()` with a total; `confirmMessageTransaction` writes
  every row in the `BEGIN`/`COMMIT` it already had. A failure on entry 3 leaves
  entries 1 and 2 unwritten, which is what the single button promises.
- **A bad entry is dropped, not fatal.** Entries are validated one at a time,
  so a missing amount loses that line and not the four beside it. What was
  dropped is always reported (`skipped.*` keys) — never silent.
- **`MAX_ENTRIES` is 10.** Past that the card stops being checkable and one tap
  would write too much. The overflow is named, not swallowed.
- **The "was this a repayment?" question carries an index** (`repayment:<msgid>:<i>`)
  when a message has several entries: the tap records the answer into
  `transaction_data[i]` and asks the next one. A **single-entry** message sends
  no index and keeps its original one-tap confirm-and-save behaviour — two
  paths, deliberately, so the common one could not regress.
- **Everything reads `transaction_data` as a list** via `[x].flat()`, so
  messages stored before this feature are still confirmable.
- Transaction types: a shop uses `sale | purchase | expense | payment_received | payment_sent | credit_sale | repayment | other`; a household uses `expense | income | other`. `expense` is the only one both share.
