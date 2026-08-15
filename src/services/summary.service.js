import { getTransactionsByDate } from "../database/postgres.js";

// Adds up a list of transactions.
//
// This lives here rather than in each caller because the daily and monthly
// summaries used to be byte-identical copies of the same loop — so every new
// transaction type had to be added twice, and eventually would not be.
// getMonthlySummary imports this function instead of repeating it.
//
// The shape returned depends on the ledger: a shop reports sales against
// purchases, a household reports income against expenses. They share nothing
// but the word "expense", so branching here is cheaper than pretending one
// set of totals fits both.
export function summarize(transactions, workspaceType) {
  return workspaceType === "household"
    ? summarizeHousehold(transactions)
    : summarizeShop(transactions);
}

// The shopkeeper ledger. Unchanged from before workspaces existed.
function summarizeShop(transactions) {
  let totalSales = 0;
  let totalPurchases = 0;
  let totalExpenses = 0;
  let creditSales = 0;
  let repaymentsReceived = 0;

  // Go through every transaction and calculate totals.
  for (const transaction of transactions) {
    const amount = Number(transaction.amount);

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

    if (transaction.transaction_type === "purchase") {
      totalPurchases += amount;
    }

    if (transaction.transaction_type === "expense") {
      totalExpenses += amount;
    }
  }

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
}

// The household ledger: money in, money out, and where the money went.
//
// `byCategory` is built from whatever the rows actually contain rather than
// from the known category list, so a category added to the prompt later shows
// up here with no change to this file. Sorted biggest first — that is the
// order the dashboard reads them in.
function summarizeHousehold(transactions) {
  let totalIncome = 0;
  let totalExpenses = 0;
  const categoryTotals = new Map();

  for (const transaction of transactions) {
    const amount = Number(transaction.amount);

    if (transaction.transaction_type === "income") {
      totalIncome += amount;
    }

    if (transaction.transaction_type === "expense") {
      totalExpenses += amount;

      // Only expenses are broken down. A category breakdown that mixed
      // salary in with groceries would not answer "where did it go?".
      const category = transaction.category || "other";

      categoryTotals.set(
        category,
        (categoryTotals.get(category) ?? 0) + amount
      );
    }
  }

  return {
    totalIncome,
    totalExpenses,
    // What is left over. Negative means they spent more than they earned.
    balance: totalIncome - totalExpenses,
    byCategory: [...categoryTotals]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total),
    transactionCount: transactions.length,
  };
}

// Creates a financial summary for one workspace on a specific date.
// Scoped by workspace so the shop's numbers never include the home's.
export async function getDailySummary(userId, workspaceId, date, workspaceType) {
  const transactions = await getTransactionsByDate(userId, workspaceId, date);

  return {
    date,
    ...summarize(transactions, workspaceType),
  };
}
