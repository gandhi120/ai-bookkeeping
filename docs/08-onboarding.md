← [The khata, and ambiguous payments](07-khata.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Commands and the code map](09-code-map.md) →

---

# Onboarding

A new user types `"hii"`. They have no ledger, no idea what the bot does, and
one chance to not close the app.

### The complete flow

```
You    hii

Bot    👋 Hi Varun! I'm your bookkeeping assistant.

       Just type what happened — like "Bought 10 kg rice for ₹600" — and I'll
       write it in your books. No forms, no Excel.

       First, what should I keep books for?

       You can add the other one later, so this is not final.

       [ 🏪 My Shop — sales, purchases, udhaar ]
       [ 🏠 My Home — household spending       ]

You    (taps 🏪 My Shop)

Bot    ✅ Now using 🏪 My Shop
Bot    🏪 My Shop is ready.
Bot    Let's try it once — takes 30 seconds.

       Type this, or your own version:

       Bought 10 kg rice for ₹600

       [ ⏭ Skip setup ]

You    Bought 10 kg rice for ₹600

Bot    📝 Please confirm
       Type: purchase … Amount: ₹600
       [ ✅ Confirm ]  [ ❌ Cancel ]

You    (taps ✅ Confirm)

Bot    ✅ Transaction saved
Bot    🎉 That's the whole app — type it, tap Confirm.

       Want to see what else I can do?

       [ 📊 Today's summary  ]
       [ 📅 This month       ]
       [ 📋 Today's entries  ]
       [ 📒 Who owes me      ]
       [ ✅ Finish setup     ]

You    (taps 📒 Who owes me)

Bot    📒 Nobody owes you money right now.

       When you record something like "Raj took goods for ₹2,000 on udhaar",
       Raj will appear here until he pays it back.
Bot    What else?

       [ 📊 Today's summary ] … [ ✅ Finish setup ]

You    (taps ✅ Finish setup)

Bot    Almost done.

       You have 1 practice entry in your books from setup. Clear them so your
       real accounts start from zero?

       [ 🧹 Clear practice data ]
       [ 📌 Keep it             ]

You    (taps 🧹 Clear practice data)

Bot    ✅ All set. Cleared 1 practice entry.
Bot    👋 You're in 🏪 My Shop.
       [full command list]
```

### Two columns hold the whole thing

```sql
ALTER TABLE users ADD COLUMN onboarding_done_at timestamptz;

ALTER TABLE messages
  ADD COLUMN is_onboarding boolean NOT NULL DEFAULT false;
```

**`users.onboarding_done_at`** — NULL means still onboarding:

```js
function isOnboarding(user) {
  return !user.onboarding_done_at;
}
```

Read straight off the `users` row `resolveShopkeeper` already fetched, so
checking costs **no extra query**.

**Why a timestamp and not a boolean?** It costs the same to store and answers
questions a boolean cannot: when did they finish, how long did setup take, where
do people drop off. A boolean throws that away for nothing.

**There is no step counter.** Which step the user is on is carried by the
*button they are about to tap* — `onb:summary`, `onb:finish`, `onb:clear`,
`onb:keep` — exactly like the existing `confirm:` / `cancel:` / `addws:`
buttons. The position in the flow lives in the callback data, not in a column
that could get out of sync with what is on screen.

### Why the flag is on `messages`, not `transactions`

`is_onboarding` marks a **message** as practice data, stamped at arrival
(`telegram/messages.js`):

```js
savedMessage = await createMessage({
  user_id: user.id,
  workspace_id: workspace.id,
  telegram_message_id: message.message_id,
  message_text: message.text,
  status: "RECEIVED",
  // Stamped at arrival, not read back later: this is what marks the row
  // as practice data, and it is the key the cleanup deletes by.
  is_onboarding: isOnboarding(user),
});
```

**Why not flag the transaction instead?** Because the message is where the
decision is knowable. At arrival we know whether the sender is mid-tutorial. The
transaction is created *later*, at confirm time, by a function that would then
need to be told — one more parameter threaded through the atomic confirm for no
gain.

Transactions are reached **through** their message:

```sql
t.user_id = $1
AND m.user_id = $1
AND m.is_onboarding
AND t.telegram_message_id = m.telegram_message_id::text
```

This is the join from [relationships](03-relationships.md), and it works because `(user_id,
telegram_message_id)` is UNIQUE on both tables — so it matches at most one
transaction per message.

Note this WHERE clause is defined **once** as a constant
(`database/onboarding.js`) and used by both the counter and the deleter:

```js
const ONBOARDING_TRANSACTIONS_WHERE = ` … `;
```

