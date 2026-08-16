← [Onboarding](08-onboarding.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Migrations](10-migrations.md) →

---

# Commands and the code map

Every command lives in `telegram/commands.js`. The column that matters is the
third one — the function you actually edit.

| Command | Does the work | Tables read |
|---|---|---|
| `/start` | `sendWelcomeHelp()` | `users`, `workspaces` |
| `/help` | inline | `users`, `workspaces` |
| `/workspace` | `getWorkspaces()`, `setActiveWorkspace()` | `workspaces`, `users` |
| `/language` | `askToChooseLanguage()` (in `telegram/core.js`) | `users` |
| `/summary` | `sendDailySummary()` → `summaryBody()` | `transactions` |
| `/transactions` | `sendTransactionsList()` | `transactions` |
| `/monthly` | `sendMonthlySummary()` → `summaryBody()` | `transactions` |
| `/udhaar` | `sendUdhaarList()` | `customers` ⋈ `transactions` |
| *free text* | `telegram/messages.js` → `processMessage()` → `askAI()` → Zod | writes `messages` |
| *button tap* | `telegram/callbacks.js` → `confirmMessageTransaction()` | `messages`, `transactions`, `customers` |

Every one of them starts with `resolveShopkeeper()` and every one checks
`if (!user.language || !workspace)` before touching data — routing to
`startSetup()` when either is missing.

### Where the Telegram code lives

`bot.js` was one 2,200-line file until it was split by responsibility. Eight
files now, and the split is only safe because it is **acyclic** — each level
may import from the levels above it, never sideways or down:

| File | Holds | Imports from |
|---|---|---|
| `telegram/core.js` | the `bot` instance, `resolveShopkeeper()`, the setup gate, `money()`/`today()`/`sendError()` | nothing local |
| `telegram/cards.js` | `transactionCard()`, `summaryBody()`, `askToConfirm()` | core |
| `telegram/khata.js` | `answerBalanceQuery()`, `answerHistoryQuery()` | core |
| `telegram/commands.js` | the eight slash commands + their renderers | core, cards |
| `telegram/messages.js` | the flood guard and `bot.on("message")` | core, cards, khata |
| `telegram/onboarding.js` | `TOUR`, the language/workspace pickers, `finishOnboarding` wiring | core, commands |
| `telegram/callbacks.js` | `bot.on("callback_query")` — every button tap | core, cards, onboarding |
| `telegram/bot.js` | `start()`, `shutdown()`, the entry-point guard | all of the above |

**`core.js` importing nothing local is the rule that keeps this honest.** The
one cycle that existed — `commands` needing the practice prompt while
`onboarding` needed the command renderers — was broken by moving
`sendPracticePrompt()` into `core.js`. If you find yourself adding an import
that points *up* this table, that is the cycle trying to come back.

Handlers register themselves as a side effect of their module being imported,
so `bot.js` imports `commands`, `messages` and `callbacks` for that alone —
**import order is registration order.**

**Why four `send*` helpers separate from their handlers.** Each command's body
was split out so the onboarding feature tour ([onboarding](08-onboarding.md)) can run **the real
command** against the user's own data rather than a mock-up of it. The `/summary`
handler is now just error handling around `sendDailySummary(chatId, user,
workspace)`; the tour calls the same function.

The alternative — the tour printing its own approximation of each report —
would mean two renderings of every command that must be kept in step forever.
Here, improving `/summary` improves the tour automatically, and the tour can
never show a user something their real command does not do.

### The same command, two ledgers

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

The branch (`telegram/cards.js` → `summaryBody()`):

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

### `/monthly` in the household adds a breakdown

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

### `/summary` and `/monthly` share their accumulator

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

The month range query is worth a look (`database/transactions.js`):

```sql
AND transaction_date >= make_date($3, $4, 1)
AND transaction_date <  make_date($3, $4, 1) + INTERVAL '1 month'
```

`>=` start and `<` next month — a **half-open range**. Never
`BETWEEN … AND last_day`, which forces you to work out whether the month has
28, 29, 30 or 31 days. `+ INTERVAL '1 month'` lets Postgres handle leap years
and month lengths. Half-open ranges are almost always the right shape for dates.

### Dates and money

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

---

← [Onboarding](08-onboarding.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Migrations](10-migrations.md) →
