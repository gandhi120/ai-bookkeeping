[Index](../ARCHITECTURE.md)  ·  [The five tables](02-tables.md) →

---

# What the product is

A shopkeeper in India keeps their books in a paper notebook. Sales, purchases,
expenses, and — most importantly — **udhaar**: goods given on credit, tracked
per customer in a *khata*.

Software exists for this. Shopkeepers do not use it, because every one of them
is a form: pick a category from a dropdown, type an amount, pick a date, tap
save. That is slower than the notebook.

This product removes the form. You type what happened, in whatever language you
think in, and it becomes a bookkeeping entry.

The same person also has a home. Rent, groceries, electricity, salary coming
in. That is a completely different set of books which must never mix with the
shop's — so one user can keep **two ledgers** and switch between them.

### The whole product, in one transcript

```
You    Raj took goods for ₹2,000 on udhaar

Bot    📝 Please confirm

       Type: credit_sale
       Description: Goods taken on udhaar
       Category: sales
       Quantity: 1
       Amount: ₹2,000
       Date: 16 Aug 2026
       Customer: Raj
       Currently owes: ₹0
       After this entry: ₹2,000

       [ ✅ Confirm ]  [ ❌ Cancel ]

You    (taps ✅ Confirm)

Bot    ✅ Transaction saved

       Type: credit_sale
       Description: Goods taken on udhaar
       Amount: ₹2,000

       📒 Raj now owes ₹2,000

You    How much does Raj owe me?

Bot    📒 Raj owes you ₹2,000.

You    /summary

Bot    📊 🏪 My Shop — Daily Summary

       Date: 2026-08-16

       Sales: ₹2,000
       Purchases: ₹0
       Expenses: ₹0
       Net Balance: ₹2,000

       Transactions: 1
```

That is the entire product. Everything in this document exists to make those
six exchanges correct, safe, and impossible to corrupt.

### What each piece does

| Piece | Job |
|---|---|
| **Telegram** | The entire UI. No app to install — shopkeepers already have Telegram. |
| **Node.js + `node-telegram-bot-api`** | Receives messages, sends replies. |
| **Gemini / Groq (LLM)** | Turns `"Raj took goods for ₹2,000 on udhaar"` into structured JSON. |
| **Zod** | Checks that JSON is actually the right shape before anything trusts it. |
| **PostgreSQL** | Stores everything. The source of truth. |

Note the LLM's job is *narrow*. It reads a sentence and returns JSON. It does
not decide what is allowed, does not touch the database, and does not choose
which ledger anything goes into. Section 8 covers why.

---

---

## The 30-second mental model

```
   Telegram message
         │
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  telegram/messages.js         the free-text handler   │
   │  - is it text, not a command?  is the sender flooding?│
   │  - who is this user?  which workspace are they in?    │
   └───────────────────────────────────────────────────────┘
         │
         ▼  save the raw message immediately (status RECEIVED)
   ┌───────────────────────────────────────────────────────┐
   │  messages table                                       │
   └───────────────────────────────────────────────────────┘
         │
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  src/services/transaction.service.js                  │
   │  understand the message — never touches the database  │
   └───────────────────────────────────────────────────────┘
         │
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  src/ai/groq.service.js                               │
   │  Gemini  ──fails?──▶  Groq        (one shared prompt) │
   └───────────────────────────────────────────────────────┘
         │  raw JSON text
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  JSON.parse  →  Zod MessageSchema  →  workspace guard  │
   │  the trust boundary                                    │
   └───────────────────────────────────────────────────────┘
         │
         ▼  store the extracted data, status PENDING_CONFIRMATION
   ┌───────────────────────────────────────────────────────┐
   │  messages.transaction_data  (JSONB)                   │
   └───────────────────────────────────────────────────────┘
         │
         ▼  bot shows a preview with Confirm / Cancel buttons
         │
         │  ⏸  nothing more happens until the user taps
         │
         ▼  user taps ✅ Confirm
   ┌───────────────────────────────────────────────────────┐
   │  database/transactions.js                             │
   │  confirmMessageTransaction()                          │
   │  BEGIN → lock row → insert N → mark CONFIRMED → COMMIT│
   └───────────────────────────────────────────────────────┘
         │
         ▼
   ┌───────────────────────────────────────────────────────┐
   │  transactions table          the actual books         │
   └───────────────────────────────────────────────────────┘
```

