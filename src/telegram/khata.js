// Answers to customer questions — "How much does Raj owe me?" and "Show Raj's
// transactions". Read-only: these create nothing, so they never enter the
// confirmation flow.

import {
  getCustomerByName,
  getCustomerBalance,
  getCustomerTransactions,
} from "../database/customers.js";
import { translator, formatDate } from "../i18n/index.js";
import { bot, money } from "./core.js";


// --------------------------------------------------
// Customer question helpers
// --------------------------------------------------

// Answers "How much does Raj owe me?".
// Read-only: nothing is created, so this never enters the confirmation flow.
async function answerBalanceQuery(chatId, user, personName) {
  const tr = translator(user);

  const customer = await getCustomerByName(user.id, personName);

  // The shopkeeper has no such customer. Say so instead of showing ₹0,
  // which would look like a cleared balance.
  if (!customer) {
    await bot.sendMessage(chatId, tr("khata.noCustomer", { person: personName }));

    return;
  }

  const balance = await getCustomerBalance(user.id, customer.id);

  if (balance === 0) {
    await bot.sendMessage(chatId, tr("khata.cleared", { person: customer.name }));

    return;
  }

  // A negative balance means the customer paid more than they owed,
  // so the shopkeeper is holding advance money for them.
  if (balance < 0) {
    await bot.sendMessage(
      chatId,
      tr("khata.paidAdvance", {
        person: customer.name,
        amount: money(Math.abs(balance)),
      })
    );

    return;
  }

  // The sign IS the answer: positive means they owe the user, negative means
  // the user owes them. One number, both directions — which is what lets a
  // person you both lend to and borrow from be a single khata.
  await bot.sendMessage(
    chatId,
    balance < 0
      ? tr("khata.youOwe", { person: customer.name, amount: money(-balance) })
      : tr("khata.owesYou", { person: customer.name, amount: money(balance) })
  );
}


// Answers "Show Raj's transactions" with that customer's udhaar entries.
async function answerHistoryQuery(chatId, user, personName) {
  const tr = translator(user);

  const customer = await getCustomerByName(user.id, personName);

  if (!customer) {
    await bot.sendMessage(chatId, tr("khata.noCustomer", { person: personName }));

    return;
  }

  const transactions = await getCustomerTransactions(user.id, customer.id);

  if (transactions.length === 0) {
    await bot.sendMessage(chatId, tr("khata.noEntries", { person: customer.name }));

    return;
  }

  const balance = await getCustomerBalance(user.id, customer.id);

  const list = transactions
    .map((transaction) => {
      // Show the direction of each entry so the running total makes sense.
      // Read off owed_delta, the generated column — so this cannot disagree
      // with the balance printed underneath it, which is a SUM of the same
      // column. It used to re-derive the sign from transaction_type here.
      const sign = Number(transaction.owed_delta) >= 0 ? "＋" : "－";

      // No year: every row is the same khata and the year is noise.
      const date = formatDate(user.language, transaction.transaction_date, {
        year: false,
      });

      return `${sign} ${money(transaction.amount)}  ${date}
   ${transaction.description}`;
    })
    .join("\n");

  await bot.sendMessage(
    chatId,
    `${tr("khata.title", { person: customer.name })}

${list}

${tr("khata.outstanding")} ${money(balance)}`
  );
}

export {
  answerBalanceQuery,
  answerHistoryQuery,
};