That is deliberate: **the number the user is told is produced by the exact same
condition as the rows that disappear.** If the count and the delete could drift
apart, the confirmation dialog would be lying.

### The only DELETE in `src/`, and its four guard rails

`finishOnboarding()` (`database/onboarding.js`) is the **only function in the entire
`src/` directory that deletes anything**. Everything else only inserts and
updates. That is worth knowing: if data disappears, there is exactly one place
to look.

```js
export async function finishOnboarding(userId, { clear }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
```

**Guard rail 1 — every statement is scoped `WHERE user_id = $1`.** One user's
cleanup can never reach another's rows.

**Guard rail 2 — only rows reached through `messages.is_onboarding`.** Real
transactions are excluded by construction, not by remembering to filter them.

**Guard rail 3 — `users` and `workspaces` are never touched.** The workspace
the user just created is the entire point of onboarding; deleting it would
strand them back at the gate.

**Guard rail 4 — one transaction.** A failure halfway leaves the practice data
**intact** rather than half-deleted.

```js
if (clear) {
  // Leaves first. transactions reference customers AND workspaces with
  // NO ACTION (not CASCADE), so deleting in any other order fails on a
  // foreign key violation.
  const transactions = await client.query(
    `DELETE FROM transactions t USING messages m WHERE ${ONBOARDING_TRANSACTIONS_WHERE};`,
    [userId]
  );
```

**The order is forced by the schema, not chosen for style.** From [relationships](03-relationships.md):
`transactions.customer_id` is `NO ACTION`. Try to delete the customer while a
transaction still points at it and Postgres refuses the whole statement.

`DELETE … USING` is how you delete from one table using a condition that
references another — the delete equivalent of a join.

Then messages, then customers:

```js
  const customers = await client.query(
    `
    DELETE FROM customers c
    WHERE c.user_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM transactions t WHERE t.customer_id = c.id
      );
    `,
    [userId]
  );
```

**`NOT EXISTS (SELECT 1 …)`** — "delete this customer only if no transaction
anywhere points at them." After the delete above, that is *exactly* the practice
customers. A real customer always has at least the entry that created them.

Why bother? A practice `"Raj took goods on udhaar"` opens a khata for Raj. Clear
the transactions and Raj is left with an empty ledger — a name the shopkeeper
only ever typed as an example, sitting in their customer list forever.

**The `keep` path is not a no-op:**

```js
} else {
  // Keeping the data. The flags are cleared so these rows are no longer
  // reachable by the delete above under any future call.
  await client.query(
    `UPDATE messages SET is_onboarding = false WHERE user_id = $1 AND is_onboarding;`,
    [userId]
  );
}
```

A user who chose "Keep it" can never have those entries deleted by any later
run — the flag that made them deletable is gone. **Making an unwanted outcome
unreachable beats remembering not to trigger it.**

Finally, on both paths:

```js
await client.query(
  `UPDATE users SET onboarding_done_at = NOW(), updated_at = NOW() WHERE id = $1;`,
  [userId]
);

await client.query("COMMIT");
```

### The feature tour, and where its buttons come from

After the practice entry saves, the user is offered a tour — each button runs a
**real command against their own data**, not a mock-up.

Which buttons appear is not hardcoded in the bot. It comes from a third list in
`transaction.schema.js:52`:

```js
// What each ledger can DO, as opposed to TYPES_BY_WORKSPACE above, which is
// what it can RECORD.
const FEATURES_BY_WORKSPACE = {
  shopkeeper: ["summary", "monthly", "transactions", "udhaar"],
  household:  ["summary", "monthly", "transactions"],
};

export function featuresForWorkspace(workspaceType) {
  return FEATURES_BY_WORKSPACE[workspaceType] ?? [];
}
```

Note the `?? []` — the **same fail-closed default** as
`isTypeAllowedInWorkspace()` ([the AI boundary](06-ai-boundary.md)). An unknown workspace type offers
*nothing* rather than everything. When in doubt, a permission-shaped function
should deny.

`udhaar` is shopkeeper-only, so a household user is never offered a khata
button. The rule lives in the schema next to the other workspace rules, not in
the UI.

Then in `telegram/onboarding.js`, one table pairs each feature's label with the function
that runs it:

```js
const TOUR = {
  summary:      { label: "📊 Today's summary", run: sendDailySummary },
  monthly:      { label: "📅 This month",      run: sendMonthlySummary },
  transactions: { label: "📋 Today's entries", run: sendTransactionsList },
  udhaar:       { label: "📒 Who owes me",     run: sendUdhaarList },
};
```

**One table, not two maps.** A label map beside a separate action map would let
a feature have a button with no handler — which sends Telegram a button
captioned `undefined` — or a handler no button reaches. Pairing them in one
entry makes both halves impossible to forget.

