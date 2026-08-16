// Rendering. Builds the message bodies the handlers send, and owns the two
// confirmation cards.
//
// askToConfirm() is the single entry point for "show this and wait for a tap":
// it picks the payment-clarification card when the AI could not tell what a
// payment meant, and the ordinary confirm card otherwise.

import { MAX_ENTRIES } from "../services/transaction.service.js";
import { isCustomerTransaction } from "../schemas/transaction.schema.js";
import { getCustomerByName, getCustomerBalance } from "../database/customers.js";
import {
  DEFAULT_LANGUAGE,
  t,
  translator,
  enumLabel,
  formatDate,
} from "../i18n/index.js";
import {
  bot,
  money,
  needsPaymentClarification,
} from "./core.js";


// The body of the confirmation card, and of the "saved" card after Confirm.
// Both show the same three rows so tapping Confirm does not reshuffle what
// the user is looking at.
//
//     ખરીદી: 10 કિલો ચોખા
//     રકમ: ₹600
//     તારીખ: 16 ઑગસ્ટ 2026
//
// The transaction TYPE is the first row's LABEL rather than a value. That is
// what collapsed the old six rows into three: "Type: expense" and
// "Description: groceries" were saying the same thing twice, once as a raw
// database identifier and once in the user's language.
//
// Category is deliberately absent. It cannot be corrected from this card, it
// only feeds the /monthly breakdown, and it was the row duplicating the
// description.
function transactionCard(user, transaction) {
  const tr = translator(user);
  const language = user?.language ?? "en";

  // For a khata entry the customer IS what the shopkeeper is confirming;
  // for everything else it is the thing bought or sold.
  const what = isCustomerTransaction(transaction.transaction_type)
    ? transaction.person
    : transaction.description;

  const rows = [
    `${enumLabel(language, "type", transaction.transaction_type)}: ${what}`,
  ];

  // A quantity of 1 is every ordinary entry, so printing it said nothing and
  // read as a second amount sitting above the real one.
  if (Number(transaction.quantity) > 1) {
    rows.push(`${tr("confirm.quantity")} ${transaction.quantity}`);
  }

  rows.push(`${tr("confirm.amount")} ${money(transaction.amount)}`);

  if (transaction.transaction_date) {
    rows.push(
      `${tr("confirm.date")} ${formatDate(language, transaction.transaction_date)}`
    );
  }

  return rows.join("\n");
}


// The body of the card when ONE message recorded several entries.
//
// One line each rather than N stacked cards, because the entries were typed
// as one thought ("400 nu dudh, 300 no sabu") and are confirmed as one. The
// total is what makes a single tap safe to give: it is the number the user
// checks before agreeing to all of them.
function transactionListCard(user, transactions) {
  const tr = translator(user);
  const language = user?.language ?? DEFAULT_LANGUAGE;

  const dates = new Set(transactions.map((t) => t.transaction_date));

  // Normally every entry in a message is the same day, so the date is stated
  // once at the bottom. It only moves onto each line when they genuinely
  // differ — a shared date line would be a quiet lie about half the rows.
  const sameDay = dates.size === 1;

  const lines = transactions.map((transaction) => {
    const what = isCustomerTransaction(transaction.transaction_type)
      ? transaction.person
      : transaction.description;

    const when = sameDay
      ? ""
      : `  ${formatDate(language, transaction.transaction_date, { year: false })}`;

    return `${enumLabel(language, "type", transaction.transaction_type)}: ${what} — ${money(
      transaction.amount
    )}${when}`;
  });

  const total = transactions.reduce(
    (sum, transaction) => sum + Number(transaction.amount),
    0
  );

  const footer = [`${tr("confirm.total")} ${money(total)}`];

  if (sameDay) {
    footer.push(
      `${tr("confirm.date")} ${formatDate(language, transactions[0].transaction_date)}`
    );
  }

  return `${lines.join("\n")}\n───────────────\n${footer.join("\n")}`;
}


// What the message could not record, and why — appended under the card.
//
// Never silent. Somebody who types five things and gets four back must be
// told which one is missing now, not discover it in next month's summary.
function skippedNotes(user, skipped) {
  const tr = translator(user);

  return Object.entries(skipped ?? {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) =>
      tr(`skipped.${reason}`, { count, max: MAX_ENTRIES })
    )
    .join("\n");
}


// The money rows shared by /summary and /monthly.
//
// A household reports income against expenses and where the money went; a
// shop reports sales against purchases. Different questions, so this is two
// layouts rather than one with some rows blanked out.
//
// `categories` is off for the daily view: a single day's spending broken down
// by category is usually one line repeating what is already on screen.
function summaryBody(user, workspace, summary, { categories = false } = {}) {
  const tr = translator(user);

  if (workspace.type !== "household") {
    return `${tr("summary.sales")} ${money(summary.totalSales)}
${tr("summary.purchases")} ${money(summary.totalPurchases)}
${tr("summary.expenses")} ${money(summary.totalExpenses)}
${tr("summary.netBalance")} ${money(summary.netBalance)}`;
  }

  const rows = `${tr("summary.income")} ${money(summary.totalIncome)}
${tr("summary.expenses")} ${money(summary.totalExpenses)}
${tr("summary.balance")} ${money(summary.balance)}`;

  if (!categories || summary.byCategory.length === 0) return rows;

  // byCategory carries the raw database strings, and `category` is a free
  // z.string() — so enumLabel falls back to whatever the AI wrote rather than
  // printing a missing key.
  const breakdown = summary.byCategory
    .map(
      (row) =>
        `${enumLabel(user.language, "cat", row.category)} — ${money(row.total)}`
    )
    .join("\n");

  return `${rows}\n\n${tr("summary.whereItWent")}\n${breakdown}`;
}


