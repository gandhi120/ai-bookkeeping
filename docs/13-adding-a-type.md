← [What is deliberately NOT built](12-limits.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The language layer](14-languages.md) →

---

# How to add a transaction type

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

That is [the test layer](11-testing.md)'s most valuable check earning its keep. Without it you
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

**Keep it to one line.** The prompt ships with every message ([the AI boundary](06-ai-boundary.md)), so
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
were merged ([the code map](09-code-map.md)), this same change had to be made twice — and the
second one is the one you would forget.

### Step 4 — the display

`src/telegram/bot.js`, in `sendDailySummary` (`telegram/cards.js` → `summaryBody()`) and the `/monthly`
handler (`telegram/cards.js`), in the shopkeeper branch only:

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
which [known limits](12-limits.md) lists as a ceiling. If `transaction_type` had the CHECK
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

The free pre-flight ([the test layer](11-testing.md)) checks `refund` is legal under `shopkeeper`
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

---

← [What is deliberately NOT built](12-limits.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The language layer](14-languages.md) →
