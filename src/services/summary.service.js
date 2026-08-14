import { getTransactionsByDate } from "../database/postgres.js";

// Creates a financial summary for a specific date.
export async function getDailySummary(date) {
  // Get all transactions for that date.
  const transactions = await getTransactionsByDate(date);

  let totalSales = 0;
  let totalPurchases = 0;
  let totalExpenses = 0;

  // Go through every transaction and calculate totals.
  for (const transaction of transactions) {
    const amount = Number(transaction.amount);

    if (transaction.transaction_type === "sale") {
      totalSales += amount;
    }

    if (transaction.transaction_type === "purchase") {
      totalPurchases += amount;
    }

    if (transaction.transaction_type === "expense") {
      totalExpenses += amount;
    }
  }

 return {
  date,
  totalSales,
  totalPurchases,
  totalExpenses,
  netBalance: totalSales - totalPurchases - totalExpenses,
  transactionCount: transactions.length,
};
}