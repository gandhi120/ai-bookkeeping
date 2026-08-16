# Future features — from bookkeeping to business intelligence

The product today records what happened. This document is the path from there
to a system that tells a shopkeeper **what happened, what's coming, and what to
do about it.**

```
                 SHOPKEEPER
                     │
                     ▼
              Product Catalog
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
      Purchase                  Sale
          │                     │
          └──────────┬──────────┘
                     ▼
                  Inventory
                     │
                     ▼
              Business Data
                     │
                     ▼
             Analytics Engine
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
     Sales        Inventory      Profit
   Analytics      Analytics     Analytics
       │             │             │
       └─────────────┼─────────────┘
                     ▼
             AI Intelligence
                     │
       ┌─────────────┼──────────────┐
       ▼             ▼              ▼
    Insights      Predictions    Recommendations
       │             │              │
       ▼             ▼              ▼
  "What happened?" "What's next?" "What should I do?"
```

**Read [ARCHITECTURE.md](ARCHITECTURE.md) first** — it indexes `docs/`. This document assumes you know the five
tables, the workspace rule, and the confirmation flow.

---

## The one thing to understand before anything else

Every layer in that diagram **strictly depends on the one below it.** This is
not a menu — it is a ladder, and the rungs cannot be skipped.

- **Inventory** is impossible without a **Product Catalog**, because "how many
  kg of rice do I have?" requires the system to know that "rice", "Rice",
  "10kg rice" and "basmati rice" are the same thing.
- **Profit Analytics** is impossible without **Inventory**, because profit is
  `sale price − cost of the goods sold`, and cost basis comes from purchase
  records tied to the same product.
- **Predictions** are impossible without months of **Analytics** history,
  because there is nothing to extrapolate from.

Building the Analytics Engine first would produce beautiful charts of free-text
strings. That is the failure mode to avoid.

### Where the product actually is today

| Layer | Status |
|---|---|
| Shopkeeper | ✅ done — `users`, `workspaces` |
| Product Catalog | ❌ **does not exist** |
| Purchase / Sale | 🟡 recorded as free text, not linked to products |
| Inventory | ❌ does not exist |
| Business Data | 🟡 `transactions` exists, but is not product-shaped |
| Analytics Engine | 🟡 `summarize()` does daily/monthly totals only |
| Sales / Inventory / Profit Analytics | ❌ |
| AI Intelligence | 🟡 the AI extracts; it does not analyse |
| Insights / Predictions / Recommendations | ❌ |

**The gap between "🟡 recorded as free text" and "Product Catalog" is the whole
project.** Everything above it is comparatively mechanical once that is in
place.

---

## Phase 1 — Product Catalog

**The foundation. Nothing above this works without it.**

### What is wrong today

A sale is stored like this:

| description | category | quantity | amount |
|---|---|---|---|
| `Sold 5 shirts` | `sales` | 5 | 2500 |
| `Sold 3 shirt` | `clothing` | 3 | 1500 |
| `5 shirts sold` | `sales` | 5 | 2500 |

Three rows about the same product, and **nothing in the database knows that.**
`description` is whatever the AI wrote. `category` is a free-text string the AI
picked. There is no product identity.

You cannot answer "how many shirts did I sell this month?" without string
matching, and string matching will never be right — `શર્ટ`, `shirt`, `shirts`,
`half shirt` all have to collapse to one thing.

### The good news: this pattern already exists in the repo

`customers` is **exactly** the shape `products` needs, and it is already
working. Copy it.

```sql
-- from migrations/001_shopkeeper_udhaar.sql
CREATE TABLE customers (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    text NOT NULL,
  …
);
CREATE UNIQUE INDEX customers_user_name_unique
  ON customers (user_id, lower(name));
```

The properties worth stealing:

- **A passive record**, created on first mention. The shopkeeper never fills in
  a form — they type "Raj" and Raj exists. Same for products: type "shirt" and
  the product exists.
