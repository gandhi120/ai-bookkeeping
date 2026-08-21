// English — the reference catalog.
//
// Every other language file in this folder must have exactly these keys and
// no others. tests/i18n.test.js asserts that, so a translation that falls
// behind fails `npm test` rather than showing up as English text in the
// middle of a Gujarati screen.
//
// Placeholders are {name} and are filled by t() in ./index.js.
//
// Every user-facing string in the bot lives here. The one exception is the
// language picker itself, which is sent before the language is known and so
// carries all three at once — see askToChooseLanguage in bot.js.

export default {
  // --------------------------------------------------
  // Language
  // --------------------------------------------------

  // Sent AFTER the language is changed, so it is deliberately written in the
  // language just chosen — the message itself is the proof it worked.
  "language.changed": "✅ Language set to English.",

  // The row on /workspace that reopens the picker.
  "language.button": "🌐 Language: {label}",

  // --------------------------------------------------
  // Choosing a ledger
  // --------------------------------------------------

  // first_name is optional on a Telegram account, so there are two greetings
  // rather than one that can render "Hi undefined".
  "setup.greeting": "Hi {name}!",
  "setup.greetingAnon": "Hello!",

  // The options are named by what the user gets, never by the word
  // "workspace", which no shopkeeper thinks in.
  "setup.welcome": `👋 {greeting} I'm your bookkeeping assistant.

Just type what happened — like "Bought 10 kg rice for ₹600" — and I'll
write it in your books. No forms, no Excel.

First, what should I keep books for?

You can add the other one later, so this is not final.`,

  "setup.shopButton": "🏪 My Shop — sales, purchases, udhaar",
  "setup.homeButton": "🏠 My Home — household spending",

  // The name a new ledger is created with, and therefore the name shown on
  // every screen afterwards. Translated at creation so a Gujarati user's shop
  // is not called "My Shop" in English forever — the name is stored, so this
  // only affects ledgers created from now on.
  "workspace.nameShop": "My Shop",
  "workspace.nameHome": "My Home",

  "workspace.switched": "Switched to {workspace}",
  "workspace.nowUsing": "✅ Now using {workspace}",
  "workspace.ready": "{workspace} is ready.",

  // --------------------------------------------------
  // The practice transaction
  // --------------------------------------------------

  "practice.prompt": `Let's try it once — takes 30 seconds.

Type this, or your own version:

{example}`,

  // The most ordinary entry each ledger will ever see, so the example is one
  // the user will actually repeat tomorrow.
  "practice.skip": "⏭ Skip setup",

  // --------------------------------------------------
  // The feature tour
  // --------------------------------------------------

  "tour.intro": `🎉 That's the whole app — type it, tap Confirm.

Want to see what else I can do?`,

  "tour.more": "What else?",

  "tour.summary": "📊 Today's summary",
  "tour.monthly": "📅 This month",
  "tour.transactions": "📋 Today's entries",
  "tour.udhaar": "📒 Who owes me",

  "tour.finish": "✅ Finish setup",

  // --------------------------------------------------
  // Finishing: clear or keep
  // --------------------------------------------------

  // The count is the safety rail. Everything typed while onboarding is open
  // counts as practice, so somebody who ignored the finish button for a week
  // would be clearing real work — the number is what makes that visible
  // before the tap.
  //
  // Written as "Practice entries: 3" rather than "3 practice entries" so no
  // plural rule is needed: Hindi and Gujarati do not pluralise like English,
  // and a number standing alone reads naturally in all three.
  "clear.prompt": `Almost done.

Practice entries in your books: {count}

Clear them so your real accounts start from zero?`,

  "clear.button": "🧹 Clear practice data",
  "keep.button": "📌 Keep it",

  "finish.done": "✅ All set.",
  "finish.cleared": "✅ All set. Practice entries cleared: {count}",
  "finish.kept": "✅ All set. Your practice entries are kept.",

  "toast.setupAlreadyDone": "Setup is already done.",
  "toast.cleared": "Practice data cleared.",
  "toast.setupComplete": "Setup complete.",

  // --------------------------------------------------
  // The confirmation card
  // --------------------------------------------------

  // Three rows, not six. The transaction TYPE is the first row's label
  // ("Expense: groceries"), which is what collapsed the old "Type: expense"
  // and "Description: groceries" into one line — they were saying the same
  // thing twice, once in English and once in the user's language.
  //
  // Category is not shown: it cannot be corrected from here and it duplicated
  // the description. Quantity is shown only when it is more than 1.
  "confirm.title": "📝 Shall I write this?",

  "confirm.quantity": "Quantity:",
  "confirm.amount": "Amount:",
  "confirm.date": "Date:",
  "confirm.description": "Description:",
  "confirm.from": "From:",

  // One line instead of the old "Currently owes:" / "After this entry:" pair.
  "confirm.khataChange": "{person}'s balance: {before} → {after}",

  "confirm.yes": "✅ Yes",
  "confirm.no": "❌ No",

  "confirm.savedTitle": "✅ Written in your books",

  // Several entries in one message. The count is in the title so the user can
  // see at a glance whether the bot found everything they typed, and the
  // total is there because one tap writes all of them.
  "confirm.titleMulti": "📝 Shall I write these {count}?",
  "confirm.savedTitleMulti": "✅ Written in your books ({count})",
  "confirm.total": "Total:",
  "toast.savedMulti": "{count} entries written!",

  // What was left out, and why. Never silent: a user who typed five things
  // and got four must be told which one is missing, not left to find out at
  // the end of the month.
  "skipped.noAmount":
    "⚠️ Left out {count} — I couldn't see the amount. Send those again with the rupees.",
  "skipped.invalid": "⚠️ Left out {count} I couldn't follow.",
  "skipped.capped":
    "⚠️ {max} at a time is my limit — send the remaining {count} separately.",

  "error.noAmount":
    "How many rupees? Send it again with the amount, like \"500 for groceries\".",
  "confirm.cancelled": "❌ Cancelled, nothing was written.",

  "toast.saved": "Transaction saved!",
  "toast.cancelled": "Transaction cancelled.",

  // A repayment can overshoot the debt. "owes ₹-4,000" reads as nonsense to a
  // shopkeeper, so a negative balance is phrased as advance money held.
  "khata.nowOwes": "📒 {person} now owes {amount}",
  "khata.advance": "📒 {person} has paid {amount} in advance",

  // --------------------------------------------------
  // "Was this money a repayment?" — shop only
  // --------------------------------------------------

  "clarify.owes": "{person} currently owes: {amount}",
  "clarify.noUdhaar": "{person} has no udhaar recorded yet.",
  "clarify.question":
    "❓ Did {person} pay this toward their udhaar, or is this a normal payment?",
  "clarify.repayment": "📒 Udhaar Repayment",
  "clarify.normal": "💰 Normal Payment",

  // --------------------------------------------------
  // Transaction types — read through enumLabel(lang, "type", value)
  // --------------------------------------------------
  //
  // These are the words the user sees in place of the database identifiers
  // `credit_sale`, `payment_received` and so on. They double as the label of
  // the confirmation card's first row, so each one has to read naturally
  // followed by a colon and a thing: "Purchase: 10 kg rice".

  "type.sale": "Sale",
  "type.purchase": "Purchase",
  "type.expense": "Expense",
  "type.income": "Income",
  "type.payment_received": "Money in",
  "type.payment_sent": "Money out",
  "type.credit_sale": "Udhaar",
  "type.repayment": "Udhaar repaid",
  "type.other": "Other",

  // --------------------------------------------------
  // Household categories — enumLabel(lang, "cat", value)
  // --------------------------------------------------
  //
  // Only shown in the /monthly breakdown. An unknown category falls back to
  // whatever the AI returned, so this list does not have to be exhaustive.

  "cat.groceries": "Groceries",
  "cat.food": "Food",
  "cat.electricity": "Electricity",
  "cat.water": "Water",
  "cat.gas": "Gas",
  "cat.rent": "Rent",
  "cat.transport": "Transport",
  "cat.education": "Education",
  "cat.medical": "Medical",
  "cat.shopping": "Shopping",
  "cat.entertainment": "Entertainment",
  "cat.subscriptions": "Subscriptions",
  "cat.salary": "Salary",
  "cat.stock": "Stock",
  "cat.other": "Other",

  // --------------------------------------------------
  // Summary — /summary and /monthly share these labels
  // --------------------------------------------------

  "summary.dailyTitle": "📊 {workspace} — Today",
  "summary.monthlyTitle": "📊 {workspace} — This Month",
  "summary.date": "Date:",
  "summary.count": "Entries:",

  "summary.whereItWent": "Where it went:",

  // --------------------------------------------------
  // /transactions
  // --------------------------------------------------

  "list.title": "📋 {workspace} — Today's Entries",
  "list.empty": "📋 Nothing recorded on {date} in {workspace}.",
  "list.customer": "Customer:",

  // --------------------------------------------------
  // The khata — /udhaar and customer questions
  // --------------------------------------------------

  "udhaar.title": "📒 Udhaar Book",
  "udhaar.total": "Total pending:",
  "udhaar.empty": `📒 Nobody owes you anything right now.

When you write something like "Raj took goods for ₹2,000 on udhaar", Raj shows up here until he pays it back.`,

  "khata.noCustomer": '🔍 No customer named "{person}" in your khata yet.',
  "khata.cleared": "✅ {person} has cleared everything. Nothing pending.",
  "khata.paidAdvance": "💰 {person} has paid {amount} in advance. Nothing pending.",
  "khata.owesYou": "📒 {person} owes you {amount}.",
  "khata.title": "📋 Khata — {person}",
  "khata.noEntries": "📋 No entries yet for {person}.",
  "khata.outstanding": "Pending:",

  // --------------------------------------------------
  // Workspaces
  // --------------------------------------------------

  "ws.current": "Which books?",
  // --------------------------------------------------
  // Help — one screen, branched by ledger
  // --------------------------------------------------
  //
  // /help and the post-setup welcome are the same screen: /help used to show
  // shop commands to household users and patch it with a footnote. Branching
  // is both shorter and correct.
  //
  // Slash command NAMES stay ASCII — Telegram requires it — so only the
  // description beside each one is translated.

  // --------------------------------------------------
  // Toasts and errors
  // --------------------------------------------------

  "toast.notFound": "Couldn't find that entry.",
  // Deliberately does not name the status. The user cannot act on the
  // difference between "confirmed" and "answered", and the raw enum was
  // leaking into the message.
  "toast.alreadyDone": "That one is already done.",
  "toast.dataMissing": "That entry's details are missing.",
  "toast.chooseFirst": "Please choose what this payment was for.",
  "toast.unknownAction": "I didn't understand that button.",
  "toast.wentWrong": "Something went wrong.",
  "toast.unknownWorkspace": "Unknown ledger.",
  "toast.workspaceNotFound": "Ledger not found.",
  "toast.unknownLanguage": "Unknown language.",

  "error.summary": "Sorry, I couldn't put today's summary together.",
  "error.monthly": "Sorry, I couldn't put this month's summary together.",
  "error.transactions": "Sorry, I couldn't get today's entries.",
  "error.udhaar": "Sorry, I couldn't open the udhaar book.",
  "error.workspaces": "Sorry, I couldn't load your ledgers.",
  "error.language": "Sorry, I couldn't open the language settings.",
  "error.transaction": "Sorry, I couldn't understand that one.",

  "error.rateLimit":
    "That's a lot at once — give me a minute to catch up, then carry on.",

  // --------------------------------------------------
  // The menu
  // --------------------------------------------------

  // The active ledger's name is in the BUTTON, not only in this text — the
  // buttons are the interface for everyone who never learns a slash command.
  "help.menu":
    "📒 You're in {workspace}\n\nJust tell me what happened and I'll write it down.\n\"Sold 3 shirts for 1200\"\n\"Raju took 500 of goods on udhaar\"\n\nCommands: /menu /summary /monthly /transactions /udhaar /workspace /language",

  "menu.thisLedger": "📊 This month — {workspace}",
  "menu.allLedgers": "🌍 This month — all ledgers",
  "menu.switch": "🔀 Switch ledger",
  "menu.newLedger": "➕ New ledger",
  "menu.allTitle": "🌍 All ledgers",
  "menu.everything": "Everything:",
  "menu.allEmpty": "Nothing recorded in any ledger this month yet.",

  // --------------------------------------------------
  // Making a ledger
  // --------------------------------------------------

  // Shows examples rather than describing the format: "send an emoji followed
  // by a name" is a spec, and three lines someone can copy is an instruction.
  "ledger.prompt":
    "➕ New ledger\n\nSend an emoji and a name together:\n\n🏍️ Bike\n🌾 Farm\n🏪 Second Shop\n\nJust a name works too — I'll use 📒.",
  "ledger.created": "✅ {workspace} is ready, and you're in it now.",
  "ledger.needName": "That's just an emoji — send a name with it, like 🏍️ Bike.",
  "ledger.duplicate":
    "You already have {ledger}. Pick another name, or switch to it from /menu.",
  "ledger.tooMany":
    "You have {max} ledgers, which is as many as I can keep straight. Reuse one instead.",

  // --------------------------------------------------
  // Direction
  // --------------------------------------------------

  // Printed on every confirmation card. This is the row that lets the user
  // catch the AI putting money on the wrong side before it reaches a total.
  "card.moneyIn": "Money in",
  "card.moneyOut": "Money out",

  "summary.moneyIn": "In:",
  "summary.moneyOut": "Out:",
  "summary.net": "Net:",
  "summary.onUdhaar": "On udhaar:",

  "khata.youOwe": "📒 You owe {person} {amount}.",

  // --------------------------------------------------
  // Setup
  // --------------------------------------------------

  "setup.ownButton": "✏️ Make my own",
  "ws.hint": "Everything you type now goes into this ledger.",
  "practice.example": "Bought 10kg rice for 600",
};
