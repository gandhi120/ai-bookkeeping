import { getTransactionsByMonth } from "../database/transactions.js";
import { summarize } from "./summary.service.js";

// Creates a financial summary for one workspace over a whole month.
//
// This used to be a byte-for-byte copy of the daily summary's accumulator.
// It now imports it: the only real difference between the two was which rows
// get fetched, and duplicating the totals logic meant every new transaction
// type had to be remembered in two places.
export async function getMonthlySummary(
  userId,
  workspaceId,
  year,
  month,
  workspaceType
) {
  const transactions = await getTransactionsByMonth(
    userId,
    workspaceId,
    year,
    month
  );

  return {
    year,
    month,
    ...summarize(transactions, workspaceType),
  };
}