- **`UNIQUE (user_id, lower(name))`** — case-insensitive, scoped per user.
- **`findOrCreateCustomer(client, …)` takes the caller's `client`**, so the
  product is created inside the same atomic confirmation as the transaction
  ([the confirmation flow](docs/05-confirmation.md)).

### Proposed schema

```sql
-- migrations/004_products.sql  (sketch — not applied)

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name         text NOT NULL,
  unit         text NOT NULL DEFAULT 'piece',   -- kg | litre | piece | packet | metre
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX products_workspace_name_unique
  ON products (workspace_id, lower(name));

ALTER TABLE transactions
  ADD COLUMN product_id uuid REFERENCES products(id);

CREATE INDEX transactions_product_idx
  ON transactions (workspace_id, product_id, transaction_date);
```

Three decisions in there worth defending:

**`workspace_id`, not just `user_id`.** Note this differs from `customers`,
which is scoped by user only — a known ceiling in [known limits](docs/12-limits.md). Do not
repeat it. The shop's "rice" stock and a household "rice" grocery line are not
the same thing, and the unique index must not merge them.

**`unit` is on the product, not the transaction.** Rice is always in kg. Making
it per-transaction invites "5 kg" and "5 packets" of the same product, which
makes stock arithmetic meaningless.

**`product_id` is nullable.** Same reasoning as `customer_id`
([the tables](docs/02-tables.md)): an electricity bill has no product, and NULL is the
correct representation of that. It also means **every existing row stays valid**
— this migration is purely additive, exactly like `001`–`003`.

### ⚠️ The blocker nobody expects: `quantity` is an integer

```
quantity   bigint   null   default 1
```

`transactions.quantity` is a **`bigint`**. You cannot store `2.5`.

"Sold 2.5 kg rice" is the single most ordinary sentence in an Indian kirana
shop, and today it cannot be represented. It either truncates to 2 or the
insert fails.

**Any inventory feature requires fixing this first:**

```sql
ALTER TABLE transactions
  ALTER COLUMN quantity TYPE numeric(12,3);
```

`numeric`, not `float` — same reason `amount` is `numeric` (`ARCHITECTURE.md`
§9.1). Floats lose precision, and stock levels that drift by 0.0001 per
transaction are worse than no stock levels.

Widening `bigint` → `numeric` is safe and backward compatible: every existing
integer value survives untouched. But remember from §14.4 — **node-postgres
returns `numeric` as a string.** The moment this ships, every place that reads
`quantity` needs `Number()`, exactly like `amount` already does. Grep for
`quantity` before applying.

Zod changes with it:

```js
quantity: z.number().int(),   // today
quantity: z.number(),          // after — .positive() is worth adding too
```

### The hard part: matching what they typed to a product

The AI returns `"description": "Sold 5 shirts"`. Something must decide that is
product `shirt`.

**Do not do this in the prompt.** Asking the model to pick from a list means
sending the shopkeeper's entire catalog with every message — and the system
prompt is already the binding cost ([the AI boundary](docs/06-ai-boundary.md)). A shop with 300
products would pay for all 300 on every "paid electricity bill".

Instead, extract a product **name** and resolve it in code:

1. Prompt gains one field: `"product": "shirt"` (singular, lowercase, English
   letters — the same normalisation rule `person` already follows).
2. `findOrCreateProduct(client, workspaceId, name)` — the exact shape of
   `findOrCreateCustomer`, upserting on the unique index.
3. The **confirmation preview shows the matched product**, so the shopkeeper
   catches a wrong match before it is saved. The confirm/cancel flow already
   exists for exactly this kind of "the AI proposed, the human approves"
   problem — reuse it, do not invent a new correction UI.

Fuzzy matching (`shirts` → `shirt`, typos, transliteration) is a genuine
research problem. **Start with exact lowercase matching**, ship it, and see how
often it actually creates duplicates before building anything cleverer. A
`/products` command to merge two entries is a much smaller feature than a
matching engine, and it lets the shopkeeper fix what the machine got wrong.

