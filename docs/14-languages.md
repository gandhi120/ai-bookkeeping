← [How to add a transaction type](13-adding-a-type.md)  ·  [Index](../ARCHITECTURE.md)

---

# The language layer

The bot speaks English, Hindi and Gujarati. `src/i18n/` holds one catalog per
language (`en.js` is the reference) plus `index.js` with `LANGUAGES`, `t()`,
`translator()`, `isLanguage()`, `enumLabel()`, `formatDate()` and
`formatMonth()`. **No dependency** — the runtime is about 130 lines.

### NULL means "has not chosen yet"

```sql
ALTER TABLE users ADD COLUMN language text
  CHECK (language IN ('en', 'hi', 'gu'));
```

**There is deliberately no column default.** A default cannot be told apart from
a deliberate choice of English — and the difference matters, because NULL is what
puts the picker in front of a new user. This is the same lesson as
`onboarding_done_at` in [onboarding](08-onboarding.md): *when you add a nullable column, ask what
NULL means to the code that reads it.* Here it means "ask them".

And the same trap applies. `004_language.sql` backfills existing users to `'en'`
for exactly the reason `003` backfilled `onboarding_done_at` — without it, every
user already using the bot would be stopped mid-conversation and asked to pick a
language they had already been reading for weeks.

### The language is asked before the ledger

`startSetup()` in `telegram/core.js` is the single gate, and the order is not
arbitrary: **every other word of onboarding depends on the answer.** Asking
"shop or home?" first means asking it in a language the user may not read.

That creates one message that cannot be translated — the picker itself, which is
sent before the answer exists. It solves this by leaning on buttons written in
their own scripts (`हिन्दी`, `ગુજરાતી`), so the user recognises their language
rather than reading an instruction about it.

### `t()` falls back twice, and why that needs a test

```js
const text = CATALOGS[language]?.[key] ?? CATALOGS[DEFAULT_LANGUAGE][key] ?? key;
```

Unknown language → English. Unknown key → the key itself. That double fallback
is what lets the catalogs grow one screen at a time instead of demanding all
three languages before anything ships.

**It also makes a forgotten translation invisible at runtime.** A missing Hindi
key silently renders English; nothing throws, no log line appears, and the bug
reaches a user before it reaches you. That is precisely why
`tests/i18n.test.js` asserts the three catalogs have identical keys, identical
placeholders, no blanks and no untranslated copies — the fallback is a feature
for shipping and a hazard for correctness, so the hazard is moved to `npm test`.

The same file checks `LANGUAGES` against the migration's `CHECK` constraint. Two
lists of the same thing in two files is a drift waiting to happen; adding a
language to the code without the migration would otherwise fail at `UPDATE` time
in production.

### The AI is told the language for exactly one field

`buildSystemPrompt()` appends one line: `Write "description" in <language>.`

**English appends nothing**, so the default path pays zero extra prompt tokens —
which matters for the reason [the AI boundary](06-ai-boundary.md) gives: the prompt ships with every
message, forever.

`person` and `category` stay in **English letters** regardless. That is not an
oversight — it is what keeps the `UNIQUE (user_id, lower(name))` customer lookup
from [the tables](02-tables.md) working. A shopkeeper who types "Raj" today and "રાજ" tomorrow
must land in one khata, not two.

`money()` and `today()` are not localized either: `en-IN` grouping and ₹ are
right for all three languages, and `today()` feeds a SQL `::date` cast where
localization would be a bug.

### What is still English

`/help`, `sendWelcomeHelp()`, the summaries, the udhaar book, the "Sorry, I
couldn't…" errors, and the raw enum labels — a translated confirmation card
still prints `Type: credit_sale` because those are database identifiers.
Translating them needs `type.*` / `cat.*` key maps with a raw fallback, since
`category` is a free `z.string()` and the AI can return a word that is not on
the list.

---

---

← [How to add a transaction type](13-adding-a-type.md)  ·  [Index](../ARCHITECTURE.md)