### The same trip, function by function

You type `"Raj took goods for ₹2,000 on udhaar"`. Here is every hop:

| # | Where | Function | What it returns |
|---|---|---|---|
| 1 | `telegram/messages.js` | `bot.on("message")` fires | — |
| 2 | `telegram/messages.js` | is there `text`? does it start with `/`? | returns early if either |
| 3 | `telegram/messages.js` → `overRateLimit()` | `overRateLimit(from.id)` | `0` while under the limit |
| 4 | `telegram/core.js` → `resolveShopkeeper()` | `resolveShopkeeper(from, chat)` | `{ user, workspace }` |
| 5 | `telegram/messages.js` | `if (!workspace)` — the ledger gate | asks the question, returns |
| 6 | `database/messages.js` → `createMessage()` | `createMessage(...)` | the `messages` row, status `RECEIVED` |
| 7 | `database/messages.js` → `updateMessageStatus()` | `updateMessageStatus(id, "PROCESSING")` | updated row |
| 8 | `transaction.service.js:23` | `processMessage(text, msgId, "shopkeeper")` | calls the AI ↓ |
| 9 | `groq.service.js:278` | `askAI(message, "shopkeeper")` | raw JSON **text** |
| 10 | `transaction.service.js:35-40` | `JSON.parse` → `MessageSchema.parse` | validated object |
| 11 | `database/messages.js` → `updateMessageTransactionData()` | `updateMessageTransactionData(...)` | data stored as JSONB |
| 12 | `database/messages.js` → `updateMessageStatus()` | `updateMessageStatus(id, "PENDING_CONFIRMATION")` | updated row |
| 13 | `telegram/messages.js` | `bot.sendMessage(...)` with buttons | preview shown |

**Steps 2, 3 and 5 all come before the AI call**, and that ordering is the
point: a sticker, a command, a flood, or a user with no ledger costs zero API
budget. Section 15 covers the flood guard, [onboarding](08-onboarding.md) the gate.

**Three branches leave this path before step 11** and never produce a preview:
a question (`balance_query` / `history_query`) is answered immediately and the
message goes `ANSWERED`; an `unsupported` result says why and also goes
`ANSWERED`; and an ambiguous payment ([ambiguous payments](07-khata.md)) reaches step 12 but gets the
clarification buttons at `telegram/cards.js` → `askToConfirm()` instead of Confirm / Cancel.

**…then it stops and waits.** Possibly for hours. Possibly across a server
restart. When the user finally taps Confirm:

| # | Where | Function | What it returns |
|---|---|---|---|
| 14 | `telegram/callbacks.js` | `bot.on("callback_query")` fires | — |
| 15 | `telegram/core.js` → `resolveShopkeeper()` | `resolveShopkeeper(from, chat)` | `{ user, workspace }` |
| 16 | `database/messages.js` → `getMessageByTelegramMessageId()` | `getMessageByTelegramMessageId(...)` | the pending message row |
| 17 | `telegram/callbacks.js` | status is still `PENDING_CONFIRMATION`? | else a toast, and stop |
| 18 | `database/transactions.js` → `confirmMessageTransaction()` | `confirmMessageTransaction(...)` | `{ success: true, transaction }` |
| 19 | `telegram/callbacks.js` | `bot.editMessageText(...)` | preview replaced with the result |

### The one rule that shapes all of it

**Nothing is written to the books without the user tapping Confirm.**

An LLM is a very good guesser and an occasional confident liar. `"Raj paid
1000"` is genuinely ambiguous — it might settle a debt or might not. So the
architecture never asks the model to be right; it asks the model to *propose*,
and asks the human to *approve*.

That single decision is why `messages` has a `status` column, why the extracted
data is parked in `transaction_data` before it becomes a real row, and why
confirmation has to be a locked database transaction. Sections 6 and 7 are
entirely about consequences of this rule.

---

---

[Index](../ARCHITECTURE.md)  ·  [The five tables](02-tables.md) →