// Asks the shopkeeper what an ambiguous payment was actually for.
//
// Nothing is written here. The message is already saved as
// PENDING_CONFIRMATION with its transaction data, so the answer can arrive
// after a restart — the buttons carry only the Telegram message id, and
// everything else is looked up again in PostgreSQL.
//
// The customer's current outstanding is shown because that is the number
// the shopkeeper needs in order to answer correctly.
// `index` names WHICH entry is being asked about when one message recorded
// several. null for a single-entry message, which keeps that callback data
// byte-identical to what it has always been — and keeps its one-tap
// confirm-and-save behaviour, see the callback handler.
async function askPaymentClarification(
  chatId,
  user,
  transaction,
  telegramMessageId,
  index = null
) {
  const tr = translator(user);

  const suffix = index === null ? "" : `:${index}`;

  const customer = await getCustomerByName(user.id, transaction.person);

  // A customer with no khata yet still gets the question: the shopkeeper may
  // have given the udhaar verbally before ever recording it here.
  const khataLine = customer
    ? tr("clarify.owes", {
        person: transaction.person,
        amount: money(await getCustomerBalance(user.id, customer.id)),
      })
    : tr("clarify.noUdhaar", { person: transaction.person });

  await bot.sendMessage(
    chatId,
    `${tr("confirm.title")}

${tr("confirm.amount")} ${money(transaction.amount)}
${tr("confirm.from")} ${transaction.person}
${tr("confirm.description")} ${transaction.description}
${tr("confirm.date")} ${formatDate(
      user?.language ?? DEFAULT_LANGUAGE,
      transaction.transaction_date
    )}

${khataLine}

${tr("clarify.question", { person: transaction.person })}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tr("clarify.repayment"),
              callback_data: `repayment:${telegramMessageId}${suffix}`,
            },
            {
              text: tr("clarify.normal"),
              callback_data: `income:${telegramMessageId}${suffix}`,
            },
          ],
          [
            {
              text: tr("confirm.no"),
              callback_data: `cancel:${telegramMessageId}`,
            },
          ],
        ],
      },
    }
  );
}


// The step between "the AI understood you" and "waiting for a yes".
//
// It either asks the next unanswered clarification question or shows the
// confirm card. Both the message handler and the clarification callback call
// it, which is what lets a multi-entry message ask about entry 2 after entry
// 0 has been answered without either side owning the state machine.
async function askToConfirm(
  chatId,
  user,
  transactions,
  skipped,
  telegramMessageId
) {
  const tr = translator(user);

  // Money from a named person with no stated reason moves a khata balance if
  // guessed wrong, so it is asked about before anything can be saved.
  const unanswered = transactions.findIndex(needsPaymentClarification);

  if (unanswered !== -1) {
    await askPaymentClarification(
      chatId,
      user,
      transactions[unanswered],
      telegramMessageId,
      // A single-entry message needs no index: its callback data, and its
      // one-tap behaviour, stay exactly as they were.
      transactions.length > 1 ? unanswered : null
    );

    return;
  }

  const multi = transactions.length > 1;

  // For udhaar entries, show what the customer owes right now so the
  // shopkeeper sees the before/after before committing to it.
  const khataLines = [];

  for (const transaction of transactions) {
    if (
      !isCustomerTransaction(transaction.transaction_type) ||
      !transaction.person
    ) {
      continue;
    }

    const customer = await getCustomerByName(user.id, transaction.person);
    const current = customer ? await getCustomerBalance(user.id, customer.id) : 0;

    const after =
      transaction.transaction_type === "credit_sale"
        ? current + Number(transaction.amount)
        : current - Number(transaction.amount);

    khataLines.push(
      tr("confirm.khataChange", {
        person: transaction.person,
        before: money(current),
        after: money(after),
      })
    );
  }

  const parts = [
    multi
      ? tr("confirm.titleMulti", { count: transactions.length })
      : tr("confirm.title"),
    "",
    multi
      ? transactionListCard(user, transactions)
      : transactionCard(user, transactions[0]),
  ];

  if (khataLines.length > 0) parts.push("", khataLines.join("\n"));

  const notes = skippedNotes(user, skipped);

  if (notes) parts.push("", notes);

  await bot.sendMessage(chatId, parts.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: tr("confirm.yes"),
            callback_data: `confirm:${telegramMessageId}`,
          },
          {
            text: tr("confirm.no"),
            callback_data: `cancel:${telegramMessageId}`,
          },
        ],
      ],
    },
  });
}

export {
  transactionCard,
  transactionListCard,
  summaryBody,
  askToConfirm,
};
