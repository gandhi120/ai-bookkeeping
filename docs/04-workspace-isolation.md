← [Relationships between them](03-relationships.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The confirmation flow](05-confirmation.md) →

---

# Workspace isolation

## Why isolation is by `workspace_id`, not `user_id`

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

**Filtering on `workspace_id` — right** (`database/transactions.js`):

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

From `database/transactions.js`:

```
// Scoped by workspace_id, not user_id: the same user owns both their shop and
// their home, so user_id alone would show the household groceries inside the
// shop's /summary. user_id is kept in the WHERE as well — it is implied by
// the workspace, but checking both means a wrong id can never cross tenants.
```

### Every query that enforces it

| Function | File:line | Filters on |
|---|---|---|
| `getTransactionsByDate` | `database/transactions.js` | `user_id` + `workspace_id` + date |
| `getTransactionsByMonth` | `database/transactions.js` | `user_id` + `workspace_id` + month range |
| `createMessage` | `database/messages.js` | writes `workspace_id` |
| `confirmMessageTransaction` | `database/transactions.js` | reads `workspace_id` off the locked row |
| `getWorkspaces` | `database/workspaces.js` | `user_id` |
| `setActiveWorkspace` | `database/workspaces.js` | `user_id` + ownership check |

And the khata functions (`getCustomerBalance`, `getAllOutstanding`) filter on
`user_id` + `customer_id` — see [known limits](12-limits.md) for why that is sufficient today.

### The chokepoint that makes it hard to get wrong

Every handler starts the same way (`telegram/core.js`):

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
yet, and every handler checks for it explicitly rather than guessing a default.
All eight call sites — the seven commands in `telegram/commands.js` plus the
free-text handler in `telegram/messages.js` — route to `startSetup()` in
`telegram/core.js`, which asks for the language first and the ledger second.

That the gate is repeated eight times rather than centralised is deliberate:
there is no single funnel every update passes through, so the alternative to
eight explicit checks is one forgotten one.

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

---

## Why the workspace is stamped on the message

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

**Stamp it when the message arrives** (`database/messages.js`):

```sql
INSERT INTO messages (
  user_id, workspace_id, telegram_message_id, message_text, status, is_onboarding
)
VALUES ($1, $2, $3, $4, $5, $6)
```

with the comment at `database/messages.js`:

```
// workspace_id is stamped here, at arrival, and never re-read from the user's
// current setting afterwards. That is what makes confirmation safe: the user
// can switch workspaces between typing a message and tapping Confirm, and the
// transaction still lands in the ledger they typed it into.
```

**Read it back off the locked row at confirmation** (`database/transactions.js`):

```sql
SELECT id, user_id, workspace_id, status, transaction_data
FROM messages
WHERE id = $1 AND user_id = $2
FOR UPDATE;
```

then, in the insert (`database/transactions.js`):

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

---

← [Relationships between them](03-relationships.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The confirmation flow](05-confirmation.md) →
