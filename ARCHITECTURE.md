# Backend Architecture — a guided tour

This document explains the backend of this project from the ground up: every
table, every relationship, why each one exists, and the code that uses it.

It is written for someone who knows JavaScript and React Native but has not
worked much with SQL or servers. Where something is new, it is anchored to
something you already know from the frontend.

Every section has three parts:

1. **A worked example** — a real message going in, the real rows it produces,
   the real reply that comes out.
2. **The actual code**, quoted from this repo, then explained line by line.
3. **Why** — what breaks if you do it the other way.

Read it in pieces. Come back to it.

> `CLAUDE.md` is the short version, written to orient an AI agent in ten
> seconds. This is the long version, written to teach.
> `FUTURE_FEATURES.md` is where this goes next.
>
> Line references like `bot.js:96` are navigation aids and drift as the code
> changes. The **function and constant names** are the durable part — grep for
> those if a number no longer lands where it should.

---

## Table of contents

1. [What the product is](#1-what-the-product-is)
2. [The 30-second mental model](#2-the-30-second-mental-model)
3. [The five tables](#3-the-five-tables)
4. [Relationships, taught not just listed](#4-relationships-taught-not-just-listed)
5. [Why isolation is by workspace_id, not user_id](#5-why-isolation-is-by-workspace_id-not-user_id)
6. [The confirmation flow](#6-the-confirmation-flow)
7. [Why the workspace is stamped on the message](#7-why-the-workspace-is-stamped-on-the-message)
8. [The AI layer as an untrusted boundary](#8-the-ai-layer-as-an-untrusted-boundary)
9. [The khata (udhaar / credit book)](#9-the-khata-udhaar--credit-book)
10. [The payment ambiguity problem](#10-the-payment-ambiguity-problem)
11. [Onboarding](#11-onboarding)
12. [Every command, and what it touches](#12-every-command-and-what-it-touches)
13. [Migrations](#13-migrations)
14. [The test layer](#14-the-test-layer)
15. [What is deliberately NOT built](#15-what-is-deliberately-not-built)
16. [How to add a new transaction type](#16-how-to-add-a-new-transaction-type)

---

## 1. What the product is

A shopkeeper in India keeps their books in a paper notebook. Sales, purchases,
expenses, and — most importantly — **udhaar**: goods given on credit, tracked
per customer in a *khata*.

Software exists for this. Shopkeepers do not use it, because every one of them
is a form: pick a category from a dropdown, type an amount, pick a date, tap
save. That is slower than the notebook.

This product removes the form. You type what happened, in whatever language you
think in, and it becomes a bookkeeping entry.

The same person also has a home. Rent, groceries, electricity, salary coming
in. That is a completely different set of books which must never mix with the
shop's — so one user can keep **two ledgers** and switch between them.

### The whole product, in one transcript

```
You    Raj took goods for ₹2,000 on udhaar

Bot    📝 Please confirm

       Type: credit_sale
       Description: Goods taken on udhaar
       Category: sales
       Quantity: 1
       Amount: ₹2,000
       Date: 16 Aug 2026
       Customer: Raj
       Currently owes: ₹0
       After this entry: ₹2,000

       [ ✅ Confirm ]  [ ❌ Cancel ]

You    (taps ✅ Confirm)

Bot    ✅ Transaction saved

       Type: credit_sale
       Description: Goods taken on udhaar
       Amount: ₹2,000

       📒 Raj now owes ₹2,000

You    How much does Raj owe me?

Bot    📒 Raj owes you ₹2,000.

You    /summary

Bot    📊 🏪 My Shop — Daily Summary

       Date: 2026-08-16

       Sales: ₹2,000
       Purchases: ₹0
       Expenses: ₹0
       Net Balance: ₹2,000

       Transactions: 1
```

That is the entire product. Everything in this document exists to make those
six exchanges correct, safe, and impossible to corrupt.

### What each piece does

| Piece | Job |
|---|---|
| **Telegram** | The entire UI. No app to install — shopkeepers already have Telegram. |
| **Node.js + `node-telegram-bot-api`** | Receives messages, sends replies. |
| **Gemini / Groq (LLM)** | Turns `"Raj took goods for ₹2,000 on udhaar"` into structured JSON. |
| **Zod** | Checks that JSON is actually the right shape before anything trusts it. |
| **PostgreSQL** | Stores everything. The source of truth. |

Note the LLM's job is *narrow*. It reads a sentence and returns JSON. It does
not decide what is allowed, does not touch the database, and does not choose
which ledger anything goes into. Section 8 covers why.

---

## 2. The 30-second mental model

```
   Telegram message
         │
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  src/telegram/bot.js          the orchestrator        │
   │  - who is this user?  which workspace are they in?    │
   └───────────────────────────────────────────────────────┘
         │
         ▼  save the raw message immediately (status RECEIVED)
   ┌───────────────────────────────────────────────────────┐
   │  messages table                                       │
   └───────────────────────────────────────────────────────┘
         │
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  src/services/transaction.service.js                  │
   │  understand the message — never touches the database  │
   └───────────────────────────────────────────────────────┘
         │
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  src/ai/groq.service.js                               │
   │  Gemini  ──fails?──▶  Groq        (one shared prompt) │
   └───────────────────────────────────────────────────────┘
         │  raw JSON text
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  JSON.parse  →  Zod MessageSchema  →  workspace guard  │
   │  the trust boundary                                    │
   └───────────────────────────────────────────────────────┘
         │
         ▼  store the extracted data, status PENDING_CONFIRMATION
   ┌───────────────────────────────────────────────────────┐
   │  messages.transaction_data  (JSONB)                   │
   └───────────────────────────────────────────────────────┘
         │
         ▼  bot shows a preview with Confirm / Cancel buttons
         │
         │  ⏸  nothing more happens until the user taps
         │
         ▼  user taps ✅ Confirm
   ┌───────────────────────────────────────────────────────┐
   │  src/database/postgres.js                             │
   │  confirmMessageTransaction()                          │
   │  BEGIN → lock row → insert → mark CONFIRMED → COMMIT  │
   └───────────────────────────────────────────────────────┘
         │
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  transactions table          the actual books         │
   └───────────────────────────────────────────────────────┘
```

### The same trip, function by function

You type `"Raj took goods for ₹2,000 on udhaar"`. Here is every hop:

| # | Where | Function | What it returns |
|---|---|---|---|
| 1 | `bot.js:1138` | `bot.on("message")` fires | — |
| 2 | `bot.js:96` | `resolveShopkeeper(from, chat)` | `{ user, workspace }` |
| 3 | `postgres.js:189` | `createMessage(...)` | the `messages` row, status `RECEIVED` |
| 4 | `postgres.js:222` | `updateMessageStatus(id, "PROCESSING")` | updated row |
| 5 | `transaction.service.js:23` | `processMessage(text, msgId, "shopkeeper")` | calls the AI ↓ |
| 6 | `groq.service.js:272` | `askAI(message, "shopkeeper")` | raw JSON **text** |
| 7 | `transaction.service.js:35-40` | `JSON.parse` → `MessageSchema.parse` | validated object |
| 8 | `postgres.js:239` | `updateMessageTransactionData(...)` | data stored as JSONB |
| 9 | `postgres.js:222` | `updateMessageStatus(id, "PENDING_CONFIRMATION")` | updated row |
| 10 | `bot.js:1322` | `bot.sendMessage(...)` with buttons | preview shown |

**…then it stops and waits.** Possibly for hours. Possibly across a server
restart. When the user finally taps Confirm:

| # | Where | Function | What it returns |
|---|---|---|---|
| 11 | `bot.js:1392` | `bot.on("callback_query")` fires | — |
| 12 | `postgres.js:262` | `getMessageByTelegramMessageId(...)` | the pending message row |
| 13 | `postgres.js:425` | `confirmMessageTransaction(...)` | `{ success: true, transaction }` |
| 14 | `bot.js:1577` | `bot.editMessageText(...)` | preview replaced with the result |

### The one rule that shapes all of it

**Nothing is written to the books without the user tapping Confirm.**

An LLM is a very good guesser and an occasional confident liar. `"Raj paid
1000"` is genuinely ambiguous — it might settle a debt or might not. So the
architecture never asks the model to be right; it asks the model to *propose*,
and asks the human to *approve*.

That single decision is why `messages` has a `status` column, why the extracted
data is parked in `transaction_data` before it becomes a real row, and why
confirmation has to be a locked database transaction. Sections 6 and 7 are
entirely about consequences of this rule.

---

## 3. The five tables

```
  ┌─────────┐
  │  users  │  one row per Telegram account
  └────┬────┘
       │ 1
       │
       │ many          ┌──────────────┐
       ├──────────────>│  workspaces  │  "My Shop" / "My Home"
       │               └──────┬───────┘
       │                      │ 1
       │                      │
       │ many                 │ many      ┌───────────────┐
       ├──────────────────────┴──────────>│  transactions │  the books
       │                                  └───────┬───────┘
       │                                          │
       │ many                                     │ many
       ├──────────────────────────────────────────┤
       │                                          ▼ 1
       │                                  ┌───────────────┐
       │                                  │   customers   │  the khata
       │                                  └───────────────┘
       │ many
       │               ┌──────────────┐
       └──────────────>│   messages   │  every incoming text
                       └──────────────┘

  users.active_workspace_id ──────> workspaces   (which ledger is open now)

  messages ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ transactions
      linked by (user_id, telegram_message_id) — NO foreign key
```

Five tables. Two of them (`users`, `transactions`) predate this repository and
have no `CREATE TABLE` on disk — they were made by hand early on. The other
three were added by the numbered migrations in `migrations/`.

---

### 3.1 `users` — one row per Telegram account

| Column | Type | Null? | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | primary key, `gen_random_uuid()` |
| `telegram_user_id` | `bigint` | NOT NULL | **UNIQUE** — the real identity |
| `telegram_chat_id` | `bigint` | NOT NULL | where to send replies |
| `phone_number` | `text` | null | unused so far |
| `first_name` | `text` | null | Telegram makes this optional |
| `username` | `text` | null | optional, and changeable |
| `created_at` | `timestamptz` | NOT NULL | `now()` |
| `updated_at` | `timestamptz` | NOT NULL | `now()` |
| `active_workspace_id` | `uuid` | null | → `workspaces.id` — the switcher |
| `onboarding_done_at` | `timestamptz` | null | NULL = still in the tutorial |

**Sample row:**

| id | telegram_user_id | first_name | active_workspace_id | onboarding_done_at |
|---|---|---|---|---|
| `a3f1…` | `917617580` | `Varun` | `7c2e…` (My Shop) | `2026-08-16 04:55:12+05:30` |

#### Why `id` is a uuid and not the Telegram id

You could use `telegram_user_id` as the primary key. It is already unique. But
then every other table would carry a Telegram id, and the day you add a web
login or a WhatsApp version, every table needs changing. `id` is *our* identity;
`telegram_user_id` is just how they happen to reach us today.

#### The upsert

`findOrCreateUser` (`postgres.js:22`) is called on **every single message**.
There is no signup step:

```sql
INSERT INTO users (telegram_user_id, telegram_chat_id, first_name, username)
VALUES ($1, $2, $3, $4)
ON CONFLICT (telegram_user_id)
DO UPDATE SET
  telegram_chat_id = EXCLUDED.telegram_chat_id,
  first_name       = EXCLUDED.first_name,
  username         = EXCLUDED.username,
  updated_at       = NOW()
RETURNING *;
```

Line by line:

- **`INSERT INTO … VALUES ($1, …)`** — `$1` is a *placeholder*. You never paste
  values into SQL text; you pass them separately and the driver keeps them as
  data. This is what makes SQL injection impossible. Think of it as
  `` `SELECT ${name}` `` being banned and a parameter array being required.
- **`ON CONFLICT (telegram_user_id)`** — "if a row with this
  `telegram_user_id` already exists, don't error, do this instead."
- **`DO UPDATE SET … = EXCLUDED.…`** — `EXCLUDED` is the row you *tried* to
  insert. So this means "keep the existing row, but refresh these fields with
  the new values." If someone changes their Telegram display name, we pick it up
  automatically.
- **`RETURNING *`** — give back the whole row, whether it was inserted or
  updated. Without this you would need a second `SELECT`.

The whole thing is one round trip and is safe to call a thousand times. In React
terms: an **idempotent** operation. Calling it again does not change the result.

---

### 3.2 `workspaces` — a ledger, not an account

| Column | Type | Null? | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | primary key |
| `user_id` | `uuid` | NOT NULL | → `users.id`, **ON DELETE CASCADE** |
| `name` | `text` | NOT NULL | "My Shop" / "My Home" — display only |
| `type` | `text` | NOT NULL | **CHECK** `IN ('shopkeeper','household')` |
| `created_at` | `timestamptz` | NOT NULL | `now()` |
| `updated_at` | `timestamptz` | NOT NULL | `now()` |

Plus `UNIQUE (user_id, type)` — **one shop and one home per user, maximum.**

**Sample rows** (this is the real live data — one user, two workspaces):

| id | user_id | name | type |
|---|---|---|---|
| `7c2e…` | `a3f1…` | My Shop | `shopkeeper` |
| `b81d…` | `a3f1…` | My Home | `household` |

#### `type` is the most important column in the database

It is only a `text` column, but it decides four separate things downstream:

| What it decides | Where |
|---|---|
| Which system prompt the AI receives | `groq.service.js:25` `buildSystemPrompt()` |
| Which transaction types are legal | `transaction.schema.js:91` `isTypeAllowedInWorkspace()` |
| Which features the ledger offers | `transaction.schema.js:62` `featuresForWorkspace()` |
| How `/summary` and `/monthly` render | `summary.service.js:14` `summarize()` |
| Whether `/udhaar` works at all | `bot.js:887` |

Three lists in `transaction.schema.js` are keyed by it — what a ledger can
**record** (`TYPES_BY_WORKSPACE`), what it can **do** (`FEATURES_BY_WORKSPACE`,
section 11.5), and which categories it offers (`HOUSEHOLD_CATEGORIES`).

#### `name` is display-only, on purpose

Nothing ever looks a workspace up by name. If it did, renaming "My Shop" to
"Dad's Shop" would break things. Names are for humans; `type` is for code; `id`
is for joins. Keeping those three jobs in three columns means each can change
without touching the others.

#### The CHECK constraint

```sql
type text NOT NULL CHECK (type IN ('shopkeeper', 'household'))
```

A `CHECK` is a rule the database itself enforces on every insert and update. If
a bug somewhere tried to write `type = 'shopkeper'` (typo), the database rejects
it outright. Application code can have bugs; the constraint cannot be bypassed
by any of them.

**This is a theme you will see repeatedly:** put the rule as close to the data
as possible. TypeScript types vanish at runtime. A `CHECK` constraint does not.

---

### 3.3 `customers` — the khata

| Column | Type | Null? | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | primary key |
| `user_id` | `uuid` | NOT NULL | → `users.id`, **ON DELETE CASCADE** |
| `name` | `text` | NOT NULL | "Raj" |
| `phone` | `text` | null | shopkeeper's own reference |
| `created_at` | `timestamptz` | NOT NULL | `now()` |
| `updated_at` | `timestamptz` | NOT NULL | `now()` |

Plus `UNIQUE (user_id, lower(name))` and an index on `user_id`.

**Sample rows:**

| id | user_id | name | phone |
|---|---|---|---|
| `5a90…` | `a3f1…` | Raj | `null` |
| `c714…` | `a3f1…` | Amit | `null` |

#### A customer is a *passive record*

Notice what is missing: no `telegram_user_id`, no password, no status, no login.
Customers **never use this bot**. They are names in the shopkeeper's notebook.
The shopkeeper types "Raj"; a row appears. Raj does not know the row exists.

This is worth internalising because it is a common design mistake. The instinct
is "a customer is a user, so it goes in the users table." No — a *user* is
someone who authenticates and sends messages. A *customer* is data about
somebody. Merging them would mean every customer row needs a nullable
`telegram_user_id`, nullable auth, a "has this person signed up?" flag, and
suddenly every query has to care.

#### `UNIQUE (user_id, lower(name))` — a functional index

Two things happening here:

- **`(user_id, name)` not just `(name)`** — user A's "Raj" and user B's "Raj"
  are different people with different debts. Uniqueness must be *per
  shopkeeper*. Getting this wrong would be a data leak, not just a bug.
- **`lower(name)` not `name`** — indexing the *result of a function*. Postgres
  stores the lowercased value in the index, so `"Raj"`, `"raj"` and `"RAJ"` all
  collide and resolve to the same khata. Without it a shopkeeper would slowly
  accumulate three Rajs with a third of the debt each.

The lookup in `getCustomerByName` (`postgres.js:317`) matches the index exactly:

```sql
SELECT * FROM customers
WHERE user_id = $1 AND lower(name) = lower($2);
```

Writing `WHERE lower(name) = lower($2)` is what lets Postgres *use* the
`lower(name)` index instead of scanning every row. An index only helps if the
query is shaped like the index.

---

### 3.4 `messages` — every incoming text, and its lifecycle

| Column | Type | Null? | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | primary key |
| `user_id` | `uuid` | NOT NULL | → `users.id` |
| `workspace_id` | `uuid` | NOT NULL | → `workspaces.id` — **stamped at arrival** |
| `telegram_message_id` | `bigint` | NOT NULL | Telegram's own id |
| `message_text` | `text` | NOT NULL | exactly what was typed |
| `status` | `text` | NOT NULL | CHECK, 7 values, default `'RECEIVED'` |
| `transaction_data` | `jsonb` | null | the AI's extraction, parked here |
| `is_onboarding` | `boolean` | NOT NULL | default `false` — practice data |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL | `now()` |

Plus `UNIQUE (user_id, telegram_message_id)`.

**Sample row** (mid-flow, waiting for a tap):

| column | value |
|---|---|
| `id` | `e9c2…` |
| `user_id` | `a3f1…` |
| `workspace_id` | `7c2e…` (My Shop) |
| `telegram_message_id` | `4471` |
| `message_text` | `Raj took goods for ₹2,000 on udhaar` |
| `status` | `PENDING_CONFIRMATION` |
| `transaction_data` | `{"transaction_type":"credit_sale","amount":2000,"person":"Raj", …}` |
| `is_onboarding` | `false` |

#### Why store the message at all?

Three reasons, in order of importance:

1. **It is the pending state.** Between the preview and the tap, the extracted
   transaction has to live *somewhere*. It lives in `transaction_data`.
2. **Debugging.** When a shopkeeper says "it recorded the wrong thing", the
   exact text they typed is on disk next to what the AI made of it.
3. **Idempotency.** Telegram sometimes delivers the same message twice. The
   `UNIQUE (user_id, telegram_message_id)` makes the second delivery harmless.

#### The status lifecycle

```
                    RECEIVED
                       │
                       ▼
                   PROCESSING ──────────────► FAILED
                       │                    (AI error, bad JSON,
        ┌──────────────┼──────────────┐      Zod rejection)
        ▼              ▼              ▼
    ANSWERED   PENDING_CONFIRMATION
  (a question,        │
   nothing to    ┌────┴────┐
   confirm)      ▼         ▼
             CONFIRMED  CANCELLED
```

Enforced by the database, not by hope (`001_shopkeeper_udhaar.sql:79`):

```sql
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN (
  'RECEIVED', 'PROCESSING', 'PENDING_CONFIRMATION',
  'CONFIRMED', 'CANCELLED', 'FAILED', 'ANSWERED'
));
```

If you add a new status in JavaScript and forget the migration, the insert
fails loudly and immediately. That is the desired behaviour: a typo in a status
string becomes an error instead of a row nobody can query.

**React Native analogy:** this is a reducer's state machine, except the valid
states are enforced by the store itself rather than by a `switch` you have to
remember to update.

#### `transaction_data` is `jsonb`, not columns

`jsonb` is Postgres's binary JSON type. You can store an arbitrary object and
still query into it.

Why not give `messages` proper columns for amount, type, description? Because
this data is **not yet real**. It is a proposal awaiting approval. Giving it
real columns would mean two nearly-identical schemas — one for proposed
transactions, one for confirmed ones — that must be kept in sync forever.

`jsonb` keeps the proposal shapeless and cheap. The moment it is approved, it
becomes a properly-columned row in `transactions`. **The shape of the data
follows its status.**

---

### 3.5 `transactions` — the actual books

This is the oldest table and it shows.

| Column | Type | Null? | Notes |
|---|---|---|---|
| `id` | **`bigint`** | NOT NULL | ⚠️ not a uuid like everything else |
| `created_at` | `timestamptz` | NOT NULL | `now()` |
| `transaction_type` | `text` | **null** | ⚠️ no CHECK constraint |
| `description` | `text` | null | |
| `category` | `text` | null | |
| `quantity` | `bigint` | null | default `1` |
| `amount` | `numeric` | **null** | ⚠️ |
| `person` | `text` | null | free text — a name as typed |
| `transaction_date` | `date` | null | the *business* date, not insert time |
| `notes` | `text` | null | |
| `telegram_message_id` | **`text`** | null | ⚠️ `text` here, `bigint` on `messages` |
| `user_id` | `uuid` | **null** | → `users.id` |
| `customer_id` | `uuid` | null | → `customers.id` — only for udhaar |
| `workspace_id` | `uuid` | **NOT NULL** | → `workspaces.id` |

**Sample row:**

| column | value |
|---|---|
| `id` | `34` |
| `transaction_type` | `credit_sale` |
| `description` | `Goods taken on udhaar` |
| `category` | `sales` |
| `quantity` | `1` |
| `amount` | `2000.00` |
| `person` | `Raj` |
| `transaction_date` | `2026-08-16` |
| `telegram_message_id` | `4471` |
| `user_id` | `a3f1…` |
| `customer_id` | `5a90…` |
| `workspace_id` | `7c2e…` |

#### The four warnings, explained honestly

**⚠️ `id` is `bigint`, not `uuid`.** Every other table uses uuid. This one was
created before that convention existed. It works fine. Changing it now would
mean rewriting every foreign key for no user-visible benefit — a real cost for
zero value. This is what living code looks like: it carries its history.

**⚠️ Almost everything is nullable.** `amount` can be NULL at the database
level. `transaction_type` can be NULL. The protection is one layer up, in Zod
(`transaction.schema.js:112`), where every one of those fields is *required*:

```js
const TransactionIntentSchema = z.object({
  intent: z.literal("transaction"),
  transaction_type: z.enum(TRANSACTION_TYPES),
  description: z.string(),
  category: z.string(),
  quantity: z.number().int(),
  amount: z.number(),
  person: z.string().nullable(),
  transaction_date: z.string(),
  notes: z.string().nullable(),
});
```

Note `person` and `notes` are explicitly `.nullable()` — those genuinely can be
absent. `amount` is not, which is the point: a transaction with no amount would
pass into `/summary` and silently contribute nothing. It would not crash. It
would just make the totals quietly wrong, which is worse.

**This is a real gap.** Zod protects the one path that exists today. A future
script inserting directly into `transactions` would have no such protection.
Tightening these columns is a legitimate future migration — it is listed in
section 15.

**⚠️ `telegram_message_id` is `text` here and `bigint` on `messages`.** Two
different developers-in-time made two different choices. It matters because
joining the tables needs an explicit cast (`postgres.js:633`):

```sql
AND t.telegram_message_id = m.telegram_message_id::text
```

Postgres will not silently compare a `text` to a `bigint` — it refuses. That
refusal is a feature; JavaScript's `==` would have quietly compared `"4471"` to
`4471` and let a whole class of bug through. The cast is documented in
`003_onboarding.sql:31`.

#### `transaction_date` vs `created_at`

Two different dates, and the difference matters:

- **`created_at`** — when the row was written. Set by the database.
- **`transaction_date`** — when the *business event* happened. Comes from the
  message.

Type "Yesterday I bought rice for ₹600" and you get `created_at` = today,
`transaction_date` = yesterday. `/summary` filters on `transaction_date`,
because a shopkeeper asking about yesterday means yesterday's business, not
yesterday's typing.

#### `customer_id` is nullable *on purpose*

Only `credit_sale` and `repayment` link to a customer. A rice purchase or an
electricity bill has no customer, and NULL is the correct representation of
"there is no customer here" — not a placeholder row, not an empty string.

The decision is made in code (`transaction.schema.js:102`):

```js
export const CUSTOMER_TRANSACTION_TYPES = ["credit_sale", "repayment"];

export function isCustomerTransaction(transactionType) {
  return CUSTOMER_TRANSACTION_TYPES.includes(transactionType);
}
```

---

## 4. Relationships, taught not just listed

### 4.1 What a foreign key actually does

```sql
user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
```

A **foreign key** tells the database that this column's value must exist as a
key in another table. Three consequences:

1. **You cannot insert a workspace for a user that does not exist.** The
   database rejects it. In React you would guard this in code and hope every
   code path remembered; here it is impossible by construction.
2. **You cannot delete a user who still has workspaces** — unless you say what
   should happen, which is what `ON DELETE CASCADE` does.
3. **The database can plan joins better**, because it knows the relationship
   exists.

### 4.2 The delete rules differ between tables, deliberately

This is genuinely important and easy to miss:

| Foreign key | On delete | Meaning |
|---|---|---|
| `workspaces.user_id → users.id` | **CASCADE** | delete a user → their workspaces vanish |
| `customers.user_id → users.id` | **CASCADE** | delete a user → their customers vanish |
| `transactions.user_id → users.id` | **NO ACTION** | delete blocked while rows exist |
| `transactions.workspace_id → workspaces.id` | **NO ACTION** | delete blocked |
| `transactions.customer_id → customers.id` | **NO ACTION** | delete blocked |
| `messages.user_id → users.id` | **NO ACTION** | delete blocked |
| `users.active_workspace_id → workspaces.id` | **NO ACTION** | delete blocked |

`NO ACTION` is the Postgres default when you write nothing — and here the
default is exactly right.

**Why the asymmetry?** Structure cascades; **financial records do not**. A
workspace is scaffolding — if the user is gone, the container is meaningless.
A transaction is a *record of something that happened*. It should never
disappear as a side effect of deleting something else. If you try, the database
stops you and makes you decide explicitly.

**This has a concrete consequence**, in `finishOnboarding()` (`postgres.js:672`).
Deleting practice data must go **transactions first, then messages, then
customers**:

```js
// Leaves first. transactions reference customers AND workspaces with
// NO ACTION (not CASCADE), so deleting in any other order fails on a
// foreign key violation.
```

Delete the customer first and Postgres refuses, because a transaction still
points at it. The order is not style — it is forced by the schema.

### 4.3 What a composite UNIQUE index buys you

Three in this schema, each preventing a specific disaster:

```sql
UNIQUE (user_id, type)                  -- workspaces
UNIQUE (user_id, lower(name))           -- customers
UNIQUE (user_id, telegram_message_id)   -- messages AND transactions
```

**`workspaces (user_id, type)`** — at most one shop and one home per user.
This is what makes the "+ Add Household" button safe to double-tap. Buttons
*get* double-tapped, especially on slow connections where nothing appears to
happen. Without this, an impatient user ends up with two homes and half their
groceries in each.

The upsert that relies on it (`postgres.js:98`):

```sql
INSERT INTO workspaces (user_id, name, type)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, type)
DO UPDATE SET updated_at = NOW()
RETURNING *;
```

Second tap → `ON CONFLICT` fires → `DO UPDATE` touches `updated_at` → the
**same** workspace comes back via `RETURNING`. The user sees one home. The code
did not need an `if (alreadyExists)` check, and could not lose a race even if it
had one.

**`transactions (user_id, telegram_message_id)`** — this one was a **real bug
fix**, `001_shopkeeper_udhaar.sql:58`:

```sql
-- Telegram message ids restart per chat, so two shopkeepers both produce
-- message id 42. The old global UNIQUE made the second shopkeeper's insert
-- fail, rolling back their confirmation. Scope the uniqueness to the user.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS unique_telegram_message;
ALTER TABLE transactions ADD CONSTRAINT transactions_user_msg_unique
  UNIQUE (user_id, telegram_message_id);
```

The original constraint was `UNIQUE (telegram_message_id)` — globally unique.
That is fine with one user and **catastrophic with two**: Telegram numbers
messages per chat, so the second shopkeeper's message #42 collided with the
first shopkeeper's, and their Confirm silently failed.

The lesson generalises: *an id from an external system is only unique within
that system's scope.* Always ask "unique with respect to what?"

### 4.4 The link with no foreign key

`transactions` and `messages` are related — every confirmed transaction came
from a message — but **there is no foreign key between them.** They are matched
on the pair `(user_id, telegram_message_id)`, which is UNIQUE on both.

That is what makes this join possible (`postgres.js:629`):

```sql
t.user_id = $1
AND m.user_id = $1
AND m.is_onboarding
AND t.telegram_message_id = m.telegram_message_id::text
```

Because the pair is unique on both sides, the join matches **at most one
transaction per message** — the same guarantee a foreign key would give,
obtained from the unique indexes instead.

Would a proper `messages_id` FK column on `transactions` be cleaner? Yes. It
is not there for the ordinary reason: `transactions` existed before `messages`
did. Section 15 lists it.

### 4.5 Why `workspace_id` is NOT NULL but `customer_id` is not

```sql
ALTER TABLE messages     ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE transactions ALTER COLUMN workspace_id SET NOT NULL;
```

`workspace_id` is NOT NULL because **isolation is only real if the column can
never be empty**. A single row with `workspace_id = NULL` is a row that belongs
to no ledger — invisible to every query, or worse, visible to the wrong one.
NOT NULL makes that state unrepresentable.

`customer_id` stays nullable because "no customer" is a **legitimate, common
state** — most transactions have no customer at all.

The distinction: NULL is correct when absence is meaningful. NULL is a bug when
absence means "we forgot".

---

## 5. Why isolation is by `workspace_id`, not `user_id`

**This is the single most important rule in the codebase.**

Every query that reads ledger data filters on `workspace_id`. Not `user_id`.

### The failure it prevents

One person owns both ledgers. Same `user_id` on every row. Consider a real
Saturday:

| id | user_id | workspace_id | type | description | amount |
|---|---|---|---|---|---|
| 41 | `a3f1…` | `7c2e…` **My Shop** | `sale` | Sold 5 shirts | 2500 |
| 42 | `a3f1…` | `7c2e…` **My Shop** | `purchase` | Bought rice stock | 600 |
| 43 | `a3f1…` | `b81d…` **My Home** | `expense` | Groceries | 500 |
| 44 | `a3f1…` | `b81d…` **My Home** | `income` | Salary | 65000 |

Now the shopkeeper opens the shop and types `/summary`.

**Filtering on `user_id` alone — wrong:**

```sql
SELECT * FROM transactions WHERE user_id = $1 AND transaction_date = $2;
-- returns rows 41, 42, 43, 44
```

```
📊 🏪 My Shop — Daily Summary
Sales: ₹2,000          ← wrong, and it gets worse
Expenses: ₹500         ← that is the family's groceries
Transactions: 4        ← two of these are not the shop's
```

The home's ₹500 grocery bill is now a **shop expense**. The ₹65,000 salary is
sitting in the shop's books. Every number is wrong, and — this is the dangerous
part — *none of it looks wrong*. There is no error, no crash, no red screen.
Just quietly incorrect books that someone might file taxes from.

**Filtering on `workspace_id` — right** (`postgres.js:148`):

```sql
SELECT * FROM transactions
WHERE user_id = $1
  AND workspace_id = $2
  AND transaction_date = $3::date
ORDER BY created_at DESC;
-- returns rows 41, 42 only
```

```
📊 🏪 My Shop — Daily Summary
Sales: ₹2,500
Purchases: ₹600
Expenses: ₹0
Net Balance: ₹1,900
Transactions: 2
```

### Why `user_id` is *still* in the WHERE clause

Look again — the query checks **both**. Strictly, `workspace_id` alone is
enough: a workspace belongs to exactly one user, so `workspace_id = '7c2e…'`
already implies `user_id = 'a3f1…'`.

It is kept as defence in depth. If a bug ever passed the wrong `workspace_id` —
a stale value, a mixed-up variable, a forged one from a button — `user_id` is a
second lock. One user seeing another user's numbers is not a bug, it is a
**data breach**. Two conditions where one would do is a very cheap insurance
premium.

From `postgres.js:143`:

```
// Scoped by workspace_id, not user_id: the same user owns both their shop and
// their home, so user_id alone would show the household groceries inside the
// shop's /summary. user_id is kept in the WHERE as well — it is implied by
// the workspace, but checking both means a wrong id can never cross tenants.
```

### Every query that enforces it

| Function | File:line | Filters on |
|---|---|---|
| `getTransactionsByDate` | `postgres.js:148` | `user_id` + `workspace_id` + date |
| `getTransactionsByMonth` | `postgres.js:166` | `user_id` + `workspace_id` + month range |
| `createMessage` | `postgres.js:189` | writes `workspace_id` |
| `confirmMessageTransaction` | `postgres.js:425` | reads `workspace_id` off the locked row |
| `getWorkspaces` | `postgres.js:62` | `user_id` |
| `setActiveWorkspace` | `postgres.js:119` | `user_id` + ownership check |

And the khata functions (`getCustomerBalance`, `getAllOutstanding`) filter on
`user_id` + `customer_id` — see section 15 for why that is sufficient today.

### The chokepoint that makes it hard to get wrong

Every handler starts the same way (`bot.js:96`):

```js
async function resolveShopkeeper(from, chat) {
  const user = await findOrCreateUser({
    telegram_user_id: from.id,
    telegram_chat_id: chat.id,
    first_name: from.first_name,
    username: from.username,
  });

  return { user, workspace: await getActiveWorkspace(user.id) };
}
```

One function returns both ids. There is no path where you naturally get a
`user` without also getting a `workspace`. Making the correct thing the *easy*
thing is a better defence than a comment saying "remember to scope by
workspace".

`workspace` is `undefined` for a brand new user who has not picked a ledger
yet, and every handler checks for it explicitly rather than guessing a default
(`bot.js:518`, `bot.js:613`, `bot.js:698`, `bot.js:833`, `bot.js:858`,
`bot.js:1170`).

### The test that guards it

From `tests/workspace.integration.js` — a real database, throwaway users:

```js
check("shop summary excludes household rows", shopRows.length, 1);
check("household summary excludes shop rows", homeRows.length, 1);
```

This was deliberately broken during development: `getTransactionsByMonth` was
changed to filter on `user_id` instead of `workspace_id`, and **four isolation
checks went red**. Then it was reverted. A safety net you have never seen catch
anything is a safety net you do not know works.

---

## 6. The confirmation flow

Nothing enters the books without a human tap. That sentence has a lot of
engineering behind it.

### 6.1 Why it is database-backed and not an in-memory Map

The obvious implementation:

```js
// what this code does NOT do
const pending = new Map();
pending.set(messageId, transaction);
```

That works until any of these:

- **The server restarts.** Every pending confirmation evaporates. The user taps
  Confirm and gets "Transaction not found" for something they typed 30 seconds
  ago.
- **You run two instances.** Instance A holds the pending state; the tap lands
  on instance B, which has never heard of it.
- **The user waits.** People start typing and get interrupted by a customer.
  They tap Confirm twenty minutes later.

`Map` also gives you no history. When something goes wrong there is nothing to
look at.

So the pending state lives in Postgres: `status = 'PENDING_CONFIRMATION'` plus
`transaction_data` as JSONB. The button carries **only** the Telegram message
id (`bot.js:1436`):

```js
callback_data: `confirm:${message.message_id}`
```

Everything else is looked up again. This is not only about restarts —
Telegram caps `callback_data` at **64 bytes**, so stuffing a transaction into
the button was never an option anyway. The constraint pushed toward the right
design.

**React Native analogy:** this is the difference between component state and
persisted storage. Pending confirmations are not UI state; they are application
state that must outlive the process.

### 6.2 The status at every step

Follow one message, `"Raj took goods for ₹2,000 on udhaar"`:

| Step | Code | `messages.status` | `transaction_data` |
|---|---|---|---|
| 1. Message arrives | `bot.js:1274` `createMessage` | `RECEIVED` | `null` |
| 2. About to call the AI | `bot.js:1202` | `PROCESSING` | `null` |
| 3. AI answered, Zod passed | `bot.js:1361` | `PROCESSING` | `{…}` written |
| 4. Preview sent | `bot.js:1274` | `PENDING_CONFIRMATION` | `{…}` |
| 5. ⏸ waiting for a tap | — | `PENDING_CONFIRMATION` | `{…}` |
| 6. Confirm tapped | `postgres.js:586` | `CONFIRMED` | `{…}` (kept) |

Alternative endings: `CANCELLED` (user tapped Cancel), `FAILED` (AI error or
bad JSON — `bot.js:1364`), `ANSWERED` (it was a question, nothing to confirm —
`bot.js:1238`).

`transaction_data` is deliberately **not** cleared on confirm. It is the record
of what the AI proposed, which is what you want when someone reports that a
transaction is wrong.

### 6.3 `confirmMessageTransaction()` line by line

This is the most important function in the codebase (`postgres.js:425`). It
does three things that must all happen or none: resolve the customer, insert
the transaction, mark the message confirmed.

```js
const client = await pool.connect();
```

**Why a `client` and not `pool.query`?** A pool holds several connections and
hands out whichever is free. A database transaction (`BEGIN`…`COMMIT`) lives
**on one connection**. Using the pool for individual queries would scatter them
across different connections, and `BEGIN` on one is invisible to another.

`pool.connect()` reserves one connection for the whole operation.

```js
await client.query("BEGIN");
```

**`BEGIN` starts a database transaction.** From here until `COMMIT`, everything
is provisional. Nobody else sees it. A `ROLLBACK` undoes all of it.

*This is the all-or-nothing update you already know from state management:* you
do not want a half-applied change where the transaction row exists but the
message still says pending.

```js
const messageResult = await client.query(
  `
  SELECT id, user_id, workspace_id, status, transaction_data
  FROM messages
  WHERE id = $1 AND user_id = $2
  FOR UPDATE;
  `,
  [messageId, userId]
);
```

**`FOR UPDATE` is the row lock, and it is the whole point of this function.**

It means: read this row *and hold it*. Any other transaction trying to
`SELECT … FOR UPDATE` the same row **waits** until this one commits or rolls
back. Not an error — it blocks, then proceeds.

Note `AND user_id = $2`. Even here, scoped.

```js
if (!message) { await client.query("ROLLBACK"); return { success: false, reason: "NOT_FOUND" }; }

if (message.status !== "PENDING_CONFIRMATION") {
  await client.query("ROLLBACK");
  return { success: false, reason: "ALREADY_PROCESSED", status: message.status };
}

if (!message.transaction_data) {
  await client.query("ROLLBACK");
  return { success: false, reason: "TRANSACTION_DATA_MISSING" };
}
```

**Three guards, and note they `return` rather than `throw`.** These are
*expected* outcomes, not exceptional ones — a user double-tapping is normal
behaviour, not an error condition. Exceptions are for the unexpected; a result
object is for outcomes you anticipated. The caller reads `result.reason` and
picks a message (`bot.js:1518-1475`).

```js
const transactionType = typeOverride ?? message.transaction_data.transaction_type;
```

The human's clarification beats the AI's guess (section 10). `??` — nullish
coalescing — not `||`, because `||` would also replace an empty string.

```js
let customerId = null;

if (isCustomerTransaction(transactionType) && message.transaction_data.person) {
  const customer = await findOrCreateCustomer(client, userId, message.transaction_data.person);
  customerId = customer.id;
}
```

**`findOrCreateCustomer(client, …)` — the `client` is passed in.** This is the
subtle bit. If it used `pool.query` internally it would run on a *different
connection*, outside this `BEGIN`. Then if the insert below failed and rolled
back, the transaction would vanish but **the customer row would survive** — a
phantom "Raj" with no entries.

Passing the client means the customer creation is part of the same atomic unit.
From `postgres.js:291`:

```
// IMPORTANT: this takes the caller's `client` instead of using the pool.
// The pool hands out separate connections, and a BEGIN on one connection is
// invisible to another.
```

```sql
INSERT INTO transactions (user_id, workspace_id, transaction_type, …)
VALUES ($1, $2, $3, …)
ON CONFLICT (user_id, telegram_message_id) DO NOTHING
RETURNING *;
```

`workspace_id` comes from `message.workspace_id` — **the locked message row**,
never the user's current setting. Section 7 is entirely about why.

`ON CONFLICT … DO NOTHING` makes the insert idempotent. But it creates a
wrinkle handled at `postgres.js:571`:

```js
let transaction = transactionResult.rows[0];

if (!transaction) {
  const existing = await client.query(
    `SELECT * FROM transactions WHERE user_id = $1 AND telegram_message_id = $2;`,
    [userId, message.transaction_data.telegram_message_id]
  );
  transaction = existing.rows[0];
}
```

`DO NOTHING` returns **no row** when it skipped. That is not an error — it means
an earlier attempt already saved it. So fetch the existing row and carry on to
mark the message confirmed. Treating "already done" as success is what makes
retries safe.

```js
await client.query(
  `UPDATE messages SET status = 'CONFIRMED', updated_at = NOW() WHERE id = $1;`,
  [message.id]
);

await client.query("COMMIT");
```

**`COMMIT` makes everything real, at once.** Until this line, no other
connection could see any of it.

```js
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
```

`ROLLBACK` on any unexpected error. `finally` returns the connection to the
pool **always** — forget this and the pool leaks connections until the app
hangs. It is the `finally` in a `try/finally` around a resource, same as always.

### 6.4 The double-tap trace

Two Confirm taps arrive at nearly the same moment.

| Time | Tap A | Tap B | Database |
|---|---|---|---|
| t0 | `BEGIN` | | |
| t1 | `SELECT … FOR UPDATE` → **holds lock** | | status `PENDING_CONFIRMATION` |
| t2 | | `BEGIN` | |
| t3 | | `SELECT … FOR UPDATE` → **blocks** ⏳ | B is now waiting |
| t4 | inserts transaction | ⏳ still waiting | |
| t5 | `UPDATE … status = 'CONFIRMED'` | ⏳ still waiting | |
| t6 | `COMMIT` → **lock released** | | status `CONFIRMED` |
| t7 | | lock acquired, reads status = **`CONFIRMED`** | |
| t8 | | guard fires → `ROLLBACK` | |
| t9 | | returns `ALREADY_PROCESSED` | |

One transaction row. Tap B sees a toast: "Transaction already confirmed."

**Now the same trace without `FOR UPDATE`:**

| Time | Tap A | Tap B |
|---|---|---|
| t1 | reads status = `PENDING_CONFIRMATION` ✓ | |
| t2 | | reads status = `PENDING_CONFIRMATION` ✓ ← **both passed the guard** |
| t3 | inserts transaction | |
| t4 | | inserts transaction ← **duplicate** |

Both taps read the row *before* either wrote to it, so both passed the
`status === 'PENDING_CONFIRMATION'` check. This is a **race condition**, and it
is the kind that does not show up in testing — it needs two taps within
milliseconds, which QA rarely does and real users on a bad connection do
constantly.

In this specific case `ON CONFLICT (user_id, telegram_message_id) DO NOTHING`
would *also* have caught it, since both rows share a message id. That is not
redundancy by accident — it is two independent mechanisms guarding the same
invariant, and the one that does not depend on getting the lock right is the
one you want holding the money.

---

## 7. Why the workspace is stamped on the message

A subtle bug that is easy to ship and hard to find.

### The hazard

The user has both ledgers. There is a gap — sometimes hours — between typing a
message and tapping Confirm. What if they switch workspaces in between?

**The wrong implementation** reads the workspace at confirmation time:

| Time | Action | Active workspace | Result |
|---|---|---|---|
| 10:00 | types "Sold 5 shirts for ₹2,500" | 🏪 My Shop | preview shown |
| 10:01 | `/workspace` → switches | 🏠 My Home | |
| 10:02 | goes back and taps ✅ Confirm | 🏠 My Home | ❌ **shop sale filed at home** |

The shop's sale is now in the household ledger. And `sale` is not even a legal
household type, so the books are not just wrong, they are incoherent.

There is no error. The user tapped Confirm and saw "✅ Transaction saved". The
mistake only surfaces weeks later when the month's totals do not match.

### The fix: stamp at arrival, read back at confirmation

**Stamp it when the message arrives** (`postgres.js:189`):

```sql
INSERT INTO messages (
  user_id, workspace_id, telegram_message_id, message_text, status, is_onboarding
)
VALUES ($1, $2, $3, $4, $5, $6)
```

with the comment at `postgres.js:183`:

```
// workspace_id is stamped here, at arrival, and never re-read from the user's
// current setting afterwards. That is what makes confirmation safe: the user
// can switch workspaces between typing a message and tapping Confirm, and the
// transaction still lands in the ledger they typed it into.
```

**Read it back off the locked row at confirmation** (`postgres.js:438`):

```sql
SELECT id, user_id, workspace_id, status, transaction_data
FROM messages
WHERE id = $1 AND user_id = $2
FOR UPDATE;
```

then, in the insert (`postgres.js:550`):

```js
userId,
// Taken from the locked MESSAGE row, never from the user's current
// active workspace — see the comment on createMessage.
message.workspace_id,
```

**With the fix:**

| Time | Action | Active workspace | `messages.workspace_id` | Result |
|---|---|---|---|---|
| 10:00 | types "Sold 5 shirts for ₹2,500" | 🏪 My Shop | **`7c2e…` (Shop)** | preview |
| 10:01 | switches | 🏠 My Home | `7c2e…` unchanged | |
| 10:02 | taps ✅ Confirm | 🏠 My Home | reads `7c2e…` | ✅ **filed in the shop** |

### The principle

**Record the context at the moment of the decision, not at the moment of the
side effect.**

The user decided which ledger this belonged to when they typed the message —
they were looking at the shop. Their setting *now* is a different fact about a
different moment. Reading current state to interpret a past intent is the bug.

This same shape appears everywhere: an order should store the price at purchase
time, not read today's price. An invoice should store the tax rate that applied
then. Do not resolve historical intent through current state.

### The test that guards it

From `tests/workspace.integration.js` — this is the scenario, automated:

```js
// message created while active workspace is the shop
// then active workspace is switched to the household
// then confirm
check("transaction filed in the workspace it was typed in",
      transaction.workspace_id, shop.id);
```

---

## 8. The AI layer as an untrusted boundary

### 8.1 What the AI actually does

One job: turn a sentence into JSON.

**Input:** `"Raj took goods for ₹2,000 on udhaar"`

**Output:**

```json
{
  "intent": "transaction",
  "transaction_type": "credit_sale",
  "description": "Goods taken on udhaar",
  "category": "sales",
  "quantity": 1,
  "amount": 2000,
  "person": "Raj",
  "transaction_date": "2026-08-16",
  "notes": null
}
```

**Input:** `"How much does Raj owe me?"`

```json
{ "intent": "balance_query", "person": "Raj" }
```

**Input (Gujarati):** `"કિરાણા માટે ₹500 ખર્ચ્યા"` — *"spent ₹500 on groceries"*

```json
{
  "intent": "transaction",
  "transaction_type": "expense",
  "description": "Groceries",
  "category": "groceries",
  "quantity": 1,
  "amount": 500,
  "person": null,
  "transaction_date": "2026-08-16",
  "notes": null
}
```

The same message in English, Gujarati script, Roman Gujarati or Hinglish must
produce **identical JSON**. That is instructed explicitly in both prompts, and
`person` and `category` are always written back in English letters with grammar
endings stripped — `રાજેશ` / `રાજેશે` / `"Rajesh ne"` all become `"Rajesh"`.
Without that, the same customer would open three different khatas.

### 8.2 Two providers, one prompt

```js
export async function askAI(message, workspaceType = "shopkeeper") {
  if (!process.env.GEMINI_API_KEY) {
    return await askGroq(message, workspaceType);
  }

  try {
    return await askGemini(message, workspaceType);
  } catch (geminiError) {
    console.warn("Gemini failed, falling back to Groq:", geminiError.message);

    try {
      return await askGroq(message, workspaceType);
    } catch (groqError) {
      throw new Error(
        `Both providers failed. Gemini: ${geminiError.message} | Groq: ${groqError.message}`
      );
    }
  }
}
```

**Why Gemini first?** Not speed or quality — **the shape of the rate limit**:

| Provider | Free tier limit | Recovery when exhausted |
|---|---|---|
| Gemini `gemini-3.1-flash-lite` | 15 requests **per minute** | ~60 seconds |
| Groq `llama-3.3-70b-versatile` | 100k tokens **per day** | tomorrow |

Hit Gemini's limit and a busy shopkeeper waits a minute. Hit Groq's and the
shop is down until midnight. So the limit that recovers fast is spent first, and
the scarce daily budget is held in reserve.

**Why both errors are surfaced:** if only the Groq error propagated, a typo in
the Gemini API key would look like a Groq outage. Debugging that is miserable.

**Why one shared prompt** (`groq.service.js:25`):

```js
function buildSystemPrompt(workspaceType) {
  return workspaceType === "household"
    ? buildHouseholdPrompt()
    : buildShopkeeperPrompt();
}
```

Both providers call this. If the fallback had its own prompt, the two would
drift — and then the *same sentence would book differently depending on which
provider happened to answer*. That is a bug you would never reproduce reliably.

### 8.3 Two prompts, not one with a switch

`buildShopkeeperPrompt()` (3,450 chars ≈ 863 tokens) and
`buildHouseholdPrompt()` (1,598 chars ≈ 400 tokens) are separate functions.

Why not one prompt with a section for each? **Because the system prompt is sent
with every single message.** It is a per-message cost, forever. A combined
prompt would make every shop message pay for household rules it can never use.

The household prompt is 54% smaller because a home has no khata — no udhaar, no
customers, and therefore none of the "is this money-in a repayment or not"
reasoning that costs most of the shopkeeper prompt's tokens.

There is a second benefit: the shopkeeper prompt was **not touched** when the
household feature was added. Text tuned over many test runs cannot regress if
nothing edits it.

### 8.4 The three layers that do not trust the AI

**The AI is instructed, never trusted.** The prompt *tells* the model which
types exist. That is a request. These three layers are enforcement:

```
   AI returns JSON
        │
        ▼
   ┌────────────────────────────────────────────┐
   │ LAYER 1  JSON.parse + Zod MessageSchema    │  is it the right SHAPE?
   └────────────────────────────────────────────┘
        │
        ▼
   ┌────────────────────────────────────────────┐
   │ LAYER 2  isTypeAllowedInWorkspace()        │  is it allowed HERE?
   └────────────────────────────────────────────┘
        │
        ▼
   ┌────────────────────────────────────────────┐
   │ LAYER 3  SQL constraints (CHECK, FK, NOT NULL) │  last line of defence
   └────────────────────────────────────────────┘
```

#### Layer 1 — Zod, and the discriminated union

```js
export const MessageSchema = z.discriminatedUnion("intent", [
  TransactionIntentSchema,
  QueryIntentSchema,
]);
```

A **discriminated union** means: the value can be one of several shapes, and one
field tells you which. Here that field is `intent`.

*You already know this pattern* — it is `switch (action.type)` in a Redux
reducer. `intent: "transaction"` requires amount, type, date, quantity.
`intent: "balance_query"` requires only a person.

Zod reads `intent` first, picks the matching schema, then validates only that
one. So a question is never forced to have an amount, and a transaction is never
allowed to be missing one:

```js
const QueryIntentSchema = z.object({
  intent: z.enum(["balance_query", "history_query"]),
  person: z.string().min(1),
});
```

`.min(1)` because `""` is a perfectly valid string in JavaScript. Without it,
an empty name would sail through and look up a customer called nothing.

#### Layer 2 — the workspace guard

```js
const TYPES_BY_WORKSPACE = {
  shopkeeper: ["sale","purchase","expense","payment_received",
               "payment_sent","credit_sale","repayment","other"],
  household:  ["expense", "income", "other"],
};

export function isTypeAllowedInWorkspace(workspaceType, transactionType) {
  return (TYPES_BY_WORKSPACE[workspaceType] ?? []).includes(transactionType);
}
```

`expense` and `other` are in both — an electricity bill is an expense whether
the meter is at the shop or at home. Everything else is exclusive.

`?? []` matters: an unknown workspace type returns an empty list, so **nothing**
is allowed. Failing closed is the correct default for a permission check.

### 8.5 Worked example: a hallucination, caught

The user is in **🏠 My Home** and types `"Bought groceries for ₹500"`.

Suppose the model glitches and returns:

```json
{
  "intent": "transaction",
  "transaction_type": "credit_sale",
  "description": "Groceries",
  "category": "groceries",
  "quantity": 1,
  "amount": 500,
  "person": "Raj",
  "transaction_date": "2026-08-16",
  "notes": null
}
```

**Layer 1 — Zod:** ✅ *passes.* `credit_sale` is in `TRANSACTION_TYPES` and the
shape is right. Zod validates structure, not business rules. This is the
important part to understand: **a schema check alone would let this through.**

**Layer 2 — the workspace guard** (`transaction.service.js:64`):

```js
if (!isTypeAllowedInWorkspace(workspaceType, validated.transaction_type)) {
  return {
    intent: "unsupported",
    reason: "TYPE_NOT_IN_WORKSPACE",
    transactionType: validated.transaction_type,
  };
}
```

`isTypeAllowedInWorkspace("household", "credit_sale")` → `["expense","income",
"other"].includes("credit_sale")` → **`false`**. ❌ **Rejected here.**

**What the user sees** (`bot.js:1232`):

```
I couldn't record that in 🏠 My Home. Try rephrasing, or switch workspace
with /workspace.
```

The message is marked `ANSWERED`. **No transaction row. No customer row. No
khata opened for "Raj" at home.**

Without layer 2, that hallucination would have created a customer and a credit
sale in a household ledger — where the concept does not exist — and the user
would find a debt for someone who never owed them anything.

**Layer 3 would also have stopped part of it:** `workspaces.type` has a CHECK
constraint, `transactions.workspace_id` is NOT NULL, and the FKs must resolve.
Belt, braces, and a third belt — because this is money.

### 8.6 Where the question is redirected, not forbidden

One more guard, at `transaction.service.js:44`:

```js
if (validated.intent !== "transaction") {
  if (workspaceType !== "shopkeeper") {
    return { intent: "unsupported", reason: "CUSTOMER_QUERY_OUTSIDE_SHOP" };
  }
  return { intent: validated.intent, person: validated.person };
}
```

Ask "How much does Raj owe me?" while in the household, and you get:

```
That's a customer question, and 🏠 My Home has no customers. Switch to your
shop with /workspace.
```

There is a lesson buried in the household prompt here (`groq.service.js:132`):

```
If the message ASKS what somebody owes, or asks to see somebody's entries,
return {"intent": "balance_query", "person": "Name"} and nothing else. The app
explains that this needs the shop — do not invent an intent of your own.
```

An earlier version said *"never return balance_query or history_query"* —
prohibiting without providing an alternative. The model, told not to use the
only fitting label, **invented a new intent**, and Zod threw a `ZodError`
*before* the friendly guard above could run. The user got a generic apology
instead of a useful explanation.

**Tell a model what to do instead, not only what not to do.** A prohibition with
no alternative is an invitation to improvise. Caught by `tests/ai.test.js`
failing 39/40.

---

## 9. The khata (udhaar / credit book)

**Udhaar** is credit. A regular customer takes goods and pays later. The
shopkeeper writes it in a *khata* — a per-customer running balance.

Two transaction types move it:

| Type | Meaning | Effect on what they owe |
|---|---|---|
| `credit_sale` | took goods without paying | **owes MORE** (+) |
| `repayment` | paid money back | **owes LESS** (−) |

### 9.1 The balance is never stored

There is no `customers.balance` column. It is computed on every read
(`postgres.js:342`):

```sql
SELECT COALESCE(SUM(
  CASE
    WHEN transaction_type = 'credit_sale' THEN amount
    WHEN transaction_type = 'repayment'   THEN -amount
    ELSE 0
  END
), 0) AS outstanding
FROM transactions
WHERE user_id = $1 AND customer_id = $2;
```

Reading the SQL:

- **`CASE WHEN … THEN … ELSE … END`** — SQL's ternary. Per row: a credit sale
  contributes `+amount`, a repayment contributes `−amount`, anything else
  contributes `0`.
- **`SUM(...)`** — adds those signed values across all the customer's rows.
- **`COALESCE(…, 0)`** — `SUM` over *zero rows* returns `NULL`, not `0`.
  `COALESCE` returns the first non-null argument, so a customer with no
  transactions gets `0` instead of `null`. Without it, `money(null)` would
  render `₹NaN` on a real screen.

#### Why derive it instead of storing it?

A stored `balance` column is faster to read and **wrong the first time anything
goes sideways**. To keep it correct, every single insert, update, delete,
rollback and clarification would have to remember to adjust it. Miss one path —
say the onboarding cleanup that deletes practice rows — and the balance is
permanently off with nothing to point at.

A sum recomputed from the rows **cannot lie**. The rows *are* the truth; the
balance is a view of them.

This is the same instinct as computing derived values in `render()` instead of
copying them into state and syncing by hand. Duplicated state is state that
will disagree with itself.

The cost is a `SUM` per read, which for a shopkeeper with a few hundred entries
is nothing — and the index `transactions_customer_idx (user_id, customer_id)`
is exactly the shape this query filters on. If it ever became slow, the fix is
a cached total that can be *rebuilt from the rows*, which is a different thing
from a stored balance that cannot.

Return type matters too (`postgres.js:359`):

```js
return Number(result.rows[0].outstanding);
```

**node-postgres returns `numeric` as a JavaScript string**, not a number — to
avoid float precision loss on money. Without `Number()`, `2000 + "1000"` gives
`"20001000"`. See section 14 for the test that deliberately reproduces this.

### 9.2 Raj's ledger, entry by entry

Starting from nothing:

| # | What the shopkeeper types | `transaction_type` | amount | Balance after |
|---|---|---|---|---|
| — | *(no entries yet)* | — | — | **₹0** |
| 1 | "Raj took goods for ₹2,000 on udhaar" | `credit_sale` | 2000 | **₹2,000** |
| 2 | "Raj took goods for ₹1,500 on udhaar" | `credit_sale` | 1500 | **₹3,500** |
| 3 | "Raj paid ₹1,000 towards his udhaar" | `repayment` | 1000 | **₹2,500** |
| 4 | "Raj paid back ₹3,000" | `repayment` | 3000 | **−₹500** |

The `SUM(CASE …)` after entry 4: `+2000 +1500 −1000 −3000 = −500`.

**Entry 4 overshot the debt.** Raj paid ₹3,000 against ₹2,500 owed. A negative
balance is not a bug — it means the shopkeeper is holding ₹500 of Raj's money.

But `"Raj owes you ₹-500"` reads as nonsense to a shopkeeper, so it is phrased
as what it actually is (`bot.js:996`):

```js
if (balance < 0) {
  await bot.sendMessage(
    chatId,
    `💰 ${customer.name} has paid ${money(Math.abs(balance))} in advance (no pending udhaar).`
  );
  return;
}
```

```
💰 Raj has paid ₹500 in advance (no pending udhaar).
```

And zero gets its own branch, because `₹0` alone is ambiguous — it could mean
"no khata" or "cleared":

```
✅ Raj has cleared all udhaar. Outstanding: ₹0
```

A customer who does not exist at all gets a *different* message again
(`bot.js:977`):

```
🔍 No customer named "Raj" in your khata yet.
```

Three different states — no khata, cleared, in advance — that a naive `₹0`
would have flattened into one confusing answer.

### 9.3 The double-count trap

Now the same four entries through `summarize()` (`summary.service.js:21`).

Here is the trap. Ask yourself: is a repayment revenue?

```js
if (transaction.transaction_type === "sale") {
  totalSales += amount;
}

// A credit sale IS revenue: the goods left the shop. It is counted in
// sales straight away, exactly like a cash sale.
if (transaction.transaction_type === "credit_sale") {
  totalSales += amount;
  creditSales += amount;
}

// A repayment is NOT revenue. The sale was already counted when the
// goods were given on udhaar. Counting it again would report the same
// sale twice. It is tracked separately as cash collected.
if (transaction.transaction_type === "repayment") {
  repaymentsReceived += amount;
}
```

**The reasoning:** revenue is recognised when the **goods leave the shop**, not
when the cash arrives. A `credit_sale` is a completed sale that happens to be
unpaid. The later `repayment` is not a *new* sale — it is the same sale finally
being paid for.

Count both and you report the same ₹2,000 twice. Applied to Raj's four entries:

| | Correct | If repayment were counted as revenue |
|---|---|---|
| Sales | ₹3,500 | ₹7,500 ❌ |
| of which credit | ₹3,500 | ₹3,500 |
| Repayments received | ₹4,000 | — |
| **Net Balance** | **₹3,500** | **₹7,500** ❌ |

The shop would appear to have sold **more than twice** what it sold. Books that
overstate revenue are worse than books that crash — nothing tells you they are
wrong.

So the summary reports two separate numbers (`summary.service.js:59`):

```js
return {
  totalSales,
  totalPurchases,
  totalExpenses,
  // How much of today's sales was on udhaar, i.e. billed but not yet paid.
  creditSales,
  // Cash collected today against older udhaar.
  repaymentsReceived,
  netBalance: totalSales - totalPurchases - totalExpenses,
  transactionCount: transactions.length,
};
```

`creditSales` answers "how much of what I sold have I not been paid for?"
`repaymentsReceived` answers "how much old debt came in today?" Different
questions, both real.

This has **its own dedicated test**, because it is the single easiest thing to
get wrong when adding a type:

```js
check("a repayment is NOT counted as revenue", () => { … });
```

### 9.4 `/udhaar` — who owes money

```sql
SELECT c.id, c.name,
  SUM(CASE
    WHEN t.transaction_type = 'credit_sale' THEN t.amount
    WHEN t.transaction_type = 'repayment'   THEN -t.amount
    ELSE 0
  END) AS outstanding
FROM customers c
JOIN transactions t
  ON t.customer_id = c.id
 AND t.user_id = c.user_id
WHERE c.user_id = $1
GROUP BY c.id, c.name
HAVING SUM(CASE … END) <> 0
ORDER BY outstanding DESC;
```

New SQL here:

- **`JOIN … ON`** — combine rows from two tables where the condition matches.
  The join condition checks **both** `customer_id` *and* `user_id`, for the
  same defence-in-depth reason as section 5.
- **`GROUP BY c.id, c.name`** — collapse all of one customer's transactions
  into a single output row, so `SUM` totals per customer instead of overall.
- **`HAVING`** — like `WHERE`, but it runs **after** grouping, so it can filter
  on the aggregate. `WHERE outstanding <> 0` would be an error: at `WHERE` time
  the sum does not exist yet. `HAVING` is where you filter on a `SUM`.
- **`<> 0`** — SQL's "not equal". Drops customers who have cleared their debt
  and customers sitting in advance, so `/udhaar` lists only people who
  currently owe.
- **`ORDER BY outstanding DESC`** — biggest debt first, which is the order a
  shopkeeper actually wants to read.

Output:

```
📒 Udhaar Book

1. Raj — ₹2,500
2. Amit — ₹800

Total pending: ₹3,300
```

---

## 10. The payment ambiguity problem

### 10.1 Two sentences, one difference, opposite meanings

| The message | What it means | `transaction_type` | Effect on Raj's khata |
|---|---|---|---|
| "Raj paid ₹1,000 **towards his udhaar**" | settling a debt | `repayment` | **owes ₹1,000 less** |
| "Raj paid ₹1,000" | …something | **unknowable** | **?** |

Same person. Same amount. The second sentence genuinely does not contain the
information needed to classify it. Raj might be settling old udhaar, or paying
cash for something he just bought.

**No model can resolve this, because the information is not in the sentence.**
A smarter model would just be more confident while still guessing.

And guessing wrong is expensive: mark a cash sale as a repayment and Raj's
recorded debt drops by ₹1,000 that he never paid off. The shopkeeper finds out
weeks later, if ever.

### 10.2 The prompt refuses to guess

The shopkeeper prompt is explicit (`groq.service.js:77`):

```
MONEY IN - repayment vs payment_received. NEVER GUESS: this changes what a
customer owes.
Use repayment ONLY if the message contains a debt word: udhaar, credit,
baaki, due, paid back, returned, cleared, settled, remaining, pending,
pacha aapya, "towards his/her".
  "Raj paid 1000 towards his udhaar", "Raj paid back 1000", "Raj paid
  remaining 1000", "Raj ne baaki 500 de diye" -> repayment, person Raj
No debt word means the message never said what the money was for. Use
payment_received and KEEP the name. A name alone is NOT a repayment.
  "Received 5000 from Raj", "Raj gave me 5000", "Raj paid 1000"
  -> payment_received, person Raj
```

Two things to notice:

1. **It is a keyword rule, not a judgement call.** "Does the sentence contain a
   debt word?" is answerable. "Did Raj mean to settle his debt?" is not.
2. **`KEEP the name`.** The model must not drop "Raj" just because it is not
   sure what the payment was for. The name is what makes the follow-up question
   answerable.

### 10.3 The app detects the ambiguous case and asks

```js
function needsPaymentClarification(transaction) {
  return (
    transaction.transaction_type === "payment_received" &&
    Boolean(transaction.person)
  );
}
```

`payment_received` **plus a named person** is exactly the "money came in from
someone, purpose unstated" case. `payment_received` with `person: null`
("Received ₹5,000 cash") is unambiguous — nobody's khata can be affected.

Instead of the normal Confirm/Cancel preview, the user gets a question
(`bot.js:1077`):

```
📝 Please confirm

Amount: ₹1,000
From: Raj
Description: Payment received
Date: 16 Aug 2026

Raj currently owes: ₹2,500

❓ Did Raj pay this toward their udhaar, or is this a normal payment?

[ 📒 Udhaar Repayment ]  [ 💰 Normal Payment ]
[            ❌ Cancel            ]
```

**`Raj currently owes: ₹2,500` is the important line.** It is not decoration —
it is the number the shopkeeper needs in order to answer. "Did he owe me
anything?" is the question they are about to ask themselves, answered before
they ask it.

A customer with no khata yet still gets the question, because the udhaar may
have been given verbally before it was ever recorded:

```
Raj has no udhaar recorded yet.
```

### 10.4 The answer travels as a type override

The buttons carry a different action word (`bot.js:1114`):

```js
{ text: "📒 Udhaar Repayment", callback_data: `repayment:${telegramMessageId}` },
{ text: "💰 Normal Payment",   callback_data: `income:${telegramMessageId}` },
```

which is translated through a whitelist (`bot.js:434`):

```js
// Maps a clarification button to the transaction type it means.
// Callback data arrives from the user's Telegram client, so this lookup is
// the whitelist: anything not listed here can never reach the database.
const CLARIFIED_TYPE = {
  repayment: "repayment",
  income: "payment_received",
};
```

```js
const typeOverride = CLARIFIED_TYPE[action] ?? null;
```

**Why a lookup object and not just using the string?** Because `callback_data`
comes from the **user's Telegram client**, which is software on someone else's
machine. A crafted request could send `callback_data: "DROP TABLE:4471"` or
`"credit_sale:4471"`.

An object lookup can only ever return one of two known values, or `undefined`.
Unknown key → `undefined` → `?? null` → no override → the AI's original type
stands. **Not a crash, not an error — just no effect.**

This is the same shape as the `WORKSPACE_KINDS` check (`bot.js:213`) and the
`ONBOARDING_STEPS` array (`bot.js:342`). Three places where user-supplied
strings arrive, three whitelists. *Never let external input choose a code path
by being that path's name.*

The override then travels into the atomic confirm (`postgres.js:490`):

```js
// The shopkeeper's clarification wins over what the AI stored. Resolved
// here, inside the transaction, so the type, the customer link and the
// row are all decided together or not at all.
const transactionType = typeOverride ?? message.transaction_data.transaction_type;
```

Passing the answer *into* the atomic operation — rather than updating
`transaction_data` first and confirming afterwards — keeps it one step. Two
steps would mean a double tap could land between them.

### 10.5 The plain Confirm button is refused for these

The Confirm button is never *shown* for an ambiguous payment. It is refused
anyway (`bot.js:1561`):

```js
// An ambiguous payment can only be saved through a clarification button.
// The plain Confirm button is never shown for one, but callback data
// comes from the user's client, so refuse it here rather than trust that.
if (action === "confirm" && needsPaymentClarification(transaction)) {
  await bot.answerCallbackQuery(query.id, {
    text: "Please choose what this payment was for.",
  });
  return;
}
```

**Never rely on the UI not offering something as your security model.** The UI
runs on the client. The check runs on the server.

---

## 11. Onboarding

A new user types `"hii"`. They have no ledger, no idea what the bot does, and
one chance to not close the app.

### 11.1 The complete flow

```
You    hii

Bot    👋 Hi Varun! I'm your bookkeeping assistant.

       Just type what happened — like "Bought 10 kg rice for ₹600" — and I'll
       write it in your books. No forms, no Excel.

       First, what should I keep books for?

       You can add the other one later, so this is not final.

       [ 🏪 My Shop — sales, purchases, udhaar ]
       [ 🏠 My Home — household spending       ]

You    (taps 🏪 My Shop)

Bot    ✅ Now using 🏪 My Shop
Bot    🏪 My Shop is ready.
Bot    Let's try it once — takes 30 seconds.

       Type this, or your own version:

       Bought 10 kg rice for ₹600

       [ ⏭ Skip setup ]

You    Bought 10 kg rice for ₹600

Bot    📝 Please confirm
       Type: purchase … Amount: ₹600
       [ ✅ Confirm ]  [ ❌ Cancel ]

You    (taps ✅ Confirm)

Bot    ✅ Transaction saved
Bot    🎉 That's the whole app — type it, tap Confirm.

       Want to see what else I can do?

       [ 📊 Today's summary  ]
       [ 📅 This month       ]
       [ 📋 Today's entries  ]
       [ 📒 Who owes me      ]
       [ ✅ Finish setup     ]

You    (taps 📒 Who owes me)

Bot    📒 No pending udhaar. Everyone has cleared their balance.
Bot    What else?

       [ 📊 Today's summary ] … [ ✅ Finish setup ]

You    (taps ✅ Finish setup)

Bot    Almost done.

       You have 1 practice entry in your books from setup. Clear them so your
       real accounts start from zero?

       [ 🧹 Clear practice data ]
       [ 📌 Keep it             ]

You    (taps 🧹 Clear practice data)

Bot    ✅ All set. Cleared 1 practice entry.
Bot    👋 You're in 🏪 My Shop.
       [full command list]
```

### 11.2 Two columns hold the whole thing

```sql
ALTER TABLE users ADD COLUMN onboarding_done_at timestamptz;

ALTER TABLE messages
  ADD COLUMN is_onboarding boolean NOT NULL DEFAULT false;
```

**`users.onboarding_done_at`** — NULL means still onboarding:

```js
function isOnboarding(user) {
  return !user.onboarding_done_at;
}
```

Read straight off the `users` row `resolveShopkeeper` already fetched, so
checking costs **no extra query**.

**Why a timestamp and not a boolean?** It costs the same to store and answers
questions a boolean cannot: when did they finish, how long did setup take, where
do people drop off. A boolean throws that away for nothing.

**There is no step counter.** Which step the user is on is carried by the
*button they are about to tap* — `onb:summary`, `onb:finish`, `onb:clear`,
`onb:keep` — exactly like the existing `confirm:` / `cancel:` / `addws:`
buttons. The position in the flow lives in the callback data, not in a column
that could get out of sync with what is on screen.

### 11.3 Why the flag is on `messages`, not `transactions`

`is_onboarding` marks a **message** as practice data, stamped at arrival
(`bot.js:1189`):

```js
savedMessage = await createMessage({
  user_id: user.id,
  workspace_id: workspace.id,
  telegram_message_id: message.message_id,
  message_text: message.text,
  status: "RECEIVED",
  // Stamped at arrival, not read back later: this is what marks the row
  // as practice data, and it is the key the cleanup deletes by.
  is_onboarding: isOnboarding(user),
});
```

**Why not flag the transaction instead?** Because the message is where the
decision is knowable. At arrival we know whether the sender is mid-tutorial. The
transaction is created *later*, at confirm time, by a function that would then
need to be told — one more parameter threaded through the atomic confirm for no
gain.

Transactions are reached **through** their message:

```sql
t.user_id = $1
AND m.user_id = $1
AND m.is_onboarding
AND t.telegram_message_id = m.telegram_message_id::text
```

This is the join from section 4.4, and it works because `(user_id,
telegram_message_id)` is UNIQUE on both tables — so it matches at most one
transaction per message.

Note this WHERE clause is defined **once** as a constant
(`postgres.js:629`) and used by both the counter and the deleter:

```js
const ONBOARDING_TRANSACTIONS_WHERE = ` … `;
```

That is deliberate: **the number the user is told is produced by the exact same
condition as the rows that disappear.** If the count and the delete could drift
apart, the confirmation dialog would be lying.

### 11.4 The only DELETE in `src/`, and its four guard rails

`finishOnboarding()` (`postgres.js:672`) is the **only function in the entire
`src/` directory that deletes anything**. Everything else only inserts and
updates. That is worth knowing: if data disappears, there is exactly one place
to look.

```js
export async function finishOnboarding(userId, { clear }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
```

**Guard rail 1 — every statement is scoped `WHERE user_id = $1`.** One user's
cleanup can never reach another's rows.

**Guard rail 2 — only rows reached through `messages.is_onboarding`.** Real
transactions are excluded by construction, not by remembering to filter them.

**Guard rail 3 — `users` and `workspaces` are never touched.** The workspace
the user just created is the entire point of onboarding; deleting it would
strand them back at the gate.

**Guard rail 4 — one transaction.** A failure halfway leaves the practice data
**intact** rather than half-deleted.

```js
if (clear) {
  // Leaves first. transactions reference customers AND workspaces with
  // NO ACTION (not CASCADE), so deleting in any other order fails on a
  // foreign key violation.
  const transactions = await client.query(
    `DELETE FROM transactions t USING messages m WHERE ${ONBOARDING_TRANSACTIONS_WHERE};`,
    [userId]
  );
```

**The order is forced by the schema, not chosen for style.** From section 4.2:
`transactions.customer_id` is `NO ACTION`. Try to delete the customer while a
transaction still points at it and Postgres refuses the whole statement.

`DELETE … USING` is how you delete from one table using a condition that
references another — the delete equivalent of a join.

Then messages, then customers:

```js
  const customers = await client.query(
    `
    DELETE FROM customers c
    WHERE c.user_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM transactions t WHERE t.customer_id = c.id
      );
    `,
    [userId]
  );
```

**`NOT EXISTS (SELECT 1 …)`** — "delete this customer only if no transaction
anywhere points at them." After the delete above, that is *exactly* the practice
customers. A real customer always has at least the entry that created them.

Why bother? A practice `"Raj took goods on udhaar"` opens a khata for Raj. Clear
the transactions and Raj is left with an empty ledger — a name the shopkeeper
only ever typed as an example, sitting in their customer list forever.

**The `keep` path is not a no-op:**

```js
} else {
  // Keeping the data. The flags are cleared so these rows are no longer
  // reachable by the delete above under any future call.
  await client.query(
    `UPDATE messages SET is_onboarding = false WHERE user_id = $1 AND is_onboarding;`,
    [userId]
  );
}
```

A user who chose "Keep it" can never have those entries deleted by any later
run — the flag that made them deletable is gone. **Making an unwanted outcome
unreachable beats remembering not to trigger it.**

Finally, on both paths:

```js
await client.query(
  `UPDATE users SET onboarding_done_at = NOW(), updated_at = NOW() WHERE id = $1;`,
  [userId]
);

await client.query("COMMIT");
```

### 11.5 The feature tour, and where its buttons come from

After the practice entry saves, the user is offered a tour — each button runs a
**real command against their own data**, not a mock-up.

Which buttons appear is not hardcoded in the bot. It comes from a third list in
`transaction.schema.js:52`:

```js
// What each ledger can DO, as opposed to TYPES_BY_WORKSPACE above, which is
// what it can RECORD.
const FEATURES_BY_WORKSPACE = {
  shopkeeper: ["summary", "monthly", "transactions", "udhaar"],
  household:  ["summary", "monthly", "transactions"],
};

export function featuresForWorkspace(workspaceType) {
  return FEATURES_BY_WORKSPACE[workspaceType] ?? [];
}
```

Note the `?? []` — the **same fail-closed default** as
`isTypeAllowedInWorkspace()` (section 8.4). An unknown workspace type offers
*nothing* rather than everything. When in doubt, a permission-shaped function
should deny.

`udhaar` is shopkeeper-only, so a household user is never offered a khata
button. The rule lives in the schema next to the other workspace rules, not in
the UI.

Then in `bot.js:282`, one table pairs each feature's label with the function
that runs it:

```js
const TOUR = {
  summary:      { label: "📊 Today's summary", run: sendDailySummary },
  monthly:      { label: "📅 This month",      run: sendMonthlySummary },
  transactions: { label: "📋 Today's entries", run: sendTransactionsList },
  udhaar:       { label: "📒 Who owes me",     run: sendUdhaarList },
};
```

**One table, not two maps.** A label map beside a separate action map would let
a feature have a button with no handler — which sends Telegram a button
captioned `undefined` — or a handler no button reaches. Pairing them in one
entry makes both halves impossible to forget.

The buttons are then built by intersecting the two (`bot.js:295`):

```js
const featureRows = featuresForWorkspace(workspace.type).map((feature) => [
  { text: TOUR[feature].label, callback_data: `onb:${feature}` },
]);
```

And the whitelist from section 10.4 is **derived** rather than retyped
(`bot.js:342`):

```js
const ONBOARDING_STEPS = [...Object.keys(TOUR), "finish", "clear", "keep"];
```

Its comment names the exact failure this prevents:

```
// Every tour feature must appear here or its button silently does nothing
// useful — an unlisted step does not reach "Unknown action", it falls through
// to the transaction path and reports "Transaction not found."
```

That is a subtle one. An unlisted `onb:` step does not hit a friendly "unknown
action" branch — it falls past the `onb` check into the transaction path, where
`Number("summary")` is `NaN` and the user gets a baffling "Transaction not
found." Deriving the whitelist from `TOUR` makes the mismatch unrepresentable.

**Why the tour comes after the first save, not before.** From `bot.js:265`:

```
// This is the moment the user has seen the whole loop work, so the tour is
// offered here and nowhere earlier: every command below now has at least one
// real row to show. /summary and /monthly have no empty state, so offering
// them before anything is recorded would introduce the user to their own
// books as a wall of ₹0.
```

And every tour button re-offers the card afterwards (`"What else?"`), so trying
a second feature is one tap rather than a hunt.

#### The skip button

The practice prompt carries `⏭ Skip setup`, pointing at `onb:finish`
(`bot.js:153`) — **the same step the Finish button uses.**

Skipping is therefore not a separate path with its own rules. It ends
onboarding through the identical code, and still offers to clear anything
already recorded. A second path would be a second place for the cleanup logic
to drift.

### 11.6 The count is the safety rail

```js
async function askToClearPracticeData(chatId, count) {
  const entries = count === 1 ? "1 practice entry" : `${count} practice entries`;
  …
}
```

**Everything typed while onboarding is open counts as practice.** A user who
ignores the Finish button for a week would be clearing a week of real work.

Showing the count is what makes that visible *before* the tap:

```
You have 47 practice entries in your books from setup. Clear them so your
real accounts start from zero?
```

At 1, that reads as housekeeping. At 47, it stops you. And "📌 Keep it" is
offered with equal visual weight — not a small grey link next to a big red
button.

Two more details:

- **Zero entries skips the question entirely** (`bot.js:391`). Asking "shall I
  delete 0 rows?" is noise.
- **`finish` and `clear` are separate taps.** Deleting data always takes a
  deliberate second confirmation.

### 11.7 The gate is unskippable because it is everywhere

`askToChooseWorkspace()` is called from **ten** places — every command handler
and the free-text handler. Not just `/start`.

The reason is in the comment (`bot.js:92`):

```
// No workspace means no ledger, so nothing else in the bot can run: every
// command and every message routes here until a choice is made. That is what
// makes onboarding unskippable, and it is why this is sent from ten different
// places rather than only from /start — most people never type /start, they
// just say "hii".
```

**Most people never type `/start`.** They say "hii". Designing onboarding to
begin at `/start` means designing it for users who do not exist.

And a beginner who types "hii" mid-tutorial does not get an apology about a
transaction they never tried to record (`bot.js:1373`):

```js
if (onboardingWorkspace) {
  await sendPracticePrompt(message.chat.id, onboardingWorkspace);
  return;
}
```

They get the practice prompt again — which carries its own "⏭ Skip setup"
escape hatch, so somebody who never types anything is not trapped.

---

## 12. Every command, and what it touches

| Command | Handler | Does the work | Tables read |
|---|---|---|---|
| `/start` | `bot.js:607` | `sendWelcomeHelp` (`bot.js:582`) | `users`, `workspaces` |
| `/help` | `bot.js:692` | inline | `users`, `workspaces` |
| `/workspace` | `bot.js:633` | `getWorkspaces`, `setActiveWorkspace` | `workspaces`, `users` |
| `/summary` | `bot.js:850` | `sendDailySummary` (`bot.js:859`) | `transactions` |
| `/transactions` | `bot.js:785` | `sendTransactionsList` (`bot.js:789`) | `transactions` |
| `/monthly` | `bot.js:510` | `sendMonthlySummary` (`bot.js:447`) | `transactions` |
| `/udhaar` | `bot.js:936` | `sendUdhaarList` (`bot.js:885`) | `customers` ⋈ `transactions` |
| *free text* | `bot.js:1138` | `processMessage` → `askAI` → Zod | writes `messages` |
| *button tap* | `bot.js:1392` | `confirmMessageTransaction` | `messages`, `transactions`, `customers` |

Every one of them starts with `resolveShopkeeper()` and every one checks
`if (!workspace)` before touching data.

**Why four `send*` helpers separate from their handlers.** Each command's body
was split out so the onboarding feature tour (section 11.5) can run **the real
command** against the user's own data rather than a mock-up of it. The `/summary`
handler is now just error handling around `sendDailySummary(chatId, user,
workspace)`; the tour calls the same function.

The alternative — the tour printing its own approximation of each report —
would mean two renderings of every command that must be kept in step forever.
Here, improving `/summary` improves the tour automatically, and the tour can
never show a user something their real command does not do.

### 12.1 The same command, two ledgers

This is where the workspace design becomes visible. `/summary` is not one layout
with rows blanked out — it is two different reports.

**In 🏪 My Shop:**

```
📊 🏪 My Shop — Daily Summary

Date: 2026-08-16

Sales: ₹2,500
Purchases: ₹600
Expenses: ₹1,800
Net Balance: ₹100

Transactions: 3
```

**In 🏠 My Home:**

```
📊 🏠 My Home — Daily Summary

Date: 2026-08-16

Income: ₹65,000
Expenses: ₹3,400
Balance: ₹61,600

Transactions: 4
```

The branch (`bot.js:827`):

```js
const body =
  workspace.type === "household"
    ? `Income: ${money(summary.totalIncome)}
Expenses: ${money(summary.totalExpenses)}
Balance: ${money(summary.balance)}`
    : `Sales: ${money(summary.totalSales)}
Purchases: ${money(summary.totalPurchases)}
Expenses: ${money(summary.totalExpenses)}
Net Balance: ${money(summary.netBalance)}`;
```

They share nothing but the word "expense". A shop asks *"did I make money
today?"* — sales against costs. A home asks *"what is left?"* — income against
spending. Forcing one layout on both would mean a shop with a permanently empty
"Income" row and a home with a permanently empty "Sales" row.

### 12.2 `/monthly` in the household adds a breakdown

```
📊 🏠 My Home — Monthly Summary

August 2026

Income: ₹65,000
Expenses: ₹23,400
Balance: ₹41,600

Where it went:
rent — ₹12,000
groceries — ₹6,200
electricity — ₹2,400
transport — ₹1,900
medical — ₹900

Transactions: 31
```

Built in `summarizeHousehold` (`summary.service.js:78`):

```js
if (transaction.transaction_type === "expense") {
  totalExpenses += amount;

  // Only expenses are broken down. A category breakdown that mixed
  // salary in with groceries would not answer "where did it go?".
  const category = transaction.category || "other";

  categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + amount);
}
```

Three decisions in eight lines:

- **Income is excluded from the breakdown.** "Where did it go?" is a question
  about spending. A ₹65,000 salary row at the top of a spending breakdown would
  dwarf everything and answer nothing.
- **`|| "other"`** not `?? "other"` — catches `null` *and* `""`. An empty-string
  category from a model glitch should land in "other", not create a nameless
  bucket. This is the rare case where `||`'s looseness is the right tool.
- **Built from the rows, not from `HOUSEHOLD_CATEGORIES`.** A category added to
  the schema later appears here with **no change to this file**.

Then sorted (`summary.service.js:109`):

```js
byCategory: [...categoryTotals]
  .map(([category, total]) => ({ category, total }))
  .sort((a, b) => b.total - a.total),
```

Biggest first — the order the dashboard prints, so it is part of the contract
and has its own test.

### 12.3 `/summary` and `/monthly` share their accumulator

`getMonthlySummary` used to be a **byte-identical copy** of the daily
accumulator. Two copies of the same loop means every new transaction type has to
be remembered twice — and eventually will not be.

Now (`monthly-summary.service.js:10`):

```js
export async function getMonthlySummary(userId, workspaceId, year, month, workspaceType) {
  const transactions = await getTransactionsByMonth(userId, workspaceId, year, month);

  return { year, month, ...summarize(transactions, workspaceType) };
}
```

The only real difference between daily and monthly was **which rows get
fetched**. So that is the only thing that differs now. `summarize()` lives in
`summary.service.js` and both import it.

The month range query is worth a look (`postgres.js:166`):

```sql
AND transaction_date >= make_date($3, $4, 1)
AND transaction_date <  make_date($3, $4, 1) + INTERVAL '1 month'
```

`>=` start and `<` next month — a **half-open range**. Never
`BETWEEN … AND last_day`, which forces you to work out whether the month has
28, 29, 30 or 31 days. `+ INTERVAL '1 month'` lets Postgres handle leap years
and month lengths. Half-open ranges are almost always the right shape for dates.

### 12.4 Dates and money

Everything uses **`Asia/Kolkata`** and **₹ (INR)**.

```js
function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
```

**`"en-CA"` is a trick.** Canadian English formats dates as `YYYY-MM-DD` —
exactly what PostgreSQL wants for a `::date` cast. `"en-IN"` would give
`16/8/2026`, which Postgres would reject or, worse, misread.

The server might run in UTC. At 2am IST it is still *yesterday* in UTC, so
without the explicit timezone a shopkeeper's late-night sale would land on the
wrong day and `/summary` would not show it.

```js
function money(value) {
  return `₹${Number(value).toLocaleString("en-IN")}`;
}
```

`"en-IN"` here gives **Indian digit grouping** — `₹1,50,000` (lakhs), not
`₹150,000`. A shopkeeper reads the first instantly and has to stop and count the
second.

`Number(value)` again because `amount` arrives from `pg` as a string.

---

## 13. Migrations

### 13.1 What a migration is and why they are files

Your database has a shape: tables, columns, constraints. A **migration** is a
recorded, reviewable change to that shape.

Three rules here, all deliberate:

**Numbered.** `001_`, `002_`, `003_`. Order matters — `002` adds
`workspace_id`, `003` assumes it exists.

**Never run automatically.** Every file says so in its header:

```sql
-- DO NOT RUN AUTOMATICALLY. Review, then apply manually.
```

There is no migration runner in this project. You read the SQL, you run the
pre-flight checks, you apply it by hand. Slower, and correct: an auto-runner on
deploy means a bad migration ships at 6pm on a Friday with nobody watching.

**Wrapped in one transaction, with a rollback at the bottom.**

```sql
BEGIN;
  -- everything
COMMIT;
```

Same all-or-nothing as section 6, applied to schema changes. If statement 7 of 9
fails, statements 1–6 are undone. You never end up with a half-migrated
database, which is the single worst state to debug.

### 13.2 The three migrations

| File | Added | Why |
|---|---|---|
| `001_shopkeeper_udhaar.sql` | `customers` table, `transactions.customer_id`, the per-user unique fix, the `ANSWERED` status | udhaar / khata |
| `002_workspaces.sql` | `workspaces` table, `users.active_workspace_id`, `workspace_id` on two tables, backfill, orphan adoption, NOT NULL | shop + home |
| `003_onboarding.sql` | `users.onboarding_done_at`, `messages.is_onboarding`, backfill | the tutorial |

### 13.3 `002` — pre-flight checks

Before `BEGIN`, the file tells you what to verify by hand:

```sql
-- Must return 0, or the messages backfill below leaves rows behind and the
-- SET NOT NULL at the end will abort the whole migration:
--
--   SELECT count(*) FROM messages WHERE user_id IS NULL;

-- Must return 1. Step 5 adopts ownerless rows into "the" shop, which only
-- has one possible meaning while there is exactly one user:
--
--   SELECT count(*) FROM users;
```

Pre-flight checks state the **assumptions the migration is making**. They turn
"this worked on my machine" into "here is what has to be true for this to be
correct anywhere."

### 13.4 `002` step 5 — the orphan adoption

This is the most interesting part of any migration here.

The database contained **14 transactions with `user_id IS NULL`** — rows created
before transactions had a `user_id` at all (commit `ebcb1a0`). They were
invisible to every query in the app, since all of them filter on `user_id`. Real
transactions, orphaned by a schema change.

The backfill in step 4 joins on `user_id`, so it could not reach them. And step
6 was about to run:

```sql
ALTER TABLE transactions ALTER COLUMN workspace_id SET NOT NULL;
```

which would **abort the entire migration** while those 14 rows had a NULL
workspace.

Three options: leave `workspace_id` nullable (and give up the guarantee from
section 4.5), delete the rows (they are real data), or adopt them.

```sql
UPDATE transactions t
  SET user_id = w.user_id,
      workspace_id = w.id
  FROM workspaces w
  WHERE w.type = 'shopkeeper'
    AND t.user_id IS NULL
    AND (SELECT count(*) FROM users) = 1;
```

**`AND (SELECT count(*) FROM users) = 1` is the guard, and it is the whole
point.** With exactly one user, "the shop" has one possible meaning and the
adoption is unambiguous. With two users there is **no correct owner** — and
this statement updates **zero rows** rather than guessing.

Run this migration on a database with five users and step 5 quietly does
nothing, step 6 fails on the NULLs, and the whole thing rolls back. That is the
**correct** outcome: it refuses to guess who owns financial records.

The file is honest that this is not cleanly reversible:

```sql
-- Note: this does NOT un-adopt the orphan transactions from step 5. Their
-- user_id stays set, so they remain visible. To restore them to ownerless:
--   UPDATE transactions SET user_id = NULL WHERE id IN (...);
-- with the ids recorded before the migration ran — which is why step 5 is
-- the one part of this file that is not cleanly reversible.
```

**Writing down what your rollback cannot undo is part of writing the rollback.**

### 13.5 `003` — the one line that mattered

```sql
UPDATE users SET onboarding_done_at = now() WHERE onboarding_done_at IS NULL;
```

Its own comment calls it **"THE IMPORTANT LINE IN THIS FILE."**

Adding a nullable column gives every existing row `NULL`. And the bot reads
`NULL` as *"this user is still onboarding"*:

```js
function isOnboarding(user) {
  return !user.onboarding_done_at;
}
```

Without that backfill, on the next deploy **every existing user** would:

1. be shown the tutorial again, as if they were new;
2. have every message they sent stamped `is_onboarding: true`;
3. be offered "🧹 Clear practice data" — which would delete **their real books**.

A one-line omission, and a data-loss bug reaches production.

**The lesson generalises:** when you add a column, ask what its default means to
code that reads it. `NULL` is not neutral. It means something, and here it meant
"new user".

`003` also has post-checks, which are the pre-flight idea pointed the other way:

```sql
-- Must return 0 — no existing user left in the onboarding state:
--   SELECT count(*) FROM users WHERE onboarding_done_at IS NULL;
-- Must return 0 — no existing message marked as practice data:
--   SELECT count(*) FROM messages WHERE is_onboarding;
```

### 13.6 What "backward compatible" meant in practice

Every migration here follows the same rules:

- **Nothing is dropped or renamed.** New columns only.
- **New columns are nullable or have a default**, so existing rows stay valid.
- **Existing data is backfilled** before any constraint is tightened.
- **`NOT NULL` comes last**, after the backfill — and if it fails, everything
  rolls back.

That is why applying `002` changed nothing the existing user could see. They
were already inside "My Shop", with every transaction still visible. The
architecture underneath had changed completely.

---

## 14. The test layer

No test framework. No Jest, no Mocha. Each suite is a plain Node script with a
hand-rolled `check()` and `node:assert/strict`.

That is a deliberate choice at this size: a framework is another dependency,
another config file, and another thing to learn, for a project whose tests run
in under a second.

### 14.1 The suites

| Suite | Checks | Needs | Cost |
|---|---|---|---|
| `tests/schema.test.js` | 34 | nothing | free, instant |
| `tests/summary.test.js` | 19 | nothing | free, instant |
| `tests/ratelimit.test.js` | 7 | nothing | free, instant |
| `tests/udhaar.integration.js` | 35 | `DATABASE_URL` | free, ~2s |
| `tests/workspace.integration.js` | 51 | `DATABASE_URL` | free, ~3s |
| `tests/onboarding.integration.js` | 29 | `DATABASE_URL` | free, ~3s |
| `tests/ai.test.js` | 40 cases | API key | **costs real API calls** |

```bash
npm test          # schema + summary + ratelimit — free, instant
npm run test:db   # udhaar integration
npm run test:ws   # workspace integration
npm run test:onb  # onboarding + practice-data cleanup
npm run test:all  # all four of the above
npm run test:ai   # live AI classification — costs money
```

`test:ai` is deliberately **outside** `test:all` because it spends real API
budget against the daily limit from section 8.2. Everything else is free, so
`test:all` can be run without thinking about it.

### 14.2 The integration tests never touch real data

Both DB suites create **throwaway users** with fake Telegram ids and delete
everything they created in a `finally` block. Existing data is never touched.
`finally` means cleanup runs even when an assertion fails halfway through — a
failing test must not leave debris that breaks the next run.

### 14.3 One check from each suite

**`schema.test.js` — the shape of AI output:**

```js
check("credit sale keeps the customer name", () => { … });
```

Plus a block of **invariants** that do not test behaviour at all — they test
that the lists in `transaction.schema.js` still agree with each other:

- every type in `TRANSACTION_TYPES` belongs to at least one workspace;
- no workspace allows a type that is not in `TRANSACTION_TYPES`;
- every `CUSTOMER_TRANSACTION_TYPES` entry is shopkeeper-only;
- every workspace accepts at least one type;
- `HOUSEHOLD_CATEGORIES` is non-empty, unique and lowercase.

The first is the most valuable line in the file. Add a type to the Zod enum and
forget `TYPES_BY_WORKSPACE`, and you create a type the AI may emit, Zod accepts,
and **no workspace can record** — a message that fails with a generic apology
and no clue why. This check turns that into a red test in milliseconds.

**`summary.test.js` — the double-count guard:**

```js
check("a repayment is NOT counted as revenue", () => { … });
```

**`udhaar.integration.js` — real balances against a real database:**

```js
check("Raj owes 2000", await getCustomerBalance(userA.id, rajA.id), 2000);
check("Raj owes 1000 after paying 1000", await getCustomerBalance(userA.id, rajA.id), 1000);
```

**`workspace.integration.js` — isolation:**

```js
check("shop workspace created", shop.type, "shopkeeper");
check("user has exactly 2 workspaces", (await getWorkspaces(user.id)).length, 2);
```

**`onboarding.integration.js` — cleanup with two users at once:**

```js
check("user A has not finished onboarding", await onboardingDoneAt(userA.id), null);
check("A has 2 onboarding messages", await messageCount(userA.id, true), 2);
```

Two users on purpose: the real risk in a DELETE is that it reaches further than
intended. The test asserts B's rows survive A's cleanup.

### 14.4 The string-vs-number trap, reproduced on purpose

The row factory in `summary.test.js` **stringifies the amount**:

```js
amount: String(amount)
```

That looks wrong. It is the most important line in the file.

**node-postgres returns `numeric` columns as JavaScript strings**, to avoid
float precision loss on money. So in production, `summarize()` receives:

```js
{ transaction_type: "sale", amount: "2500.00" }
```

not `amount: 2500`. And in JavaScript:

```js
0 + "2500.00" + "600.00"   // "02500.00600.00"   ← concatenation
```

Testing with real numbers would pass every time while production silently
concatenated strings into nonsense. So the test reproduces the production type:

```js
check("postgres numeric strings are added, not concatenated", () => { … });
```

and `summarize()` coerces explicitly:

```js
const amount = Number(transaction.amount);
```

**Test with the types your database actually returns, not the types you wish it
returned.**

### 14.5 `ai.test.js` has a free pre-flight

Before spending a single API call, it walks all 40 cases and asserts each one's
expected `type` is legal in that case's workspace, via `isTypeAllowedInWorkspace`.

A case expecting `income` under `shopkeeper` is a broken **test**, not a broken
model. Without the pre-flight it would burn an API call to discover that, then
report a confusing classification failure. The pre-flight fails in milliseconds
and costs nothing.

### 14.6 A safety net you have not seen catch anything is not known to work

All of this was validated by **deliberately breaking the code** and confirming
the right tests went red:

| Sabotage | Expected failure | Result |
|---|---|---|
| Add `"refund"` to `TRANSACTION_TYPES`, nothing else | invariant check | ✅ red |
| Delete the `repayment` branch from `summarizeShop` | double-count check | ✅ red |
| `getTransactionsByMonth` filters `user_id` instead of `workspace_id` | isolation checks | ✅ 4 red |

Each was reverted afterwards. Writing a test is half the job; **watching it fail
for the right reason** is the other half.

---

## 15. What is deliberately NOT built

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
existed first (section 4.4).

**What hits it first:** any feature needing to walk from a transaction back to
its message cheaply. Also the `text`/`bigint` mismatch below.

### `transactions.telegram_message_id` is `text`, `messages` is `bigint`

Every join between them needs `::text` (`postgres.js:633`).

**What hits it first:** a second join site. One cast is a quirk; three is a bug
waiting to happen. The fix is its own migration, flagged in
`003_onboarding.sql:31`.

### Most `transactions` columns are nullable

`amount` and `transaction_type` can be NULL at the database level. Zod is the
only thing stopping it, and Zod only guards the path that exists today
(section 3.5).

**What hits it first:** any import script, admin tool, or backfill that writes
to `transactions` without going through `processMessage`.

### `src/server.js` and the `fastify` dependency are dead code

This ceiling **resolved itself**, and the leftovers are worth knowing about.

`src/server.js` was a Fastify health endpoint on port 3000 that knew nothing
about Telegram, while the bot ran as a separate process. Deploying meant two
entry points, and the prediction here was that webhooks would force them to
meet.

That is what happened — but the bot grew **its own** webhook server instead
(`bot.js:54`), so `npm start` now runs the bot and nothing imports `server.js`
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

Raw SQL through `pg`, all of it in `postgres.js`. That is why this document can
show you the actual queries; an ORM would hide them behind method chains.

**What hits it first:** honestly, not much at this size. Every query being
visible is a feature.

### No migration runner

Migrations are applied by hand (section 13.1).

**What hits it first:** more than one environment, or more than one person
deploying. Then "which migrations has staging had?" becomes a real question with
no recorded answer.

### `bot.js` has no direct tests

**Mostly resolved — worth reading as a worked example of removing a ceiling.**

The blocker used to be that `new TelegramBot(token, { polling: true })` ran at
**import time**, so importing the module opened a live Telegram connection and
no test could touch it.

The fix was two options on the constructor (`bot.js:70`):

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

**What is still untested:** the ~1,700 lines of handlers. They need a fake `bot`
object to drive, which is a bigger job. What is covered now is the logic that
guards money — and `overRateLimit` is squarely that:

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

**What hits the remaining gap first:** handler branching growing past simple
`if (!workspace)` checks. Every phase in `FUTURE_FEATURES.md` adds handlers.

Everything it *calls* is tested underneath it. What is untested is the glue:
message formatting, button wiring, handler branching.

**What hits it first:** handler logic growing past simple branching. The cheapest
first move is to relocate the two real domain rules that currently live there —
`needsPaymentClarification()` and `CLARIFIED_TYPE` — into
`transaction.schema.js`, next to `isCustomerTransaction()` where the other
domain rules already are, and test them for free.

### Not built at all, on purpose

Investments, stocks, mutual funds, loans, insurance, tax planning, budgeting,
financial advice, bank integrations, UPI, OCR/receipt scanning, multi-user
permissions, an AI financial advisor, advanced analytics.

Not because they are bad ideas. Because a bookkeeping tool that records
transactions correctly is worth more than one that does nine things
approximately.

---

## 16. How to add a new transaction type

The real test of whether this document taught you anything. Say a shop wants
`refund` — money given back to a customer.

Here is every layer, in order.

### Step 1 — the schema

`src/schemas/transaction.schema.js`. **Two lists, and both must be updated:**

```js
export const TRANSACTION_TYPES = [
  "sale", "purchase", "expense", "payment_received",
  "payment_sent", "credit_sale", "repayment", "income",
  "refund",          // ← add here (Zod will now accept it)
  "other",
];

const TYPES_BY_WORKSPACE = {
  shopkeeper: [
    "sale", "purchase", "expense", "payment_received",
    "payment_sent", "credit_sale", "repayment",
    "refund",        // ← AND here (a workspace must allow it)
    "other",
  ],
  household: ["expense", "income", "other"],
};
```

**Forget the second and the invariant test goes red immediately:**

```
✗ every transaction type belongs to at least one workspace
```

That is section 14.3's most valuable check earning its keep. Without it you
would ship a type the AI can emit, Zod accepts, and no workspace can record.

Is a refund a customer transaction? Only if it should move a khata balance.
Probably not — a refund is usually cash back on a cash sale. So
`CUSTOMER_TRANSACTION_TYPES` stays as it is. If you *did* add it, remember the
invariant "every customer type is shopkeeper-only" will hold you to it.

### Step 2 — the prompt

`src/ai/groq.service.js`, in `buildShopkeeperPrompt()`. Two edits — the type
list in the JSON template, and the TYPES section:

```
"transaction_type": "sale|purchase|expense|payment_received|payment_sent|credit_sale|repayment|refund|other",
```

```
refund            money given BACK to a customer for returned goods
```

**Keep it to one line.** The prompt ships with every message (section 8.3), so
every word is a per-message cost forever. Add an example only if the one-line
rule keeps getting it wrong:

```
  "Refunded ₹500 to Raj for the returned shirt" -> refund, person Raj
```

**Do not touch `buildHouseholdPrompt()`** — a household has no refunds, and its
prompt should not pay for rules it cannot use.

### Step 3 — the summary

`src/services/summary.service.js`, in `summarizeShop()`. **This is the step
that gets forgotten**, and it fails silently: the row saves fine and simply
never appears in any total.

Think about the accounting first. A refund is negative revenue — the sale is
being undone:

```js
if (transaction.transaction_type === "refund") {
  totalRefunds += amount;
}
```

and in the return:

```js
return {
  totalSales,
  totalPurchases,
  totalExpenses,
  creditSales,
  repaymentsReceived,
  totalRefunds,
  netBalance: totalSales - totalPurchases - totalExpenses - totalRefunds,
  transactionCount: transactions.length,
};
```

Note you only edit **one** function. Before the daily and monthly accumulators
were merged (section 12.3), this same change had to be made twice — and the
second one is the one you would forget.

### Step 4 — the display

`src/telegram/bot.js`, in `sendDailySummary` (`bot.js:827`) and the `/monthly`
handler (`bot.js:481`), in the shopkeeper branch only:

```js
: `Sales: ${money(summary.totalSales)}
Refunds: ${money(summary.totalRefunds)}
Purchases: ${money(summary.totalPurchases)}
Expenses: ${money(summary.totalExpenses)}
Net Balance: ${money(summary.netBalance)}`;
```

### Step 5 — the migration

**None needed.** `transaction_type` is a plain `text` column with no CHECK
constraint, so a new value needs no schema change.

Worth being clear-eyed about: that is only true *because* the column is loose,
which section 15 lists as a ceiling. If `transaction_type` had the CHECK
constraint it arguably should have, this step would be a migration — and you
would get a database-level guarantee in exchange.

### Step 6 — the tests

**`tests/schema.test.js`** — the invariants already cover the wiring for free.
Add a shape check:

```js
check("a refund is a valid type", () => { … });
```

**`tests/summary.test.js`** — the important one, mirroring the repayment guard:

```js
check("a refund reduces net balance", () => { … });
```

**`tests/ai.test.js`** — one or two classification cases:

```js
{ message: "Refunded ₹500 to Raj for the returned shirt",
  type: "refund", person: "Raj", amount: 500 }
```

The free pre-flight (section 14.5) checks `refund` is legal under `shopkeeper`
before spending an API call.

### The checklist

| # | Layer | File | Silent if forgotten? |
|---|---|---|---|
| 1 | Zod enum | `transaction.schema.js` | No — Zod rejects |
| 2 | Workspace map | `transaction.schema.js` | **No — invariant test goes red** |
| 3 | Prompt | `groq.service.js` | No — AI never emits it |
| 4 | Summary bucket | `summary.service.js` | **YES — totals silently wrong** ⚠️ |
| 5 | Display | `bot.js` | No — visibly missing |
| 6 | Migration | — | n/a |
| 7 | Tests | `tests/` | **YES — until it breaks** |

**Step 4 is the dangerous one.** Every other omission announces itself. A missing
summary bucket produces a row that saves correctly, displays correctly in
`/transactions`, and is simply absent from every total — for months, until
somebody's numbers do not add up and there is nothing to point at.

That is why `summarize()` has its own dedicated test suite, and why the two
accumulators were merged into one function. **Make the silent failure loud, or
make it impossible.**

---

## Where to go next

- **Read next:** `src/database/postgres.js` — every query in the system, all in
  one file, all commented.
- **Then:** `src/telegram/bot.js` — the orchestrator. Start at
  `bot.on("message")` (`bot.js:1138`) and follow it down.
- **Change something small:** add a category to `HOUSEHOLD_CATEGORIES` and watch
  it appear in the prompt with no other edit.
- **Before any schema change:** read the three files in `migrations/` — they are
  the best worked examples of careful change in this repo.

Run `npm test` after everything. It is free and takes under a second.

