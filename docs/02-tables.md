← [What the product is](01-what-it-is.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Relationships between them](03-relationships.md) →

---

# The five tables

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

### `users` — one row per Telegram account

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

`findOrCreateUser` (`database/users.js`) is called on **every single message**.
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

### `workspaces` — a ledger, not an account

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
| Which system prompt the AI receives | `groq.service.js:31` `buildSystemPrompt()` |
| Which transaction types are legal | `transaction.schema.js:91` `isTypeAllowedInWorkspace()` |
| Which features the ledger offers | `transaction.schema.js:62` `featuresForWorkspace()` |
| How `/summary` and `/monthly` render | `summary.service.js:14` `summarize()` |
| Whether `/udhaar` works at all | `commands.js` → `sendUdhaarList()` |

Three lists in `transaction.schema.js` are keyed by it — what a ledger can
**record** (`TYPES_BY_WORKSPACE`), what it can **do** (`FEATURES_BY_WORKSPACE`,
[onboarding](08-onboarding.md)), and which categories it offers (`HOUSEHOLD_CATEGORIES`).

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

### `customers` — the khata

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

The lookup in `getCustomerByName` (`database/customers.js`) matches the index exactly:

```sql
SELECT * FROM customers
WHERE user_id = $1 AND lower(name) = lower($2);
```

Writing `WHERE lower(name) = lower($2)` is what lets Postgres *use* the
`lower(name)` index instead of scanning every row. An index only helps if the
query is shaped like the index.

---

### `messages` — every incoming text, and its lifecycle

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

### `transactions` — the actual books

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
| `seq` | `smallint` | NOT NULL | default `0` — which entry within its message ([relationships](03-relationships.md)) |

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
[known limits](12-limits.md).

**⚠️ `telegram_message_id` is `text` here and `bigint` on `messages`.** Two
different developers-in-time made two different choices. It matters because
joining the tables needs an explicit cast (`database/onboarding.js`):

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

---

← [What the product is](01-what-it-is.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Relationships between them](03-relationships.md) →
