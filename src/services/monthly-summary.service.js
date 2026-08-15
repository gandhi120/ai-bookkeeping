import { getTransactionsByMonth } from "../database/postgres.js";

// Creates a financial summary for one shopkeeper for a specific month.
// userId is required so a shopkeeper only ever sees their own numbers.
export async function getMonthlySummary(userId, year, month) {
  const transactions = await getTransactionsByMonth(userId, year, month);

  let totalSales = 0;
  let totalPurchases = 0;
  let totalExpenses = 0;
  let creditSales = 0;
  let repaymentsReceived = 0;

  for (const transaction of transactions) {
    const amount = Number(transaction.amount);

    if (transaction.transaction_type === "sale") {
      totalSales += amount;
    }

    // A credit sale IS revenue: the goods left the shop, so it counts
    // towards sales immediately even though no cash arrived yet.
    if (transaction.transaction_type === "credit_sale") {
      totalSales += amount;
      creditSales += amount;
    }

    // A repayment is NOT revenue. That sale was already counted when the
    // udhaar was given; counting it again would double-count the sale.
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
    year,
    month,
    totalSales,
    totalPurchases,
    totalExpenses,
    // How much of this month's sales was on udhaar (billed, not yet paid).
    creditSales,
    // Cash collected this month against older udhaar.
    repaymentsReceived,
    netBalance: totalSales - totalPurchases - totalExpenses,
    transactionCount: transactions.length,
  };
}
