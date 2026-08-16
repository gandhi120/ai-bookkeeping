// Every inline-button tap. One handler routes them all by the prefix in
// callback_data: ws:/addws:/lang:/onb:/confirm:/cancel:/repayment:/income:.
//
// callback_data comes from the user's Telegram client, so every prefix is
// matched against a whitelist rather than trusted.

import { confirmMessageTransaction } from "../database/transactions.js";
import {
  updateMessageStatus,
  updateMessageTransactionData,
  getMessageByTelegramMessageId,
} from "../database/messages.js";
import { getCustomerBalance } from "../database/customers.js";
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  t,
  translator,
  enumLabel,
} from "../i18n/index.js";
import {
  bot,
  resolveShopkeeper,
  isOnboarding,
  money,
  needsPaymentClarification,
} from "./core.js";
import {
  transactionCard,
  transactionListCard,
  askToConfirm,
} from "./cards.js";
import {
  handleLanguageAction,
  handleWorkspaceAction,
  handleOnboardingAction,
  ONBOARDING_STEPS,
  sendFeatureTour,
} from "./onboarding.js";


// Maps a clarification button to the transaction type it means.
// Callback data arrives from the user's Telegram client, so this lookup is
// the whitelist: anything not listed here can never reach the database.
const CLARIFIED_TYPE = {
  repayment: "repayment",
  income: "payment_received",
};


// --------------------------------------------------
// Confirm / Cancel buttons
// --------------------------------------------------

