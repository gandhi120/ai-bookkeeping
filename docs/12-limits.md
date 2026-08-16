← [The test layer](11-testing.md)  ·  [Index](../ARCHITECTURE.md)  ·  [How to add a transaction type](13-adding-a-type.md) →

---

# What is deliberately NOT built

Every one of these is a known ceiling, not an oversight. Each says what would
hit it first.

### `customers` has no `workspace_id`

Customers belong to a `user_id`, not a workspace. It is safe **today** because a
household can never produce a `credit_sale` or `repayment` — the only two types
that create a customer — so a household can never reach a khata.

**What hits it first:** a second shop per user, or any household feature that
needs to name a person as more than free text. Adding the column then means a
migration and a backfill.

### No foreign key from `transactions` to `messages`

They are matched on `(user_id, telegram_message_id)` because `transactions`
existed first ([relationships](03-relationships.md)).

**What hits it first:** any feature needing to walk from a transaction back to
its message cheaply. Also the `text`/`bigint` mismatch below.

### `transactions.telegram_message_id` is `text`, `messages` is `bigint`

Every join between them needs `::text` (`database/onboarding.js`).

**What hits it first:** a second join site. One cast is a quirk; three is a bug
waiting to happen. The fix is its own migration, flagged in
`003_onboarding.sql:31`.

### Most `transactions` columns are nullable

`amount` and `transaction_type` can be NULL at the database level. Zod is the
only thing stopping it, and Zod only guards the path that exists today
([the tables](02-tables.md)).

**What hits it first:** any import script, admin tool, or backfill that writes
to `transactions` without going through `processMessage`.

### `src/server.js` and the `fastify` dependency are dead code

This ceiling **resolved itself**, and the leftovers are worth knowing about.

`src/server.js` was a Fastify health endpoint on port 3000 that knew nothing
about Telegram, while the bot ran as a separate process. Deploying meant two
entry points, and the prediction here was that webhooks would force them to
meet.

That is what happened — but the bot grew **its own** webhook server instead
(`telegram/core.js`), so `npm start` now runs the bot and nothing imports `server.js`
or `fastify` at all.

```js
const webhookUrl = process.env.WEBHOOK_URL;
```

`WEBHOOK_URL` is the only switch: set it and the bot serves webhooks on `PORT`
with `/healthz` open and the bot token in the URL path as authentication; leave
it unset and it polls. Production sets it, a laptop does not — so local
development needs no ngrok and no code change.

**What hits it first:** nothing, which is the point. Deleting `src/server.js`
and dropping `fastify` from `package.json` is pure subtraction whenever someone
feels like it.

### No auth beyond the Telegram user id

Identity is "Telegram says this message came from user 917617580". No password,
no session, no 2FA. Reasonable — Telegram already authenticated them — but it
means Telegram account access is total access.

**What hits it first:** a web dashboard, or any second client.

### No ORM

Raw SQL through `pg`, all of it under `src/database/` — one file per table-ish
concern: `pool.js`, `users.js`, `workspaces.js`, `transactions.js`,
`messages.js`, `customers.js`, `onboarding.js`. That is why this document can
show you the actual queries; an ORM would hide them behind method chains.

`pool.js` is the one every other file imports and it imports nothing local.
ESM caches modules by URL, so `pool` is a singleton no matter how many files
ask for it — which is what lets `pool.end()` at shutdown drain the connections
every query function is using. **If a second `Pool` ever came into existence the
symptom would be the test suites hanging instead of exiting**, so a clean exit
is worth watching for, not just a green log.

**What hits it first:** honestly, not much at this size. Every query being
visible is a feature.

### No migration runner

Migrations are applied by hand ([migrations](10-migrations.md)).

**What hits it first:** more than one environment, or more than one person
deploying. Then "which migrations has staging had?" becomes a real question with
no recorded answer.

### `bot.js` has no direct tests

**Mostly resolved — worth reading as a worked example of removing a ceiling.**

The blocker used to be that `new TelegramBot(token, { polling: true })` ran at
**import time**, so importing the module opened a live Telegram connection and
no test could touch it.

The fix was two options on the constructor (`telegram/core.js`):

```js
// Neither transport is started here — `autoOpen: false` and `polling: false`
// keep the constructor off the network, so importing this file is free. The
// bottom of the file starts whichever one is configured.
export const bot = new TelegramBot(
  token,
  webhookUrl
    ? { webHook: { port: …, healthEndpoint: "/healthz", autoOpen: false } }
    : { polling: false }
);
```

Construction is now inert; the transport starts at the bottom of the file only
when the module is the process entry point. So `bot.js` is importable, and
anything it exports is testable — which `tests/ratelimit.test.js` does for
`overRateLimit()` with no database and no API key.

**What is still untested:** the handler bodies. They need a fake `bot` object to
drive, which is a bigger job. What is covered now is the logic that guards money
— and `overRateLimit` is squarely that:

```js
// The AI budget is shared across every user and resets daily, so one person
// pasting a hundred lines does not cost them anything — it takes the whole
// shop down until tomorrow.
export function overRateLimit(telegramUserId, now = Date.now()) {
```

Note `now = Date.now()` as a **parameter with a default**. Production calls it
with no argument; the test passes a fake clock and checks the 60-second window
without waiting 60 seconds. Injecting time is almost always cheaper than mocking
it.

The split into eight files ([the code map](09-code-map.md)) narrowed the gap without writing a
single new test, because it separated the parts that need a live `bot` from the
parts that do not. **`telegram/cards.js` is now the cheapest thing in the repo
to test**: `transactionCard()`, `transactionListCard()` and `summaryBody()` take
plain objects and return strings. No bot instance, no database, no API key.
That is the next test to write, and it did not exist as an option while
everything lived in one file.

Two checks in `tests/i18n.test.js` already read the handlers as **text** rather
than running them — asserting no `catch` block references `user` (a bug that
once shipped in seven handlers at once) and that every `tr()` key exists in the
catalog. They glob `src/telegram/*.js` deliberately: pointed at `bot.js` alone
they would now scan a 138-line entry file containing **zero** translation keys
and pass while testing nothing. A test that quietly stops testing is worse than
no test.

**What hits the remaining gap first:** handler branching growing past simple
`if (!user.language || !workspace)` checks. Every phase in `FUTURE_FEATURES.md`
adds handlers.

### Not built at all, on purpose

Investments, stocks, mutual funds, loans, insurance, tax planning, budgeting,
financial advice, bank integrations, UPI, OCR/receipt scanning, multi-user
permissions, an AI financial advisor, advanced analytics.

Not because they are bad ideas. Because a bookkeeping tool that records
transactions correctly is worth more than one that does nine things
approximately.

---

---

← [The test layer](11-testing.md)  ·  [Index](../ARCHITECTURE.md)  ·  [How to add a transaction type](13-adding-a-type.md) →
