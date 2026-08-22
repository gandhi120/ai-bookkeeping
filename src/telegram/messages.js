// The free-text path: every message that is not a slash command.
//
// The flood guard sits at the top because the budget it protects is the AI
// call below it, not the database.

import { processMessage } from "../services/transaction.service.js";
import { setPendingAction } from "../database/users.js";
import {
  createMessage,
  updateMessageStatus,
  updateMessageTransactionData,
  getMessageByTelegramMessageId,
} from "../database/messages.js";
import { DEFAULT_LANGUAGE, translator } from "../i18n/index.js";
import {
  bot,
  resolveShopkeeper,
  workspaceLabel,
  startSetup,
  isOnboarding,
  sendPracticePrompt,
  money,
  sendError,
} from "./core.js";
import { askToConfirm } from "./cards.js";
import { answerBalanceQuery, answerHistoryQuery } from "./khata.js";
import { createLedgerFromText } from "./onboarding.js";


// Why nothing in a message could be recorded, and what to say about it.
//
// A table rather than a ternary chain because processMessage grew a fourth
// reason the moment one message could hold several entries, and a chain is
// where the fifth one gets missed. `?? "error.transaction"` is the fallback,
// so an unmapped reason apologises rather than printing a key.
const UNSUPPORTED_KEY = {
  NO_AMOUNT: "error.noAmount",
  NOT_UNDERSTOOD: "error.transaction",
};


// --------------------------------------------------
// Normal transaction messages
// --------------------------------------------------

// --------------------------------------------------
// Flood guard
// --------------------------------------------------

// The AI budget is shared across every user and resets daily, so one person
// pasting a hundred lines does not cost them anything — it takes the whole
// shop down until tomorrow. This limit protects the other users, which is why
// it sits in front of the AI call rather than in front of the database.
const RATE_LIMIT = 20;

const RATE_WINDOW_MS = 60_000;


const rateCounters = new Map();


// Returns 0 while the sender is within the limit, otherwise how many messages
// past it this one is. The caller replies only on 1 — the message that crosses
// — so a flood earns one warning instead of a hundred. `now` is a parameter so
// the window can be tested without waiting a real minute.
export function overRateLimit(telegramUserId, now = Date.now()) {
  const entry = rateCounters.get(telegramUserId);

  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    // ponytail: unbounded Map, one entry per user ever seen. Dropped wholesale
    // past 10k — the worst case is that 10k people get a fresh window at the
    // same moment. Swap for a TTL cache if that ever churns for real.
    if (rateCounters.size > 10_000) {
      rateCounters.clear();
    }

    rateCounters.set(telegramUserId, { start: now, count: 1 });

    return 0;
  }

  entry.count += 1;

  return entry.count > RATE_LIMIT ? entry.count - RATE_LIMIT : 0;
}


