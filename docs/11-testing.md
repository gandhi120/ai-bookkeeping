← [Migrations](10-migrations.md)  ·  [Index](../ARCHITECTURE.md)  ·  [What is deliberately NOT built](12-limits.md) →

---

# The test layer

No test framework. No Jest, no Mocha. Each suite is a plain Node script with a
hand-rolled `check()` and `node:assert/strict`.

That is a deliberate choice at this size: a framework is another dependency,
another config file, and another thing to learn, for a project whose tests run
in under a second.

### The suites

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
budget against the daily limit from [the AI boundary](06-ai-boundary.md). Everything else is free, so
`test:all` can be run without thinking about it.

### The integration tests never touch real data

Both DB suites create **throwaway users** with fake Telegram ids and delete
everything they created in a `finally` block. Existing data is never touched.
`finally` means cleanup runs even when an assertion fails halfway through — a
failing test must not leave debris that breaks the next run.

### One check from each suite

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

### The string-vs-number trap, reproduced on purpose

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

### `ai.test.js` has a free pre-flight

Before spending a single API call, it walks all 40 cases and asserts each one's
expected `type` is legal in that case's workspace, via `isTypeAllowedInWorkspace`.

A case expecting `income` under `shopkeeper` is a broken **test**, not a broken
model. Without the pre-flight it would burn an API call to discover that, then
report a confusing classification failure. The pre-flight fails in milliseconds
and costs nothing.

### A safety net you have not seen catch anything is not known to work

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

---

← [Migrations](10-migrations.md)  ·  [Index](../ARCHITECTURE.md)  ·  [What is deliberately NOT built](12-limits.md) →