### Tests this needs

Mirroring what already exists for customers:

- `products.integration.js` — creation, per-workspace uniqueness, the
  case-insensitive index, and **two workspaces both having "rice" without
  merging** (the mistake `customers` made).
- `schema.test.js` — a `unit` whitelist invariant, same shape as the existing
  `HOUSEHOLD_CATEGORIES` checks.
- One check that a fractional quantity round-trips as a number, not a string.

---

## Phase 2 — Purchase & Sale as stock movements

Once products exist, `purchase` and `sale` stop being only money and start
being **movement**.

| Type | Money | Stock |
|---|---|---|
| `purchase` | out | **in** ▲ |
| `sale` | in | **out** ▼ |
| `credit_sale` | in (owed) | **out** ▼ |
| `expense` | out | none |
| `payment_received` / `payment_sent` | either | none |
| `repayment` | in | **none** |

**Two rows in that table are the whole design, and both are easy to get wrong.**

**`credit_sale` moves stock.** The goods physically left the shop; only the
money is outstanding. This is the same insight as [the khata](docs/07-khata.md), where
`credit_sale` counts as revenue immediately.

**`repayment` moves nothing.** No goods change hands — it is cash against an old
debt. Counting it as a stock movement would decrement inventory twice for one
sale, the exact mirror of the revenue double-count trap.

That symmetry is a good sign: the accounting rule and the stock rule are the
same rule, applied to different units.

### Where this lives in code

Do **not** scatter these rules through `src/telegram/`. They belong beside the existing
type rules in `src/schemas/transaction.schema.js`, which is already the single
place that answers "what does this type mean?":

```js
// alongside CUSTOMER_TRANSACTION_TYPES and TYPES_BY_WORKSPACE
const STOCK_EFFECT = {
  purchase:    +1,
  sale:        -1,
  credit_sale: -1,
};

// 0 for anything not listed — fail-closed, same as isTypeAllowedInWorkspace()
export function stockEffect(transactionType) {
  return STOCK_EFFECT[transactionType] ?? 0;
}
```

And it gets a schema invariant for free, in the style of the existing ones:

> every type with a non-zero stock effect is a shopkeeper type — a household
> has no inventory.

---

## Phase 3 — Inventory

### Derive it, do not store it

This is the most important decision in the whole roadmap, and the codebase has
already made it once.

`customers` has **no `balance` column.** The outstanding amount is a
`SUM(CASE …)` recomputed on every read ([the khata](docs/07-khata.md)). The reasoning:

> A stored `balance` column is faster to read and **wrong the first time
> anything goes sideways.** A sum recomputed from the rows cannot lie.

**Stock is the same problem.** A `products.current_stock` column must be
adjusted by every insert, every cancellation, every onboarding cleanup, every
correction — and the day one path forgets, the number is permanently wrong with
nothing to point at.

```sql
-- getProductStock(workspaceId, productId)
SELECT COALESCE(SUM(
  CASE
    WHEN transaction_type = 'purchase'                      THEN  quantity
    WHEN transaction_type IN ('sale', 'credit_sale')        THEN -quantity
    ELSE 0
  END
), 0) AS in_stock
FROM transactions
WHERE workspace_id = $1
  AND product_id  = $2;
```

Identical shape to `getCustomerBalance`. `COALESCE` for the zero-row case,
`workspace_id` scoping, `Number()` on the way out.

The index `(workspace_id, product_id, transaction_date)` from Phase 1 is
exactly this query's shape.

**When this gets slow** — a shop with 50,000 transactions — the fix is a cached
total that can be **rebuilt from the rows**, not a stored column that cannot.
Materialised view, or a nightly snapshot table with the running sum since the
snapshot. Both keep the rows as the truth.

### Opening stock is a real problem

