# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot that turns natural-language messages ("Bought a laptop for ₹50,000") into bookkeeping transactions. Gemini (`gemini-3.1-flash-lite`), falling back to Groq (`openai/gpt-oss-120b`), extracts structured JSON from the message, Zod validates it, the user confirms via inline Telegram buttons, and the confirmed transaction is stored in PostgreSQL.

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
npm test         # schema + summary + ledger + gym + sheet + ratelimit + i18n. No DB, no API key, free.
npm run test:db  # tests/udhaar.integration.js — real Postgres. Needs DATABASE_URL.
npm run test:ws  # tests/workspace.integration.js — workspace isolation. Needs DATABASE_URL.
npm run test:onb # tests/onboarding.integration.js — onboarding + practice-data cleanup. Needs DATABASE_URL.
npm run test:lang # tests/language.integration.js — users.language, the CHECK, and what must not reset it. Needs DATABASE_URL.
npm run test:ai  # tests/ai.test.js — live AI classification. Needs an API key, costs calls.
```

No linter is configured. Every integration suite creates throwaway users and deletes everything it creates in a `finally` block; existing data is never touched. `npm run test:all` runs all of them except `test:ai`, which is left out because it costs API calls.

Required env vars (in `.env`, loaded via `dotenv/config`): `GROQ_API_KEY`, `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`.

Optional: `GEMINI_API_KEY` enables the Gemini fallback (see below); `GEMINI_MODEL` overrides the default `gemini-3.1-flash-lite`, and `GROQ_MODEL` the default `openai/gpt-oss-120b`.

Optional, gym only: `GYM_SHEET_URL` and `GYM_SHEET_SECRET` (see **The gym
module**). Deliberately NOT in the boot check — a missing gym variable must
never stop the bookkeeping bot from starting.

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
   order in `bot.js` is registration order. Slash commands (`/start`, `/help`, `/menu`, `/summary`, `/transactions`, `/monthly`, `/udhaar`, `/workspace`, `/language`), free-text message handler, and the `callback_query` handler (confirm/cancel, payment clarification, ledger switching and creation, menu screens, language selection). This is the orchestrator. `resolveShopkeeper()` is the single chokepoint that resolves both the user and their active workspace — the language rides along on the same `users` row, so reading it costs nothing extra.
2. **`src/services/transaction.service.js`** — `processMessage(text, telegramMessageId, language, ledgerName)`: asks the AI, `JSON.parse`s the reply, validates each entry with `MessageSchema` (Zod), attaches the Telegram message ID. Does not touch the database. There is no workspace type guard any more — there are no per-ledger rules left to enforce.
3. **`src/ai/groq.service.js`** — exports `askAI(message, language, ledgerName)`, which tries **Gemini** (`gemini-3.1-flash-lite`) first and falls back to **Groq** (`openai/gpt-oss-120b`) on any failure. Gemini leads because its limit is per-minute (15 rpm, recovers in a minute) while Groq's is per-day (100k tokens, then the shop is down until tomorrow). Also holds `buildSystemPrompt(language, ledgerName)` — ONE prompt for every ledger now, and both providers share it so they cannot drift — and strips markdown fences from either response. Without `GEMINI_API_KEY` it calls Groq directly, exactly as before the fallback existed.

   Model IDs are pinned deliberately — never use `-latest` aliases, which get repointed without warning. Both providers also *retire* models outright: `gemini-2.0-flash` 404s, and so does `llama-3.3-70b-versatile`, which was Groq's pin until a `tests/ai.test.js` run caught it. Groq now runs `openai/gpt-oss-120b`, overridable with `GROQ_MODEL` exactly as `GEMINI_MODEL` overrides Gemini.

   **The fallback needs testing on its own.** Gemini answers almost every message, so Groq is only reached when Gemini fails — which means a dead fallback looks identical to a working one for months. `GEMINI_API_KEY= node tests/ai.test.js` forces the Groq path.
4. **`src/database/`** — all SQL lives here (pg `Pool`, raw queries), one file
   per concern: `pool.js` (imports nothing local, so `pool` stays a singleton and
   `pool.end()` drains what every query uses), `users.js`, `workspaces.js`,
   `transactions.js` (incl. `confirmMessageTransaction()`), `messages.js`,
   `customers.js`, `onboarding.js`. No ORM. Schema changes live in `migrations/` as numbered `.sql` files, wrapped in one `BEGIN`/`COMMIT` with commented rollback at the bottom. They are **never run automatically** — review and apply them by hand. The `users`, `messages` and `transactions` tables predate the repo and have no `CREATE TABLE` on disk.
5. **`src/services/summary.service.js` / `monthly-summary.service.js`** — `summarize(rows)` lives in the first and is imported by the second and by `getMonthlySummaryAll()`, so there is exactly one implementation of "what do these rows add up to".

## Ledgers (the `workspaces` table)

A user keeps as many ledgers as they want, each one an **emoji and a name they
typed**: 🏪 Kirana Store, 🏠 Ghar, 🏍️ Bike. `users.active_workspace_id` is the
switcher state; `/menu` and `/workspace` show it.

Until `migrations/006_open_ledgers.sql` there were exactly two kinds, a
`shopkeeper` and a `household`, and `workspaces.type` drove five things. It now
drives nothing and is kept nullable for one release so a rollback needs no
second migration — drop it in 007.

- **Identity is the NAME.** `UNIQUE (user_id, lower(name))` replaced
  `UNIQUE (user_id, type)`, which is what capped a user at two. `lower()` for
  the same reason `customers_user_name_unique` uses it, and it keeps
  "+ New ledger" idempotent against a double-tapped button.
- **Creation is one message.** The user sends `🏍️ Bike`; `parseLedger()` in
  `telegram/onboarding.js` splits it with `Intl.Segmenter`, which walks
  *grapheme clusters* — a `\p{Extended_Pictographic}` regex returns `👨` from
  `👨🏽‍🌾` and glues the rest to the name. Flags need `\p{Regional_Indicator}`
  too, since 🇮🇳 is two of those and neither is pictographic.
- **`users.pending_action`** is how the bot remembers it asked. NULL for
  everyone almost always. A column and not a Map because the bot restarts on
  every deploy. It is checked *before* the AI call and cleared *first*, so a
  throw cannot trap someone in a question they cannot escape.
- **`LEDGER_STARTERS` in `core.js` is first-run only** — two ready-made ledgers
  so somebody who typed "hii" starts with a tap rather than composing an emoji.
  A ledger made from a starter is indistinguishable from one named by hand.
- **`MAX_LEDGERS` is 20, in JS not SQL.** A per-user row limit needs a trigger;
  one `if` says the same and can explain itself in the user's language.
- **Isolation is by `workspace_id`, not `user_id`** — the same person owns them
  all, so `user_id` alone would show the groceries inside the shop's `/summary`.
  Every transaction read filters on both. The one deliberate exception is
  `getMonthlySummaryAll()`, which is *meant* to cross ledgers; its join to
  `workspaces` is what keeps it inside the user.
- **The workspace is stamped on the message at arrival and read back off the
  locked row at confirmation**, never from the user's current setting.
  Otherwise switching between typing and tapping Confirm would misfile the row.
- `transactions.workspace_id` is deliberately nullable for rows predating
  `ebcb1a0` — see `migrations/002_workspaces.sql`.

## The menu

`/menu`, `/start` and `/help` are all `sendWelcomeHelp()`. Four buttons:
this month here, this month everywhere, switch ledger, new ledger — plus the
language row. The active ledger's name is inside the *button label*, so it can
be tapped without reading the message. `menu:` is routed in `callbacks.js`
above the `Number(messageId)` parse and whitelisted against `MENU_SCREENS`,
exactly like `ws:` / `lang:` / `onb:`.

## Languages

English, Hindi and Gujarati. `src/i18n/` holds one catalog per language
(`en.js` is the reference, ~145 keys) plus `index.js` with `LANGUAGES`, `t()`,
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

### `/help` is `/start` is `/menu`

All three call `sendWelcomeHelp(chatId, user, workspace)` — see **The menu**
above. It used to branch on ledger type so a household was never shown
`/udhaar`; there is nothing left to branch on, because every ledger does
everything. Slash command NAMES stay ASCII (Telegram requires it); only the
description beside each one is translated.

## The money model

**The AI answers the DIRECTION, not a type name.** A fixed `transaction_type`
enum only works if the code knows what each member *means* — that `credit_sale`
is goods-out-no-cash, that `repayment` is cash-but-not-revenue. That knowledge
was a lookup table spread across `summary.service.js`, `customers.js`,
`khata.js` and `cards.js`, and a lookup table is the opposite of a ledger the
user invented and named themselves.

Two fields, both `NOT NULL` with a `CHECK`, both `z.enum` in the schema:

```
cash   — "in" | "out" | "none"          did rupees actually move?
udhaar — "they_owe_more" | "they_owe_less"
       | "i_owe_more" | "i_owe_less" | "none"
