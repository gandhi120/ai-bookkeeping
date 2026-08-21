import {
  getTransactionsByMonth,
  getTransactionsByMonthAllWorkspaces,
} from "../database/transactions.js";
import { summarize } from "./summary.service.js";

// This month, in ONE ledger.
export async function getMonthlySummary(userId, workspaceId, year, month) {
  const transactions = await getTransactionsByMonth(
    userId,
    workspaceId,
    year,
    month
  );

  return {
    year,
    month,
    ...summarize(transactions),
  };
}

// This month, across EVERY ledger the user keeps.
//
// The one view that is meant to cross ledgers, so it is scoped by user_id
// alone — the join to workspaces in the query is what keeps it inside the
// user regardless.
//
// ponytail: the rows are fetched once and totalled in JS rather than with a
// SQL GROUP BY, so there is exactly ONE implementation of "what do these
// transactions add up to" — the summarize() above, which the daily and
// single-ledger monthly views already use and the tests already cover. Move
// the totals into SQL if a user ever crosses ~5k rows in a month.
export async function getMonthlySummaryAll(userId, year, month) {
  const rows = await getTransactionsByMonthAllWorkspaces(userId, year, month);

  const byWorkspace = new Map();

  for (const row of rows) {
    if (!byWorkspace.has(row.ws_id)) {
      byWorkspace.set(row.ws_id, {
        emoji: row.ws_emoji,
        name: row.ws_name,
        rows: [],
      });
    }

    byWorkspace.get(row.ws_id).rows.push(row);
  }

  return {
    year,
    month,
    // A ledger with nothing in it this month is absent, not a wall of zeroes.
    // The query orders by w.created_at, so what is here is in switcher order.
    ledgers: [...byWorkspace.values()].map((ledger) => ({
      emoji: ledger.emoji,
      name: ledger.name,
      ...summarize(ledger.rows),
    })),
    // summarize() over EVERYTHING, not a sum of the per-ledger nets — so it
    // stays right for a type that counts in neither column.
    total: summarize(rows),
  };
}