bot.on("message", async (message) => {
  // Stickers, photos, voice notes and locations have no `text` at all. Without
  // this they fall straight past the command check below (`undefined?.` is
  // undefined, not true) and reach createMessage with a NULL message_text,
  // which the column rejects. A 👋 sticker is a very common first contact.
  if (!message.text) {
    return;
  }

  // A reply to one of the bot's OWN messages is an answer to a question it
  // asked, not free text to book. Without this, replying "82.5" to a prompt
  // would be read here as a transaction as well as by whoever asked.
  //
  // Checked by sender rather than by content: this file must not know what
  // any other feature's prompts look like.
  if (message.reply_to_message?.from?.is_bot) {
    return;
  }

  // Ignore Telegram commands.
  if (message.text.startsWith("/")) {
    return;
  }

  // Below the commands on purpose: only free text reaches the AI, and the AI
  // is the budget being protected. Commands are pure database reads.
  const over = overRateLimit(message.from.id);

  if (over) {
    if (over === 1) {
      // Only the message that CROSSES the limit gets a reply, so this costs
      // one query per flood, not one per message — cheap enough to answer a
      // flooding user in their own language rather than in English.
      const { user } = await resolveShopkeeper(message.from, message.chat);

      await bot.sendMessage(message.chat.id, translator(user)("error.rateLimit"));
    }

    return;
  }

  // Declared OUTSIDE the try block on purpose. `const` inside try{} is
  // block scoped and would be invisible to catch{}, so the FAILED status
  // could never be written.
  let savedMessage;

  // Set only while the sender is still onboarding, for the same scoping
  // reason: the catch below needs them to answer a beginner differently, in
  // their own language. Both are assigned together and neither is read unless
  // the other is set.
  let onboardingUser;
  let onboardingWorkspace;

  // Same reason again: the catch apologises, and it cannot reach `user`.
  let language = DEFAULT_LANGUAGE;

  try {
    // Find or create the shopkeeper from Telegram information.
    const { user, workspace } = await resolveShopkeeper(
      message.from,
      message.chat
    );

    language = user.language ?? DEFAULT_LANGUAGE;

    // Without a workspace there is no ledger to write to. Ask before
    // spending an AI call on a message that has nowhere to go.
    if (!user.language || !workspace) {
      await startSetup(message.chat.id, user, workspace);

      return;
    }

    const tr = translator(user);

    // The bot asked a question and this is the answer, not a transaction.
    //
    // Checked BEFORE the AI call, in the same place the setup gate sits, so
    // naming a ledger costs nothing. Cleared FIRST, whatever happens next: if
    // createLedgerFromText throws, the user's next message is an ordinary
    // message rather than a second attempt at a question they cannot escape.
    if (user.pending_action === "new_ledger") {
      await setPendingAction(user.id, null);
      await createLedgerFromText(message.chat.id, user, message.text);

      return;
    }

    if (isOnboarding(user)) {
      onboardingUser = user;
      onboardingWorkspace = workspace;
    }

    // Save every incoming Telegram message permanently.
    savedMessage = await createMessage({
      user_id: user.id,
      workspace_id: workspace.id,
      telegram_message_id: message.message_id,
      message_text: message.text,
      status: "RECEIVED",
      // Stamped at arrival, not read back later: this is what marks the row
      // as practice data, and it is the key the cleanup deletes by.
      is_onboarding: isOnboarding(user),
    });

    // createMessage uses ON CONFLICT DO NOTHING, so a redelivered Telegram
    // message returns no row. Fetch the original instead of crashing.
    if (!savedMessage) {
      savedMessage = await getMessageByTelegramMessageId(
        user.id,
        message.message_id
      );
    }

    // Mark the message as currently being processed by AI.
    await updateMessageStatus(
      savedMessage.id,
      "PROCESSING"
    );

    // Ask the AI what this message means and validate the answer with Zod.
    // The language decides which language it writes back in; the ledger's name
    // rides along as context, so "petrol" lands sensibly in a ledger called
    // Bike. Neither is a rule the answer is checked against.
    const result = await processMessage(
      message.text,
      message.message_id,
      user.language,
      workspace.name
    );

    // The message did not carry anything recordable — no amount, or nothing
    // the AI could make sense of. Say so plainly instead of failing with a
    // generic apology.
    if (result.intent === "unsupported") {
      // Mid-tutorial this is almost always a greeting, not a real attempt at
      // bookkeeping. Repeating the practice prompt keeps a brand new user on
      // the rails; advice about /workspace means nothing to them yet.
      if (isOnboarding(user)) {
        await sendPracticePrompt(message.chat.id, user, workspace);
      } else {
        await bot.sendMessage(
          message.chat.id,
          tr(UNSUPPORTED_KEY[result.reason] ?? "error.transaction", {
            workspace: workspaceLabel(workspace),
          })
        );
      }

      await updateMessageStatus(savedMessage.id, "ANSWERED");

      return;
    }

    // ----------------------------------------------
    // Questions are answered immediately.
    // They create nothing, so they skip confirmation entirely.
    // ----------------------------------------------
    if (result.intent === "balance_query") {
      await answerBalanceQuery(message.chat.id, user, result.person);
      await updateMessageStatus(savedMessage.id, "ANSWERED");

      return;
    }

    if (result.intent === "history_query") {
      await answerHistoryQuery(message.chat.id, user, result.person);
      await updateMessageStatus(savedMessage.id, "ANSWERED");

      return;
    }

    // ----------------------------------------------
    // A real transaction: store it and wait for confirmation.
    // ----------------------------------------------

    // Store the AI-generated entries in PostgreSQL — an ARRAY, since one
    // message can record several. This is why no in-memory Map is needed: the
    // pending entries survive a server restart because PostgreSQL holds them.
    await updateMessageTransactionData(savedMessage.id, result.transactions);

    // AI processing succeeded, so wait for user confirmation.
    await updateMessageStatus(
      savedMessage.id,
      "PENDING_CONFIRMATION"
    );

    // Ask the first unanswered "what was this money for?", or show the card.
    await askToConfirm(
      message.chat.id,
      user,
      result.transactions,
      result.skipped,
      message.message_id
    );
  } catch (error) {
    console.error(
      "Transaction processing error:",
      error
    );

    // Mark the message as failed because AI processing failed.
    // savedMessage is visible here because it is declared in the outer
    // scope above the try block.
    if (savedMessage) {
      await updateMessageStatus(
        savedMessage.id,
        "FAILED"
      );
    }

    // A beginner who typed "hii" during the tutorial gets the practice prompt
    // back, not an apology about a transaction they never tried to record.
    // The message is still marked FAILED above either way.
    if (onboardingWorkspace) {
      await sendPracticePrompt(
        message.chat.id,
        onboardingUser,
        onboardingWorkspace
      );

      return;
    }

    await sendError(message.chat.id, language, "error.transaction");
  }
});