```

- **They are independent, and that is the point.** A credit sale moves debt and
  no cash; a repayment moves both; a gift moves cash and no debt. A single flat
  enum had to invent a name for every combination, which is why it kept growing
  — and it still could not record `i_owe_more`, money the *user* borrowed.
- **`transaction_type` survives as a free-text LABEL**, written by the AI in the
  user's language. Nothing branches on it. `enumLabel()` falls back to the raw
  value, so "ઉધાર" renders as itself and pre-006 rows carrying `expense` still
  render through the `type.*` catalog — which is why those keys stay.
- **`amount` is validated positive.** The direction is carried by the two
  fields, never by a minus sign: an expense sent as `-500` would *subtract* from
  the outgoings it belongs in, and nothing would look broken.
- **`transactions.owed_delta` is a GENERATED column** — the four-way udhaar →
  plus-or-minus rule, derived by Postgres on write. Every khata query is
  `SUM(owed_delta)`. It replaced five hand-written copies of that `CASE`.
  `owedDelta()` in `transaction.schema.js` is its JS twin, used for one thing:
  previewing `₹5,000 → ₹5,500` on a card whose row does not exist yet. Keep the
  two in step; `tests/workspace.integration.js` asserts they agree.
- **The khata is signed and user-wide.** Positive = they owe you, negative = you
  owe them. Not scoped by ledger, deliberately: Raj owes *you*, not your Kirana
  book, and someone you both lend to and borrow from is one number rather than
  two half-truths.
- **The confirmation card prints the direction in words, and that is a guard.**
  Handing the model the arithmetic means a wrong `cash: "in"` on a light bill is
  *valid input*. Zod and the `CHECK` can only refuse a value outside the enum;
  that row is what lets the person who was there refuse a wrong one.

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
- **The tour offers every feature to every ledger.** There used to be a
  `FEATURES_BY_WORKSPACE` table so a household was never shown a khata; it is
  gone with `TYPES_BY_WORKSPACE`, because a household borrows from an uncle as
  readily as a shop lends to a regular, and a ledger named "Bike" is neither.
  The buttons are built from `TOUR`'s own keys, so a feature cannot exist in
  one place and not the other.
- **`TOUR` in `telegram/onboarding.js` holds each feature's label and handler in one entry**,
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
- See **The money model** above: there are no transaction types, only `cash` and `udhaar`.

## The gym module

`src/gym/` is a **second, unrelated product** living in the same bot: a daily
fitness check-in that writes one row into a coach's Google Sheet. It is not
bookkeeping and shares no code with it.

**It must stay that way.** The isolation is the design, not an accident:

- `src/gym/` imports nothing from the rest of `src/` except `zod`. It has its
  own model call (`ai.js`, duplicating the Gemini→Groq fallback on purpose),
  its own three-language strings (`text.js`), its own schema and prompt.
- Only `src/gym/telegram.js` reaches out, read-only, for `bot` and
  `resolveShopkeeper`. It lives in `src/gym/` rather than `src/telegram/`
  because `tests/i18n.test.js` scans that folder and asserts every `tr()` key
  exists in the BOOKKEEPING catalog — a gym handler there fails a bookkeeping
  test for using its own strings.
- The entire footprint on the ledgers is **one import line in `bot.js`**.
  Deleting the feature is deleting `src/gym/`, two test files, and that line.

Do not refactor a shared helper to serve both. Duplicating a small amount of
code is the cheaper trade: the money path holds a shop's accounts and the gym
path is a personal log, and a shared helper means a change to one can break
the other.

- **No confirmation card**, unlike every bookkeeping write. A transaction is
  confirmed first because money is hard to unwind. A check-in writes one
  spreadsheet cell keyed by date, so sending the day again overwrites the same
  row — the correction IS the flow. The reply prints back exactly what was
  written, so a misread is caught immediately instead of by the coach a week
  later.
- **`src/gym/Checkin.gs` is a STANDALONE Apps Script**, created at
  script.google.com and not from the sheet's Extensions menu — that menu is
  greyed out on a file owned by someone else. Standalone runs as the user,
  using their own edit rights, so nothing has to be shared with a service
  account. That is also why there is no Google Cloud project: a service account
  would need *share* rights on the coach's file, not just edit.
- **Nothing about the sheet layout is hardcoded.** No A1 ranges, no column
  letters, no row numbers. The tracker is a merged-cell grid — week blocks, an
  AVERAGES row between them, dates written as "27 July" with no year — and it
  all shifts when the coach inserts a row. The script reads the sheet's own
  headers and matches by label: exact first, then containment, because
  "Hydration" has to find "Hydration/Fluid Intake" and "discomfort" has to find
  "Did you face any physical discomfort or pain?".
- **A label that matches nothing is reported, never swallowed.** The script
  answers `unmatched: <labels>` and the bot logs it. That is what a renamed
  header looks like, and it is the failure the whole match-by-label approach
  exists to make visible.
- **`tests/sheet.test.js` loads `Checkin.gs` itself** with `node:vm` and calls
  its functions against a reconstruction of the real grid. The helpers are pure
  ES5 and touch no Apps Script API, so what is proven is the file that gets
  pasted rather than a copy that drifts.
- **After any edit to `Checkin.gs`: Deploy > Manage deployments > edit >
  Version: New.** Otherwise the old code keeps answering and it looks like
  nothing changed. `Run > test_findsTodaysRow` writes nothing and logs every
  label it found plus today's row — run that first when something is wrong.
