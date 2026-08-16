← [Workspace isolation](04-workspace-isolation.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The AI as an untrusted boundary](06-ai-boundary.md) →

---

# The confirmation flow

Nothing enters the books without a human tap. That sentence has a lot of
engineering behind it.

### Why it is database-backed and not an in-memory Map

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
id (`telegram/cards.js`):

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

### The status at every step

Follow one message, `"Raj took goods for ₹2,000 on udhaar"`:

| Step | Code | `messages.status` | `transaction_data` |
|---|---|---|---|
| 1. Message arrives | `telegram/messages.js` `createMessage` | `RECEIVED` | `null` |
| 2. About to call the AI | `telegram/messages.js` | `PROCESSING` | `null` |
| 3. AI answered, Zod passed | `telegram/messages.js` | `PROCESSING` | `{…}` written |
| 4. Preview sent | `telegram/messages.js` | `PENDING_CONFIRMATION` | `{…}` |
| 5. ⏸ waiting for a tap | — | `PENDING_CONFIRMATION` | `{…}` |
| 6. Confirm tapped | `database/transactions.js` | `CONFIRMED` | `{…}` (kept) |

Alternative endings: `CANCELLED` (user tapped Cancel), `FAILED` (AI error or
bad JSON — `telegram/messages.js`), `ANSWERED` (it was a question, nothing to confirm —
`telegram/messages.js`).

`transaction_data` is deliberately **not** cleared on confirm. It is the record
of what the AI proposed, which is what you want when someone reports that a
transaction is wrong.

### `confirmMessageTransaction()` line by line

This is the most important function in the codebase (`database/transactions.js`). It
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
picks a message (`telegram/callbacks.js`).

```js
const transactionType = typeOverride ?? message.transaction_data.transaction_type;
```

The human's clarification beats the AI's guess ([ambiguous payments](07-khata.md)). `??` — nullish
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
From `database/customers.js`:

```
// IMPORTANT: this takes the caller's `client` instead of using the pool.
// The pool hands out separate connections, and a BEGIN on one connection is
// invisible to another.
```

One message can hold several entries ([relationships](03-relationships.md)), so the stored data is
normalised first — `[message.transaction_data].flat()` accepts both the bare
object older rows hold and the array new ones do, which is what keeps a message
saved before the feature still confirmable:

```js
const entries = [message.transaction_data].flat();
```

Then **one INSERT with N rows**, not N inserts:

```sql
INSERT INTO transactions (user_id, workspace_id, transaction_type, …, seq)
VALUES
  ($1, $2, $3, …, $13),
  ($14, $15, $16, …, $26)
ON CONFLICT (user_id, telegram_message_id, seq) DO NOTHING;
```

One statement inside the already-open transaction, so a failure on entry 3
leaves entries 1 and 2 unwritten too. That is what the single Confirm button
promises — and `tests/udhaar.integration.js` asserts it directly: *"a batch with
an unwritable entry throws"* and *"writes NOTHING, not even the good entry"*.

`workspace_id` comes from `message.workspace_id` — **the locked message row**,
never the user's current setting. Section 7 is entirely about why.

The rows are then read back rather than collected with `RETURNING`:

```js
const saved = await client.query(
  `SELECT * FROM transactions
    WHERE user_id = $1 AND telegram_message_id = $2
    ORDER BY seq;`,
  [userId, entries[0].telegram_message_id]
);
```

**Because `DO NOTHING` returns nothing for a row an earlier attempt already
saved.** `RETURNING` would hand back only the rows *this* call happened to
write — so a re-confirm would report zero saved transactions and the user would
see an empty success. Selecting gives the same answer whether this call wrote
the rows or found them, which is what makes a retry indistinguishable from a
first attempt.

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

### The double-tap trace

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

---

← [Workspace isolation](04-workspace-isolation.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The AI as an untrusted boundary](06-ai-boundary.md) →
