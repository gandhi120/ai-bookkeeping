← [Commands and the code map](09-code-map.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The test layer](11-testing.md) →

---

# Migrations

### What a migration is and why they are files

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

Same all-or-nothing as [the confirmation flow](05-confirmation.md), applied to schema changes. If statement 7 of 9
fails, statements 1–6 are undone. You never end up with a half-migrated
database, which is the single worst state to debug.

### The three migrations

| File | Added | Why |
|---|---|---|
| `001_shopkeeper_udhaar.sql` | `customers` table, `transactions.customer_id`, the per-user unique fix, the `ANSWERED` status | udhaar / khata |
| `002_workspaces.sql` | `workspaces` table, `users.active_workspace_id`, `workspace_id` on two tables, backfill, orphan adoption, NOT NULL | shop + home |
| `003_onboarding.sql` | `users.onboarding_done_at`, `messages.is_onboarding`, backfill | the tutorial |

### `002` — pre-flight checks

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

### `002` step 5 — the orphan adoption

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
[relationships](03-relationships.md)), delete the rows (they are real data), or adopt them.

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

### `003` — the one line that mattered

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

### What "backward compatible" meant in practice

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

---

← [Commands and the code map](09-code-map.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The test layer](11-testing.md) →
