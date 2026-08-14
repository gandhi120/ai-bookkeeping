import { getTransactionsByMonth } from "../database/postgres.js";

// Creates a financial summary for a specific month.
export async function getMonthlySummary(year, month) {
  const transactions = await getTransactionsByMonth(year, month);

  let totalSales = 0;
  let totalPurchases = 0;
  let totalExpenses = 0;

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
    year,
    month,
    totalSales,
    totalPurchases,
    totalExpenses,
    netBalance: totalSales - totalPurchases - totalExpenses,
    transactionCount: transactions.length,
  };
}