import { askAI } from "../ai/groq.service.js";
import { MessageSchema } from "../schemas/transaction.schema.js";

// Turns one raw Telegram message into a validated, structured result.
//
// This function deliberately does NOT touch PostgreSQL. It only understands
// the message; saving happens later, and only after the shopkeeper taps
// Confirm. Keeping the AI logic and the SQL in separate files means either
// one can change without breaking the other.
//
// `ledgerName` is the name the user gave the ledger this message arrived in.
// It is passed to the AI as context and nothing else reads it — there are no
// per-ledger rules any more, because the ledger is whatever the user called it.
//
// `language` is passed straight through to the AI, which uses it for one
// thing only: the language "description" comes back in. Nothing here reads
// it, and no validation depends on it — a Gujarati description is still just
// a string.
//
// How many entries one message may record.
//
// A shopkeeper closing up types the day in one go, so several entries is the
// normal case, not an edge case. The cap is there for a pasted wall of text:
// past this the card stops being readable and one tap would write too much to
// check. The overflow is reported, never silently dropped.
export const MAX_ENTRIES = 10;

// Returns one of:
//   { intent: "transaction", transactions: [...], skipped: {...} }
//   { intent: "balance_query", person: "Raj" }      -> answer immediately
//   { intent: "history_query", person: "Raj" }      -> answer immediately
//   { intent: "unsupported", reason: "..." }        -> tell the user politely
export async function processMessage(
  messageText,
  telegramMessageId,
  language = "en",
  ledgerName = null
) {
  // 1. Ask the AI to understand the shopkeeper's message. Groq answers
  //    normally; Gemini takes over automatically if Groq is unavailable.
  const aiResponse = await askAI(messageText, language, ledgerName);

  // 2. Convert the JSON text into JavaScript. If it is not JSON this throws,
  //    and the caller marks the message FAILED.
  const parsed = JSON.parse(aiResponse);

  // 3. Normalize to a list. Both prompts ask for one, but a model that
  //    answers a one-entry message with a bare object must not be a failure —
  //    `[x].flat()` accepts either shape and costs nothing.
  const entries = [parsed].flat();

  // 4. A question is never mixed with entries in practice, so the first query
  //    intent in the list decides: this message is a question, answer it and
  //    record nothing.
  const query = entries.find(
    (entry) => entry?.intent === "balance_query" || entry?.intent === "history_query"
  );

  if (query) {
    // Every ledger can be asked this now. A khata belongs to the USER, not to
    // one ledger — Raj owes you, he does not owe your Kirana book — so there
    // is no ledger a balance question is out of place in.
    const validated = MessageSchema.parse(query);

    return { intent: validated.intent, person: validated.person };
  }

  // 5. Validate each entry ON ITS OWN.
  //
  //    Parsing the whole list at once would mean one unusable line throws
  //    away every good line beside it — which is how "400 nu dudh, 300 no
  //    sabu" could lose both to a single missing amount. Each entry stands or
  //    falls by itself, and what was dropped is reported back so the user is
  //    told rather than left to notice.
  const transactions = [];
  const skipped = { noAmount: 0, invalid: 0, capped: 0 };

  for (const entry of entries) {
    if (transactions.length >= MAX_ENTRIES) {
      skipped.capped++;

      continue;
    }

    const result = MessageSchema.safeParse(entry);

    if (!result.success) {
      // The prompt says "never invent an amount, use null if missing" while
      // the schema requires a positive number — so amount is the single most
      // common validation failure, and the only one worth naming to the user,
      // because "how many rupees?" is something they can answer.
      const aboutAmount = result.error.issues.some((issue) =>
        issue.path.includes("amount")
      );

      if (aboutAmount) skipped.noAmount++;
      else skipped.invalid++;

      continue;
    }

    // Strip `intent` — it was a routing hint, not part of the bookkeeping
    // record — and attach Telegram's message id so the row traces back to the
    // message. `seq` is its position among the entries this message records.
    const { intent, ...fields } = result.data;

    transactions.push({
      ...fields,
      telegram_message_id: telegramMessageId,
      seq: transactions.length,
    });
  }

  // 6. Nothing survived. Say why rather than showing an empty card — and keep
  //    the existing reasons, so the bot's replies for these cases are the ones
  //    it already had.
  if (transactions.length === 0) {
    if (skipped.noAmount > 0) {
      return { intent: "unsupported", reason: "NO_AMOUNT" };
    }

    return { intent: "unsupported", reason: "NOT_UNDERSTOOD" };
  }

  return { intent: "transaction", transactions, skipped };
}
