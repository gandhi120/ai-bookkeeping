← [The confirmation flow](05-confirmation.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The khata, and ambiguous payments](07-khata.md) →

---

# The AI as an untrusted boundary

### What the AI actually does

One job: turn a sentence into JSON.

**Input:** `"Raj took goods for ₹2,000 on udhaar"`

**Output:**

```json
{
  "intent": "transaction",
  "transaction_type": "credit_sale",
  "description": "Goods taken on udhaar",
  "category": "sales",
  "quantity": 1,
  "amount": 2000,
  "person": "Raj",
  "transaction_date": "2026-08-16",
  "notes": null
}
```

**Input:** `"How much does Raj owe me?"`

```json
{ "intent": "balance_query", "person": "Raj" }
```

**Input (Gujarati):** `"કિરાણા માટે ₹500 ખર્ચ્યા"` — *"spent ₹500 on groceries"*

```json
{
  "intent": "transaction",
  "transaction_type": "expense",
  "description": "Groceries",
  "category": "groceries",
  "quantity": 1,
  "amount": 500,
  "person": null,
  "transaction_date": "2026-08-16",
  "notes": null
}
```

The same message in English, Gujarati script, Roman Gujarati or Hinglish must
produce **identical JSON**. That is instructed explicitly in both prompts, and
`person` and `category` are always written back in English letters with grammar
endings stripped — `રાજેશ` / `રાજેશે` / `"Rajesh ne"` all become `"Rajesh"`.
Without that, the same customer would open three different khatas.

### Two providers, one prompt

```js
export async function askAI(message, workspaceType = "shopkeeper") {
  if (!process.env.GEMINI_API_KEY) {
    return await askGroq(message, workspaceType);
  }

  try {
    return await askGemini(message, workspaceType);
  } catch (geminiError) {
    console.warn("Gemini failed, falling back to Groq:", geminiError.message);

    try {
      return await askGroq(message, workspaceType);
    } catch (groqError) {
      throw new Error(
        `Both providers failed. Gemini: ${geminiError.message} | Groq: ${groqError.message}`
      );
    }
  }
}
```

**Why Gemini first?** Not speed or quality — **the shape of the rate limit**:

| Provider | Free tier limit | Recovery when exhausted |
|---|---|---|
| Gemini `gemini-3.1-flash-lite` | 15 requests **per minute** | ~60 seconds |
| Groq `llama-3.3-70b-versatile` | 100k tokens **per day** | tomorrow |

Hit Gemini's limit and a busy shopkeeper waits a minute. Hit Groq's and the
shop is down until midnight. So the limit that recovers fast is spent first, and
the scarce daily budget is held in reserve.

**Why both errors are surfaced:** if only the Groq error propagated, a typo in
the Gemini API key would look like a Groq outage. Debugging that is miserable.

**Why one shared prompt** (`groq.service.js:31`):

```js
function buildSystemPrompt(workspaceType) {
  return workspaceType === "household"
    ? buildHouseholdPrompt()
    : buildShopkeeperPrompt();
}
```

Both providers call this. If the fallback had its own prompt, the two would
drift — and then the *same sentence would book differently depending on which
provider happened to answer*. That is a bug you would never reproduce reliably.

### Two prompts, not one with a switch

`buildShopkeeperPrompt()` (3,450 chars ≈ 863 tokens) and
`buildHouseholdPrompt()` (1,780 chars ≈ 445 tokens) are separate functions.

Why not one prompt with a section for each? **Because the system prompt is sent
with every single message.** It is a per-message cost, forever. A combined
prompt would make every shop message pay for household rules it can never use.

The household prompt is 48% smaller because a home has no khata — no udhaar, no
customers, and therefore none of the "is this money-in a repayment or not"
reasoning that costs most of the shopkeeper prompt's tokens.

There is a second benefit: the shopkeeper prompt was **not touched** when the
household feature was added. Text tuned over many test runs cannot regress if
nothing edits it.

### The three layers that do not trust the AI

**The AI is instructed, never trusted.** The prompt *tells* the model which
types exist. That is a request. These three layers are enforcement:

```
   AI returns JSON
        │
        ▼
   ┌────────────────────────────────────────────┐
   │ LAYER 1  JSON.parse + Zod MessageSchema    │  is it the right SHAPE?
   └────────────────────────────────────────────┘
        │
        ▼
   ┌────────────────────────────────────────────┐
   │ LAYER 2  isTypeAllowedInWorkspace()        │  is it allowed HERE?
   └────────────────────────────────────────────┘
        │
        ▼
   ┌────────────────────────────────────────────┐
   │ LAYER 3  SQL constraints (CHECK, FK, NOT NULL) │  last line of defence
   └────────────────────────────────────────────┘
```

#### Layer 1 — Zod, and the discriminated union

