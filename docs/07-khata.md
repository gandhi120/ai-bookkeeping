← [The AI as an untrusted boundary](06-ai-boundary.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Onboarding](08-onboarding.md) →

---

# The khata, and ambiguous payments

## The khata (udhaar / credit book)

**Udhaar** is credit. A regular customer takes goods and pays later. The
shopkeeper writes it in a *khata* — a per-customer running balance.

Two transaction types move it:

| Type | Meaning | Effect on what they owe |
|---|---|---|
| `credit_sale` | took goods without paying | **owes MORE** (+) |
| `repayment` | paid money back | **owes LESS** (−) |

### The balance is never stored

There is no `customers.balance` column. It is computed on every read
(`database/customers.js`):

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

Return type matters too (`database/customers.js`):

```js
return Number(result.rows[0].outstanding);
```

**node-postgres returns `numeric` as a JavaScript string**, not a number — to
avoid float precision loss on money. Without `Number()`, `2000 + "1000"` gives
`"20001000"`. See [the test layer](11-testing.md) for the test that deliberately reproduces this.

### Raj's ledger, entry by entry

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
as what it actually is (`telegram/khata.js`):

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
(`telegram/khata.js`):

```
🔍 No customer named "Raj" in your khata yet.
```

Three different states — no khata, cleared, in advance — that a naive `₹0`
would have flattened into one confusing answer.

### The double-count trap

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

### `/udhaar` — who owes money

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
  same defence-in-depth reason as [workspace isolation](04-workspace-isolation.md).
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

---

## The payment ambiguity problem

### Two sentences, one difference, opposite meanings

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

### The prompt refuses to guess

The shopkeeper prompt is explicit (`groq.service.js:83`):

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

### The app detects the ambiguous case and asks

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
(`telegram/cards.js`):

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

### The answer travels as a type override

The buttons carry a different action word (`telegram/cards.js`):

```js
{ text: "📒 Udhaar Repayment", callback_data: `repayment:${telegramMessageId}` },
{ text: "💰 Normal Payment",   callback_data: `income:${telegramMessageId}` },
```

which is translated through a whitelist (`telegram/callbacks.js`):

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

This is the same shape as the `WORKSPACE_KINDS` check (`telegram/onboarding.js`) and the
`ONBOARDING_STEPS` array (`telegram/onboarding.js`). Three places where user-supplied
strings arrive, three whitelists. *Never let external input choose a code path
by being that path's name.*

The override then travels into the atomic confirm (`database/transactions.js`):

```js
// The shopkeeper's clarification wins over what the AI stored. Resolved
// here, inside the transaction, so the type, the customer link and the
// row are all decided together or not at all.
const transactionType = typeOverride ?? message.transaction_data.transaction_type;
```

Passing the answer *into* the atomic operation — rather than updating
`transaction_data` first and confirming afterwards — keeps it one step. Two
steps would mean a double tap could land between them.

### The plain Confirm button is refused for these

The Confirm button is never *shown* for an ambiguous payment. It is refused
anyway (`telegram/callbacks.js`):

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

---

← [The AI as an untrusted boundary](06-ai-boundary.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Onboarding](08-onboarding.md) →
