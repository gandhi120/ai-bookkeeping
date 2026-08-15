import { getTransactionsByDate } from "../database/postgres.js";

// Creates a financial summary for one shopkeeper on a specific date.
// userId is required so a shopkeeper only ever sees their own numbers.
export async function getDailySummary(userId, date) {
  // Get all of this shopkeeper's transactions for that date.
  const transactions = await getTransactionsByDate(userId, date);

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
    date,
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