// Handles Confirm / Cancel button clicks using PostgreSQL
// as the source of truth instead of an in-memory Map.
bot.on("callback_query", async (query) => {
  // Outside the try so the catch below can apologise in the user's language.
  // Set once the user is known; the catch never queries for it, because what
  // it is apologising for may well be the database being unreachable.
  let language = DEFAULT_LANGUAGE;

  try {
    // A clarification button on a multi-entry message carries a third part
    // naming WHICH entry it answers — `repayment:4821:2`. Single-entry
    // messages send no index, exactly as before.
    const [action, messageId, entryIndex] = query.data.split(":");

    // Workspace buttons carry a uuid or a workspace type, not a Telegram
    // message id, so they are handled BEFORE the Number() parse below —
    // which would otherwise turn them into NaN.
    if (action === "ws" || action === "addws") {
      await handleWorkspaceAction(query, action, messageId);

      return;
    }

    // Language buttons carry a language code or the literal "pick", for the
    // same reason — and the guard is the whitelist, so a forged `lang:xx`
    // never reaches the database.
    //
    //   lang:pick   reopen the picker (the 🌐 row on /workspace)
    //   lang:gu     set the language
    if (action === "lang" && (messageId === "pick" || isLanguage(messageId))) {
      await handleLanguageAction(query, messageId);

      return;
    }

    // Onboarding buttons carry a step name for the same reason, and are
    // whitelisted here so a forged payload can only ever be one of four.
    if (action === "onb" && ONBOARDING_STEPS.includes(messageId)) {
      await handleOnboardingAction(query, messageId);

      return;
    }

    const telegramMessageId = Number(messageId);

    // Set only when the shopkeeper answered the "what was this money for?"
    // question. null for a plain Confirm, which keeps the AI's own type.
    const typeOverride = CLARIFIED_TYPE[action] ?? null;

    // Get the shopkeeper who clicked the button. `workspace` is needed only
    // by the onboarding tour below, which picks its buttons from the ledger
    // type.
    const { user, workspace } = await resolveShopkeeper(
      query.from,
      query.message.chat
    );

    const tr = translator(user);

    language = user.language ?? DEFAULT_LANGUAGE;

    // Retrieve the original message and its transaction data
    // from PostgreSQL.
    const savedMessage =
      await getMessageByTelegramMessageId(
        user.id,
        telegramMessageId
      );

    // The message does not exist in PostgreSQL.
    if (!savedMessage) {
      await bot.answerCallbackQuery(query.id, {
        text: tr("toast.notFound"),
      });

      return;
    }

    // Only a pending transaction can be confirmed or cancelled.
    if (savedMessage.status !== "PENDING_CONFIRMATION") {
      await bot.answerCallbackQuery(query.id, {
        text: tr("toast.alreadyDone"),
      });

      return;
    }

    // The AI-generated entries, stored in PostgreSQL. Always read as a list:
    // rows written before one message could hold several hold a bare object.
    const transactions = [savedMessage.transaction_data ?? []].flat();

    // Make sure transaction data exists before continuing.
    if (transactions.length === 0) {
      await bot.answerCallbackQuery(query.id, {
        text: tr("toast.dataMissing"),
      });

      return;
    }

    // An ambiguous payment can only be saved through a clarification button.
    // The plain Confirm button is never shown while one is unanswered, but
    // callback data comes from the user's client, so refuse it here rather
    // than trust that.
    if (action === "confirm" && transactions.some(needsPaymentClarification)) {
      await bot.answerCallbackQuery(query.id, {
        text: tr("toast.chooseFirst"),
      });

      return;
    }

    // A clarification answer on a MULTI-entry message records the choice and
    // moves on to the next question, rather than confirming — nothing is
    // written until the final Yes on the card that lists everything.
    //
    // A single-entry message keeps its original behaviour, where the same tap
    // both answers and saves. Two paths, but the common one is untouched.
    if (entryIndex !== undefined && CLARIFIED_TYPE[action]) {
      const index = Number(entryIndex);

      if (!transactions[index]) {
        await bot.answerCallbackQuery(query.id, { text: tr("toast.notFound") });

        return;
      }

      transactions[index].transaction_type = CLARIFIED_TYPE[action];

      await updateMessageTransactionData(savedMessage.id, transactions);

      await bot.answerCallbackQuery(query.id);

      // Replace the question so it cannot be answered twice.
      await bot.editMessageText(
        `${tr("clarify.question", { person: transactions[index].person })}
${enumLabel(language, "type", CLARIFIED_TYPE[action])} ✅`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );

      // Ask the next one, or show the card now that none are left.
      await askToConfirm(
        query.message.chat.id,
        user,
        transactions,
        null,
        telegramMessageId
      );

      return;
    }

    // --------------------------------------------------
    // Cancel
    // --------------------------------------------------

    if (action === "cancel") {
      // Mark the original Telegram message as cancelled.
      await updateMessageStatus(
        savedMessage.id,
        "CANCELLED"
      );

      await bot.answerCallbackQuery(query.id, {
        text: tr("toast.cancelled"),
      });

      // Replace the confirmation message with the cancellation result.
      await bot.editMessageText(
        tr("confirm.cancelled"),
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );

      return;
    }

    // --------------------------------------------------
    // Confirm (or a clarification button, which confirms and chooses
    // the meaning in the same tap)
    // --------------------------------------------------

    if (action === "confirm" || typeOverride) {
      // Confirm the message and create the transaction
      // atomically inside PostgreSQL.
      const result = await confirmMessageTransaction(
        savedMessage.id,
        user.id,
        typeOverride
      );

      // The message was not found.
      if (result.reason === "NOT_FOUND") {
        await bot.answerCallbackQuery(query.id, {
          text: tr("toast.notFound"),
        });

        return;
      }

      // The message was already confirmed, cancelled,
      // or otherwise processed.
      if (result.reason === "ALREADY_PROCESSED") {
        await bot.answerCallbackQuery(query.id, {
          text: tr("toast.alreadyDone"),
        });

        return;
      }

      // Transaction data is missing from the message.
      if (result.reason === "TRANSACTION_DATA_MISSING") {
        await bot.answerCallbackQuery(query.id, {
          text: tr("toast.dataMissing"),
        });

        return;
      }

      // The transaction was successfully created
      // and the message was marked as CONFIRMED.
      if (result.success) {
        const saved = result.transactions;
        const multi = saved.length > 1;

        await bot.answerCallbackQuery(query.id, {
          text: multi
            ? tr("toast.savedMulti", { count: saved.length })
            : tr("toast.saved"),
        });

        // For udhaar entries, show each customer's new outstanding balance so
        // the shopkeeper gets immediate confirmation of the khata.
        //
        // Balances are read AFTER the commit and per customer, so two entries
        // naming the same person both show the final figure rather than a
        // half-applied one.
        const khataLines = [];

        for (const transaction of saved) {
          if (!transaction.customer_id) continue;

          const balance = await getCustomerBalance(
            user.id,
            transaction.customer_id
          );

          // A repayment can overshoot the debt, leaving a negative balance.
          // "owes ₹-4,000" reads as nonsense to a shopkeeper, so a negative
          // is phrased as advance money held — matching how the balance
          // question answers it.
          khataLines.push(
            balance < 0
              ? tr("khata.advance", {
                  person: transaction.person,
                  amount: money(Math.abs(balance)),
                })
              : tr("khata.nowOwes", {
                  person: transaction.person,
                  amount: money(balance),
                })
          );
        }

        const khataLine =
          khataLines.length > 0 ? `\n\n${[...new Set(khataLines)].join("\n")}` : "";

        // Replace the confirmation message with the saved result — the same
        // shape the user just approved, so the card does not rearrange itself
        // under them. Only the title and the khata line change.
        await bot.editMessageText(
          `${
            multi
              ? tr("confirm.savedTitleMulti", { count: saved.length })
              : tr("confirm.savedTitle")
          }

${
  multi ? transactionListCard(user, saved) : transactionCard(user, saved[0])
}${khataLine}`,
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
          }
        );

        // ONBOARDING STEP 4. The user has now seen the full loop work, so
        // follow the saved entry with the way out of the tutorial. This
        // reappears after every confirm until they answer it, which is what
        // stops somebody living in onboarding for a week with all their real
        // entries flagged as practice.
        if (isOnboarding(user)) {
          await sendFeatureTour(
            query.message.chat.id,
            user,
            workspace,
            "tour.intro"
          );
        }

        return;
      }
    }

    // Unknown callback action.
    await bot.answerCallbackQuery(query.id, {
      text: tr("toast.unknownAction"),
    });
  } catch (error) {
    console.error(
      "Confirmation error:",
      error
    );

    await bot.answerCallbackQuery(query.id, {
      text: t(language, "toast.wentWrong"),
    });
  }
});