```js
export const MessageSchema = z.discriminatedUnion("intent", [
  TransactionIntentSchema,
  QueryIntentSchema,
]);
```

A **discriminated union** means: the value can be one of several shapes, and one
field tells you which. Here that field is `intent`.

*You already know this pattern* — it is `switch (action.type)` in a Redux
reducer. `intent: "transaction"` requires amount, type, date, quantity.
`intent: "balance_query"` requires only a person.

Zod reads `intent` first, picks the matching schema, then validates only that
one. So a question is never forced to have an amount, and a transaction is never
allowed to be missing one:

```js
const QueryIntentSchema = z.object({
  intent: z.enum(["balance_query", "history_query"]),
  person: z.string().min(1),
});
```

`.min(1)` because `""` is a perfectly valid string in JavaScript. Without it,
an empty name would sail through and look up a customer called nothing.

#### Layer 2 — the workspace guard

```js
const TYPES_BY_WORKSPACE = {
  shopkeeper: ["sale","purchase","expense","payment_received",
               "payment_sent","credit_sale","repayment","other"],
  household:  ["expense", "income", "other"],
};

export function isTypeAllowedInWorkspace(workspaceType, transactionType) {
  return (TYPES_BY_WORKSPACE[workspaceType] ?? []).includes(transactionType);
}
```

`expense` and `other` are in both — an electricity bill is an expense whether
the meter is at the shop or at home. Everything else is exclusive.

`?? []` matters: an unknown workspace type returns an empty list, so **nothing**
is allowed. Failing closed is the correct default for a permission check.

### Worked example: a hallucination, caught

The user is in **🏠 My Home** and types `"Bought groceries for ₹500"`.

Suppose the model glitches and returns:

```json
{
  "intent": "transaction",
  "transaction_type": "credit_sale",
  "description": "Groceries",
  "category": "groceries",
  "quantity": 1,
  "amount": 500,
  "person": "Raj",
  "transaction_date": "2026-08-16",
  "notes": null
}
```

**Layer 1 — Zod:** ✅ *passes.* `credit_sale` is in `TRANSACTION_TYPES` and the
shape is right. Zod validates structure, not business rules. This is the
important part to understand: **a schema check alone would let this through.**

**Layer 2 — the workspace guard** (`transaction.service.js:64`):

```js
if (!isTypeAllowedInWorkspace(workspaceType, validated.transaction_type)) {
  return {
    intent: "unsupported",
    reason: "TYPE_NOT_IN_WORKSPACE",
    transactionType: validated.transaction_type,
  };
}
```

`isTypeAllowedInWorkspace("household", "credit_sale")` → `["expense","income",
"other"].includes("credit_sale")` → **`false`**. ❌ **Rejected here.**

**What the user sees** (`telegram/messages.js`):

```
I couldn't record that in 🏠 My Home. Try rephrasing, or switch workspace
with /workspace.
```

The message is marked `ANSWERED`. **No transaction row. No customer row. No
khata opened for "Raj" at home.**

Without layer 2, that hallucination would have created a customer and a credit
sale in a household ledger — where the concept does not exist — and the user
would find a debt for someone who never owed them anything.

**Layer 3 would also have stopped part of it:** `workspaces.type` has a CHECK
constraint, `transactions.workspace_id` is NOT NULL, and the FKs must resolve.
Belt, braces, and a third belt — because this is money.

### Where the question is redirected, not forbidden

One more guard, at `transaction.service.js:44`:

```js
if (validated.intent !== "transaction") {
  if (workspaceType !== "shopkeeper") {
    return { intent: "unsupported", reason: "CUSTOMER_QUERY_OUTSIDE_SHOP" };
  }
  return { intent: validated.intent, person: validated.person };
}
```

Ask "How much does Raj owe me?" while in the household, and you get:

```
That's a customer question, and 🏠 My Home has no customers. Switch to your
shop with /workspace.
```

There is a lesson buried in the household prompt here (`groq.service.js:138`):

```
If the message ASKS what somebody owes, or asks to see somebody's entries,
return {"intent": "balance_query", "person": "Name"} and nothing else. The app
explains that this needs the shop — do not invent an intent of your own.
```

An earlier version said *"never return balance_query or history_query"* —
prohibiting without providing an alternative. The model, told not to use the
only fitting label, **invented a new intent**, and Zod threw a `ZodError`
*before* the friendly guard above could run. The user got a generic apology
instead of a useful explanation.

**Tell a model what to do instead, not only what not to do.** A prohibition with
no alternative is an invitation to improvise. Caught by `tests/ai.test.js`
failing 39/40.

---

---

← [The confirmation flow](05-confirmation.md)  ·  [Index](../ARCHITECTURE.md)  ·  [The khata, and ambiguous payments](07-khata.md) →