The buttons are then built by intersecting the two (`telegram/onboarding.js`):

```js
const featureRows = featuresForWorkspace(workspace.type).map((feature) => [
  { text: TOUR[feature].label, callback_data: `onb:${feature}` },
]);
```

And the whitelist from [ambiguous payments](07-khata.md) is **derived** rather than retyped
(`telegram/onboarding.js`):

```js
const ONBOARDING_STEPS = [...Object.keys(TOUR), "finish", "clear", "keep"];
```

Its comment names the exact failure this prevents:

```
// Every tour feature must appear here or its button silently does nothing
// useful — an unlisted step does not reach "Unknown action", it falls through
// to the transaction path and reports "Transaction not found."
```

That is a subtle one. An unlisted `onb:` step does not hit a friendly "unknown
action" branch — it falls past the `onb` check into the transaction path, where
`Number("summary")` is `NaN` and the user gets a baffling "Transaction not
found." Deriving the whitelist from `TOUR` makes the mismatch unrepresentable.

**Why the tour comes after the first save, not before.** From `telegram/onboarding.js`:

```
// This is the moment the user has seen the whole loop work, so the tour is
// offered here and nowhere earlier: every command below now has at least one
// real row to show. /summary and /monthly have no empty state, so offering
// them before anything is recorded would introduce the user to their own
// books as a wall of ₹0.
```

And every tour button re-offers the card afterwards (`"What else?"`), so trying
a second feature is one tap rather than a hunt.

Running the real commands means their **empty states** are part of onboarding
too. `/udhaar` with nobody owing says how a khata is created rather than only
that there isn't one (`telegram/commands.js`):

```
📒 Nobody owes you money right now.

When you record something like "Raj took goods for ₹2,000 on udhaar", Raj will
appear here until he pays it back.
```

"Everyone has cleared their balance" — the obvious wording — reads as a mistake
to a shopkeeper who has never lent to anybody, which is exactly who taps this
button during the tour.

#### The skip button

The practice prompt carries `⏭ Skip setup`, pointing at `onb:finish`
(`telegram/core.js`) — **the same step the Finish button uses.**

Skipping is therefore not a separate path with its own rules. It ends
onboarding through the identical code, and still offers to clear anything
already recorded. A second path would be a second place for the cleanup logic
to drift.

### The count is the safety rail

```js
async function askToClearPracticeData(chatId, count) {
  const entries = count === 1 ? "1 practice entry" : `${count} practice entries`;
  …
}
```

**Everything typed while onboarding is open counts as practice.** A user who
ignores the Finish button for a week would be clearing a week of real work.

Showing the count is what makes that visible *before* the tap:

```
You have 47 practice entries in your books from setup. Clear them so your
real accounts start from zero?
```

At 1, that reads as housekeeping. At 47, it stops you. And "📌 Keep it" is
offered with equal visual weight — not a small grey link next to a big red
button.

Two more details:

- **Zero entries skips the question entirely** (`telegram/onboarding.js`). Asking "shall I
  delete 0 rows?" is noise.
- **`finish` and `clear` are separate taps.** Deleting data always takes a
  deliberate second confirmation.

### The gate is unskippable because it is everywhere

`askToChooseWorkspace()` is called from **eight** places — every command handler
and the free-text handler. Not just `/start`.

The reason is in the comment (`telegram/core.js`):

```
// No workspace means no ledger, so nothing else in the bot can run: every
// command and every message routes here until a choice is made. That is what
// makes onboarding unskippable, and it is why this is sent from ten different
// places rather than only from /start — most people never type /start, they
// just say "hii".
```

**Most people never type `/start`.** They say "hii". Designing onboarding to
begin at `/start` means designing it for users who do not exist.

They also say 👋 with a sticker, and a sticker update has no `text` at all. The
message handler returns early on that (`telegram/messages.js`) — without the guard,
`undefined` reaches `createMessage`, whose `message_text` column is NOT NULL,
and a first contact ends in a crash:

```js
if (!message.text) {
  return;
}
```

And a beginner who types "hii" mid-tutorial does not get an apology about a
transaction they never tried to record (`telegram/messages.js`):

```js
if (onboardingWorkspace) {
  await sendPracticePrompt(message.chat.id, onboardingWorkspace);
  return;
}
```

They get the practice prompt again — which carries its own "⏭ Skip setup"
escape hatch, so somebody who never types anything is not trapped.

---

---

← [The khata, and ambiguous payments](07-khata.md)  ·  [Index](../ARCHITECTURE.md)  ·  [Commands and the code map](09-code-map.md) →
