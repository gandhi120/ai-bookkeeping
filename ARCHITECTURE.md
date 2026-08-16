# Backend Architecture

How this system works, from the ground up: every table, every relationship, why
each one exists, and the code that uses it.

Written for someone who knows JavaScript and React Native but has not worked
much with SQL or servers. Where something is new, it is anchored to something
you already know from the frontend.

Every page has three parts:

1. **A worked example** — a real message going in, the real rows it produces,
   the real reply that comes out.
2. **The actual code**, quoted from this repo, then explained line by line.
3. **Why** — what breaks if you do it the other way.

> `CLAUDE.md` is the short version, written to orient an AI agent in ten
> seconds. This is the long version, written to teach.
> `FUTURE_FEATURES.md` is where this goes next.

---

## The map

**Start here** if you are new:

| # | Page | Answers |
|---|---|---|
| 1 | [What the product is](docs/01-what-it-is.md) | What does this thing do, and what happens when a message arrives? |
| 2 | [The five tables](docs/02-tables.md) | What is stored, column by column, and why each column exists |
| 3 | [Relationships](docs/03-relationships.md) | Foreign keys, delete rules, and what a composite UNIQUE buys you |

**The four rules that shape everything else.** If you read nothing else, read
these — every one of them exists because getting it wrong corrupts the books
silently:

| # | Page | The rule |
|---|---|---|
| 4 | [Workspace isolation](docs/04-workspace-isolation.md) | Scope by `workspace_id`, not `user_id` — and stamp it at arrival |
| 5 | [The confirmation flow](docs/05-confirmation.md) | Nothing is written without a human tap, and the write is atomic |
| 6 | [The AI as an untrusted boundary](docs/06-ai-boundary.md) | The model is instructed, never trusted |
| 7 | [The khata](docs/07-khata.md) | The balance is derived, never stored — and money in is ambiguous |

**Features, in the order they were built:**

| # | Page | Covers |
|---|---|---|
| 8 | [Onboarding](docs/08-onboarding.md) | The gate, the practice entry, the feature tour, the only DELETE in `src/` |
| 9 | [Commands and the code map](docs/09-code-map.md) | Every command, and which of the 15 source files it lives in |
| 14 | [The language layer](docs/14-languages.md) | English / Hindi / Gujarati, and why NULL means "has not chosen" |

**Working on it:**

| # | Page | Covers |
|---|---|---|
| 10 | [Migrations](docs/10-migrations.md) | Why they are files, never auto-run, and the orphan-adoption story |
| 11 | [The test layer](docs/11-testing.md) | What is covered, what is not, and the string-vs-number trap |
| 12 | [What is deliberately NOT built](docs/12-limits.md) | Every known ceiling, and what hits it first |
| 13 | [How to add a transaction type](docs/13-adding-a-type.md) | The six-layer checklist, and which omission fails silently |

---

## Reading paths

- **"I have an hour and I want to understand this."** 1 → 2 → 4 → 5. That is the
  product, the data, and the two rules that keep the books correct.
- **"I need to add a feature."** 9 (where code lives) → 13 (the checklist) →
  11 (what will catch you).
- **"I need to change the database."** 3 (delete rules) → 10 (how migrations
  work here) → 2 (the column you are about to touch).
- **"Something is wrong in production."** 5 (how a transaction is written) →
  4 (why it might be in the wrong ledger) → 7 (why a balance looks wrong).

---

## Conventions

> Code is referenced as `` `file.js` → `functionName()` ``, never by line
> number. Line numbers rot silently — they were wrong twice in a single day
> before this convention — while a name stays correct until somebody renames
> the thing, and grep finds it either way.
>
> Two directories contain a `messages.js` and an `onboarding.js`, so database
> files are written `database/messages.js` and telegram files
> `telegram/messages.js` wherever it could be ambiguous.

---

## Where to go next

- **Read next:** `src/database/` — every query in the system, seven small files,
  all commented. Start with `transactions.js`: it holds
  `confirmMessageTransaction()`, the most important function in the codebase.
- **Then:** `src/telegram/core.js` — the pieces every handler shares — followed
  by `telegram/messages.js`, which is the whole free-text path start to finish.
  `bot.js` itself is only the boot sequence now.
- **Change something small:** add a category to `HOUSEHOLD_CATEGORIES` and watch
  it appear in the prompt with no other edit.
- **Before any schema change:** read the five files in `migrations/` — they are
  the best worked examples of careful change in this repo.

Run `npm test` after everything. It is free and takes under a second.