A shopkeeper installing this app on Tuesday already has stock. Every number
will be wrong until it is entered.

The honest options, worst to best:

1. **Ignore it.** Stock reads negative for weeks. Users conclude the feature is
   broken, because it is.
2. **A setup wizard.** Nobody with 300 products completes it.
3. **Opening balance as a transaction type.** `opening_stock`, entered per
   product, whenever the shopkeeper gets round to it — including months later.
   Stock is a sum over rows, so a row added later is simply included.

Option 3 costs one entry in `TRANSACTION_TYPES`, one line in `STOCK_EFFECT`
(`+1`), and no new concept. **The lazy option is also the correct one** — which
is usually a sign the model fits.

Better still, it needs no wizard: "I have 40 kg rice" is a sentence the existing
pipeline can already almost extract.

### Negative stock is information, not an error

If the books say −3 kg rice, do **not** clamp it to zero. It means a purchase
went unrecorded. That is exactly the kind of thing the shopkeeper needs told:

```
⚠️ Rice shows −3 kg. A purchase may be missing.
```

Same principle as the negative customer balance rendering as "paid in advance"
([the khata](docs/07-khata.md)): a surprising number is a fact about reality, not a bug
to hide.

---

## Phase 4 — Business Data & the Analytics Engine

"Business Data" in the diagram is not a new table. It is the point where
`transactions` becomes **queryable along dimensions**: product, time, customer,
category.

That is already true for time (`transaction_date` + its indexes) and customer
(`customer_id`). Phase 1 adds product. **Once those three exist, the Analytics
Engine is mostly SQL.**

### Extend `summarize()`, do not build a new engine

`src/services/summary.service.js` already is the analytics engine, at daily and
monthly granularity. It was deliberately built to be the **single place** every
transaction type must be accounted for:

> This lives here rather than in each caller because the daily and monthly
> summaries used to be byte-identical copies of the same loop — so every new
> transaction type had to be added twice, and eventually would not be.

The extension is a date range instead of a day or a month:

```js
// src/services/analytics.service.js
export async function analyse(userId, workspaceId, { from, to }, workspaceType)
```

with `getDailySummary` and `getMonthlySummary` becoming thin callers of it —
exactly as `getMonthlySummary` already became a thin caller of `summarize()`.

⚠️ **Keep the half-open range** from `getTransactionsByMonth`:

```sql
AND transaction_date >= $from
AND transaction_date <  $to
```

`>= from AND < to`, never `BETWEEN`. [the code map](docs/09-code-map.md) explains why.

### The three analytics, and what each needs

| | Answers | Needs | Available after |
|---|---|---|---|
| **Sales Analytics** | best sellers, slow movers, day/hour patterns | product on sales | Phase 1 |
| **Inventory Analytics** | what is low, what is dead stock, turnover rate | stock levels | Phase 3 |
| **Profit Analytics** | margin per product, real profit | **cost basis** | Phase 3 + costing |

**Profit is the hard one, and it is worth being blunt about why.**

Revenue is easy — it is on the sale row. Profit needs **cost of goods sold**:
what *these particular* units cost when they were bought. And the price of rice
changes every month.

Rice bought at ₹40/kg in June and ₹45/kg in July, then 10 kg sold in August —
what did those 10 kg cost? Three standard answers (FIFO, weighted average, last
purchase price), and they give different profits from identical data.

**Recommendation: weighted average cost.** It is one query over existing rows,
it needs no per-unit lot tracking, and for a kirana shop it is accurate enough
that the difference from FIFO is noise:

```sql
-- average cost per unit, from purchase history
SELECT SUM(amount) / NULLIF(SUM(quantity), 0) AS avg_cost
FROM transactions
WHERE workspace_id = $1
  AND product_id = $2
  AND transaction_type = 'purchase';
```

`NULLIF(…, 0)` prevents division by zero — a product with only sales and no
recorded purchase returns NULL rather than crashing the report. Handle that
NULL as "cost unknown" and say so in the UI rather than showing a confident
wrong margin.

