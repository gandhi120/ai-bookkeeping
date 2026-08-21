import { getTransactionsByDate } from "../database/transactions.js";

// Adds up a list of transactions.
//
// There used to be two of these — summarizeShop() and summarizeHousehold() —
// picked by workspace.type, plus MONEY_IN / MONEY_OUT arrays listing which
// transaction types counted where. All of that was the code re-deriving
// something the AI had already worked out: which way the money went.
//
// It now reads the answer instead of looking it up. Nothing here knows what a
// transaction "is", so a kind of money movement nobody has thought of yet is
// already handled — it is some combination of cash and udhaar.
export function summarize(transactions) {
  let moneyIn = 0;
  let moneyOut = 0;
  let onUdhaar = 0;
  const categoryTotals = new Map();

  for (const transaction of transactions) {
    const amount = Number(transaction.amount);

    if (transaction.cash === "in") {
      moneyIn += amount;
    }

    if (transaction.cash === "out") {
      moneyOut += amount;

      // Only outgoings are broken down. A breakdown that mixed salary in with
      // groceries would not answer "where did it go?".
      const category = transaction.category || "other";

      categoryTotals.set(
        category,
        (categoryTotals.get(category) ?? 0) + amount
      );
    }

    // Goods left but no cash moved. It belongs to neither total — it moves the
    // khata instead, and gets its own line so the user can see how much of the
    // month is still out there unpaid.
    if (transaction.udhaar === "they_owe_more") {
      onUdhaar += amount;
    }
  }

  return {
    moneyIn,
    moneyOut,
    // What is left over. Negative means they spent more than came in.
    net: moneyIn - moneyOut,
    onUdhaar,
    byCategory: [...categoryTotals]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total),
    transactionCount: transactions.length,
  };
}

// Creates a financial summary for one ledger on a specific date.
// Scoped by workspace so one ledger's numbers never include another's.
export async function getDailySummary(userId, workspaceId, date) {
  const transactions = await getTransactionsByDate(userId, workspaceId, date);

  return {
    date,
    ...summarize(transactions),
  };
}
