← [The five tables](02-tables.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Workspace isolation](04-workspace-isolation.md) →

---

# Relationships between the tables

### What a foreign key actually does

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

### The delete rules differ between tables, deliberately

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

**This has a concrete consequence**, in `finishOnboarding()` (`database/onboarding.js`).
Deleting practice data must go **transactions first, then messages, then
customers**:

```js
// Leaves first. transactions reference customers AND workspaces with
// NO ACTION (not CASCADE), so deleting in any other order fails on a
// foreign key violation.
```

Delete the customer first and Postgres refuses, because a transaction still
points at it. The order is not style — it is forced by the schema.

### What a composite UNIQUE index buys you

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

The upsert that relies on it (`database/workspaces.js`):

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

**And then the scope changed again.** A shopkeeper closing up types the day's
entries in one message — *"400 nu dudh lavya, 300 no sabu lavya"* — which is two
transactions from one `telegram_message_id`. The constraint above made "one
message = one transaction" a physical law, so `005_multi_transaction.sql`
widened it:

```sql
ALTER TABLE transactions ADD COLUMN seq smallint NOT NULL DEFAULT 0;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_user_msg_unique;
ALTER TABLE transactions ADD CONSTRAINT transactions_user_msg_seq_unique
  UNIQUE (user_id, telegram_message_id, seq);
```

**Widened, not dropped — and the difference is the whole point.** That
constraint is what `ON CONFLICT … DO NOTHING` keys off in
`confirmMessageTransaction()`, which is a real double-tap guard. Dropping it
would have silently turned "the second tap is a no-op" into "the second tap
duplicates the books". Adding `seq` keeps the guard working *per entry*: entry 2
no longer collides with entry 1, but a re-confirm of entry 2 still does.

`NOT NULL DEFAULT 0` is what let this ship without touching a single existing
row — every transaction written before the feature is entry 0 of its message,
which is exactly what it was.

### The link with no foreign key

`transactions` and `messages` are related — every confirmed transaction came
from a message — but **there is no foreign key between them.** They are matched
on the pair `(user_id, telegram_message_id)`, which is UNIQUE on both.

That is what makes this join possible (`database/onboarding.js`):

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

### Why `workspace_id` is NOT NULL but `customer_id` is not

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

---

← [The five tables](02-tables.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Workspace isolation](04-workspace-isolation.md) →