FIFO is a real upgrade, and it is a **big** one: it needs per-lot tracking,
which means a new table and every sale consuming specific lots. Do not build it
until a shopkeeper actually asks.

---

## Phase 5 — AI Intelligence

The three questions in the diagram are three genuinely different problems, and
they get harder left to right.

```
  "What happened?"      "What's next?"       "What should I do?"
      Insights            Predictions          Recommendations
    ────────────        ──────────────        ─────────────────
    SQL + templates      statistics            judgement
    deterministic        needs history         needs trust
    ship first           ship later            ship last
```

### 5.1 Insights — "What happened?"

**This needs no AI at all, and that is the point.**

```
📊 This week

Best seller: Rice — 45 kg, ₹18,000
Slowest: Soap — 2 units in 30 days
Biggest expense: Electricity ₹2,400 (up 18% on last month)
Raj's udhaar has been outstanding 42 days
```

Every line there is a SQL query and a sentence template. Deterministic,
instant, free, and **it cannot hallucinate a number**.

Using an LLM to write these would mean a model handling arithmetic on the
shopkeeper's money. Models are bad at arithmetic and confident about it. **Let
SQL compute; let templates phrase.** If the language should feel less robotic,
have the model rewrite a sentence whose numbers are already fixed — never let it
produce the number.

Ship this first. It is the highest value-to-risk ratio in the entire roadmap.

### 5.2 Predictions — "What's next?"

```
📉 Rice will run out in about 4 days
📈 Next month's sales look like ₹1.2–1.5 lakh
```

**The cold-start problem is the whole difficulty.** A shop with three weeks of
data cannot be forecast. Predicting from thin data produces confident nonsense,
and one bad prediction destroys trust in every good one.

Rules that make this safe:

- **A minimum history bar.** No forecast under ~8 weeks of data. Say so plainly:
  "I need about two months of entries before I can predict this."
- **Ranges, never point estimates.** "₹1.2–1.5 lakh", not "₹1,34,500".
- **Start with the simplest thing that works.** Days-of-stock-remaining is
  `current_stock ÷ average daily sales` — arithmetic, not machine learning.
  Ship that, see if anyone uses it, and only then consider seasonality.
- **Festivals matter enormously in Indian retail.** Diwali sales are not a trend
  continuing; they are a spike. A naive model will over-forecast the following
  month badly. This alone may justify holding predictions back.

### 5.3 Recommendations — "What should I do?"

```
💡 Order 50 kg rice before Friday — you sell 12 kg/day and have 38 kg
💡 Soap has not sold in 30 days — consider not restocking
💡 Raj owes ₹4,000 for 42 days — worth a reminder
```

**The trust problem is the real engineering problem here.** A recommendation is
the app telling someone to spend money. Get it wrong twice and the feature is
turned off forever — along with the shopkeeper's confidence in everything else.

Non-negotiables:

- **Always show the reasoning.** Never "order 50 kg rice". Always "you sell 12
  kg/day and have 38 kg". The shopkeeper knows things the data does not — a
  wedding order, a supplier problem — and reasoning lets them overrule you
  intelligently.
- **Never act automatically.** No auto-ordering, ever. The confirm/cancel
  pattern ([the confirmation flow](docs/05-confirmation.md)) is the existing answer to "the machine
  proposes, the human decides" — extend it, do not bypass it.
- **Fewer, better.** Three good recommendations a week beat twenty daily. Twenty
  daily is noise, and noise gets muted.

### Where the LLM genuinely helps

Not in computing any of the above. In **two** places:

1. **Natural-language questions over the data.** "How much rice did I sell last
   month?" → the model turns that into a *parameterised call to an existing
   analytics function*, not into raw SQL it invents. The whitelist pattern from
   `CLARIFIED_TYPE` ([the khata](docs/07-khata.md)) applies exactly: the model picks
   from known functions, never writes the query.
2. **Phrasing.** Turning a computed result into a sentence in the shopkeeper's
   language — which the existing multilingual prompt work already handles well.

**The rule that has held throughout this codebase holds here too: the AI is
instructed, never trusted.** It reads language and proposes structure. Money is
computed by SQL and approved by a human.

---

## What this means for the existing architecture

Honest accounting of what has to change, and what does not.

### Stays exactly as it is

- The five tables, all of them
- The confirmation flow — it becomes *more* important, not less
- Workspace isolation by `workspace_id`
- The Gemini→Groq fallback and the two-prompt split
- Zod as the trust boundary

### Must change

| Change | Why | Risk |
|---|---|---|
| `transactions.quantity` → `numeric` | 2.5 kg is unrepresentable | **`Number()` needed at every read site** |
| New `products` table + `transactions.product_id` | the foundation | low — purely additive |
| Prompt gains a `product` field | to extract it | **prompt is per-message cost — one field only** |
| `summarize()` grows a date range | analytics | low — it is already the single place |
| `stockEffect()` in `transaction.schema.js` | stock rules beside type rules | low |

### The ceilings this collides with

From [known limits](docs/12-limits.md), the ones this roadmap actually walks into:

- **`customers` has no `workspace_id`.** Give `products` one from day one. Do
  not copy the mistake.
- **Most `transactions` columns are nullable.** Analytics on a table where
  `amount` can be NULL will produce silently wrong aggregates. Worth tightening
  *before* building reports on top, not after.
- **`transactions.telegram_message_id` is `text`, `messages` is `bigint`.** More
  joins are coming. Fix it in its own migration first.
- **The Telegram handlers have no direct tests.** `bot.js` was split into eight
  files in `src/telegram/`, which makes `cards.js` (pure renderers — plain
  objects in, strings out) cheap to test for the first time. Every phase here
  adds handlers, so this is the point at which that ceiling stops being
  theoretical.

---

## Suggested order

Each step is shippable on its own and useful before the next one exists.

| # | Ship | Unlocks | Rough size |
|---|---|---|---|
| 0 | `quantity` → `numeric`, `Number()` at read sites | everything | small, do it first |
| 1 | `products` table + `product_id`, prompt field, preview shows match | catalog | **large — the real work** |
| 2 | `/products` list + merge duplicates | fixing bad matches | small |
| 3 | `stockEffect()` + `getProductStock()` + `/stock` | inventory | medium |
| 4 | `opening_stock` type | correct stock for existing shops | small |
| 5 | `analyse()` over a date range | reports | medium |
| 6 | Insights — SQL + templates | "what happened?" | medium, **high value** |
| 7 | Weighted-average costing → profit per product | margins | medium |
| 8 | Days-of-stock-remaining | first prediction | small |
| 9 | Forecasts with a minimum-history bar | "what's next?" | large |
| 10 | Recommendations with visible reasoning | "what should I do?" | large |

**Steps 0–2 are the project.** Steps 3–7 are mostly SQL once the catalog exists.
Steps 8–10 should not start until there are real shops with real months of data
to test against — building a predictor with no history to validate it against is
building something you cannot tell is wrong.

---

## Still deliberately not building

Unchanged from the original scope, and none of this changes it:

Investments, stocks, mutual funds, loans, insurance, tax planning, advanced
budgeting, financial advice, bank integrations, UPI, OCR/receipt scanning,
complex multi-user permissions, an AI financial advisor, advanced analytics
dashboards.

Two worth re-examining **only after** Phase 3, because the catalog makes them
cheaper than they used to be:

- **Barcode scanning** — a photo to `product_id`. Genuinely useful once products
  have stable ids. Meaningless before.
- **Supplier records** — `payment_sent` already has a `person` field doing
  nothing. The `customers` pattern would work unchanged.

Both are still "not yet". The list exists so that adding to it is a decision
rather than a drift.
