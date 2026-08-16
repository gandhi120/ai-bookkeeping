// Everything that runs before a user has a working ledger, plus the feature
// tour that follows their first confirmed entry.
//
// TOUR pairs each feature's label with the command that renders it, so a
// button can never exist without a handler.

import { featuresForWorkspace } from "../schemas/transaction.schema.js";
import { setUserLanguage } from "../database/users.js";
import {
  getActiveWorkspace,
  createWorkspace,
  setActiveWorkspace,
} from "../database/workspaces.js";
import { countOnboardingTransactions, finishOnboarding } from "../database/onboarding.js";
import { isLanguage, translator } from "../i18n/index.js";
import {
  bot,
  resolveShopkeeper,
  WORKSPACE_KINDS,
  workspaceLabel,
  askToChooseLanguage,
  askToChooseWorkspace,
  isOnboarding,
  sendPracticePrompt,
} from "./core.js";
import {
  sendDailySummary,
  sendMonthlySummary,
  sendTransactionsList,
  sendUdhaarList,
  sendWelcomeHelp,
} from "./commands.js";


// Handles every lang:* button.
//
// `lang:pick` reopens the picker (the 🌐 row on /workspace); `lang:<code>`
// sets the language. Callback data comes from the user's Telegram client, so
// the code is checked here and again in setUserLanguage — a forged `lang:xx`
// can never reach the database.
async function handleLanguageAction(query, code) {
  const chatId = query.message.chat.id;

  const { user, workspace } = await resolveShopkeeper(
    query.from,
    query.message.chat
  );

  if (code === "pick") {
    await bot.answerCallbackQuery(query.id);

    await askToChooseLanguage(chatId, user);

    return;
  }

  if (!isLanguage(code)) {
    await bot.answerCallbackQuery(query.id, { text: translator(user)("toast.unknownLanguage") });

    return;
  }

  await setUserLanguage(user.id, code);

  await bot.answerCallbackQuery(query.id);

  // `user` was read before the update, so everything below has to be told the
  // new language explicitly — otherwise the very message confirming the
  // change would still be written in the language they just left.
  const updated = { ...user, language: code };

  // A user still in setup carries straight on to the ledger question. One
  // changing their language later just gets confirmation — same tap, same
  // function, the only difference is what comes next.
  if (!workspace) {
    await askToChooseWorkspace(chatId, updated);

    return;
  }

  await bot.sendMessage(chatId, translator(updated)("language.changed"));
}


// Handles the two workspace buttons: switching to an existing workspace
// (`ws:<uuid>`) and creating one during onboarding (`addws:<type>`).
//
// Both payloads come from the user's Telegram client, so neither is trusted:
// `addws` is looked up in WORKSPACE_KINDS, which is the whitelist, and
// setActiveWorkspace refuses a workspace that is not this user's.
async function handleWorkspaceAction(query, action, value) {
  const chatId = query.message.chat.id;

  const { user } = await resolveShopkeeper(query.from, query.message.chat);

  const tr = translator(user);

  let workspace;

  if (action === "addws") {
    const kind = WORKSPACE_KINDS[value];

    if (!kind) {
      await bot.answerCallbackQuery(query.id, { text: tr("toast.unknownWorkspace") });

      return;
    }

    workspace = await createWorkspace(user.id, tr(kind.nameKey), value);
    await setActiveWorkspace(user.id, workspace.id);
  } else {
    // A forged or stale uuid updates nothing and returns undefined.
    const updated = await setActiveWorkspace(user.id, value);

    if (!updated) {
      await bot.answerCallbackQuery(query.id, { text: tr("toast.workspaceNotFound") });

      return;
    }

    workspace = await getActiveWorkspace(user.id);
  }

  await bot.answerCallbackQuery(query.id, {
    text: tr("workspace.switched", { workspace: workspace.name }),
  });

  await bot.editMessageText(
    tr("workspace.nowUsing", { workspace: workspaceLabel(workspace) }),
    {
      chat_id: chatId,
      message_id: query.message.message_id,
    }
  );

  // ONBOARDING STEP 3. A first-time user has just answered the only question
  // the bot cannot work without, so instead of a one-line hint they get walked
  // through recording something. Somebody adding a SECOND workspace later is
  // not new and keeps the short hint.
  if (isOnboarding(user)) {
    await bot.sendMessage(
      chatId,
      tr("workspace.ready", { workspace: workspaceLabel(workspace) })
    );

    await sendPracticePrompt(chatId, user, workspace);

    return;
  }

  await bot.sendMessage(
    chatId,
    workspace.type === "household"
      ? tr("ws.hintHome")
      : tr("ws.hintShop")
  );
}


// ONBOARDING STEP 4 — sent right after the practice transaction is saved.
//
// This is the moment the user has seen the whole loop work, so the tour is
// offered here and nowhere earlier: every command below now has at least one
// real row to show. /summary and /monthly have no empty state, so offering
// them before anything is recorded would introduce the user to their own
// books as a wall of ₹0.
//
// Every feature the tour can show: its button text and the function that
// runs it, in one entry each.
//
// One table rather than a label map beside an action map, so a feature can
// never have a button with no handler or a handler with no label — the second
// would send Telegram a button captioned "undefined".
//
// WHICH of these a given user sees comes from featuresForWorkspace(), so a
// household is never offered a khata.
//
// `label` is a catalog key rather than the text itself, so the button and the
// screen it opens can be translated independently — which matters right now,
// because the buttons are translated and the reports behind them are not yet.
const TOUR = {
  summary: { label: "tour.summary", run: sendDailySummary },
  monthly: { label: "tour.monthly", run: sendMonthlySummary },
  transactions: { label: "tour.transactions", run: sendTransactionsList },
  udhaar: { label: "tour.udhaar", run: sendUdhaarList },
};


// ONBOARDING STEP 4/5 — the feature tour.
//
// Buttons rather than steps. Everything here is optional, so a user who wants
// out taps Finish once and a user who is curious sees every feature run
// against their own data in about ten seconds. That is what keeps "takes 30
// seconds" honest while still covering the whole product.
async function sendFeatureTour(chatId, user, workspace, introKey) {
  const tr = translator(user);

  const featureRows = featuresForWorkspace(workspace.type).map((feature) => [
    { text: tr(TOUR[feature].label), callback_data: `onb:${feature}` },
  ]);

  await bot.sendMessage(chatId, tr(introKey), {
    reply_markup: {
      inline_keyboard: [
        ...featureRows,
        [{ text: tr("tour.finish"), callback_data: "onb:finish" }],
      ],
    },
  });
}


// ONBOARDING STEP 6 — the confirmation before anything is deleted.
//
// The COUNT is the safety rail, not decoration. Everything typed while
// onboarding is open counts as practice, so a user who ignored the finish
// button for a week would be clearing real work. "You have 47 practice
// entries" is what makes that visible before the tap, and Keep is offered
// with equal weight.
//
// The count stands alone in the sentence ("Practice entries: 3") rather than
// being pluralised into it. English needs entry/entries, Hindi and Gujarati
// do not pluralise the same way, and a number on its own reads naturally in
// all three — so there is no plural function to write or get wrong.
async function askToClearPracticeData(chatId, user, count) {
  const tr = translator(user);

  await bot.sendMessage(chatId, tr("clear.prompt", { count }), {
    reply_markup: {
      inline_keyboard: [
        [{ text: tr("clear.button"), callback_data: "onb:clear" }],
        [{ text: tr("keep.button"), callback_data: "onb:keep" }],
      ],
    },
  });
}


// The only onboarding steps that exist. Callback data is user-supplied, so
// this list is the whitelist: `onb:` with anything else is not routed at all.
//
// Every tour feature must appear here or its button silently does nothing
// useful — an unlisted step does not reach "Unknown action", it falls through
// to the transaction path and reports "Transaction not found."
const ONBOARDING_STEPS = [
  ...Object.keys(TOUR),
  "finish",
  "clear",
  "keep",
];


// Handles every onb:* button — the onboarding steps after the workspace has
// been created.
//
// Callback data comes from the user's Telegram client and is never trusted:
// only the steps above exist, anything else falls through to the caller's
// "Unknown action". `finish` and `clear`/`keep` are separate steps on purpose,
// so deleting data always takes a deliberate second tap.
async function handleOnboardingAction(query, step) {
  const chatId = query.message.chat.id;

  const { user, workspace } = await resolveShopkeeper(
    query.from,
    query.message.chat
  );

  const tr = translator(user);

  // Onboarding is already over — the buttons are on an old message someone
  // scrolled back to. Say so rather than clearing anything.
  if (!isOnboarding(user)) {
    await bot.answerCallbackQuery(query.id, {
      text: tr("toast.setupAlreadyDone"),
    });

    return;
  }

  // A tour button: run the real command against their own data, then offer
  // the card again so trying a second feature is one tap, not a hunt.
  if (TOUR[step]) {
    await bot.answerCallbackQuery(query.id);

    await TOUR[step].run(chatId, user, workspace);

    await sendFeatureTour(chatId, user, workspace, "tour.more");

    return;
  }

  if (step === "finish") {
    await bot.answerCallbackQuery(query.id);

    const count = await countOnboardingTransactions(user.id);

    // Nothing was ever recorded, so there is nothing to ask about. Close
    // onboarding straight away rather than asking to clear zero rows.
    if (count === 0) {
      await finishOnboarding(user.id, { clear: false });

      await bot.sendMessage(chatId, tr("finish.done"));

      await sendWelcomeHelp(chatId, user, workspace);

      return;
    }

    await askToClearPracticeData(chatId, user, count);

    return;
  }

  // Only `clear` and `keep` remain, and both end onboarding. Anything else
  // never reaches here — the caller's whitelist decides what gets this far.
  const clear = step === "clear";

  const result = await finishOnboarding(user.id, { clear });

  await bot.answerCallbackQuery(query.id, {
    text: clear ? tr("toast.cleared") : tr("toast.setupComplete"),
  });

  await bot.editMessageText(
    clear
      ? tr("finish.cleared", { count: result.transactions })
      : tr("finish.kept"),
    {
      chat_id: chatId,
      message_id: query.message.message_id,
    }
  );

  await sendWelcomeHelp(chatId, user, workspace);
}

export {
  handleLanguageAction,
  handleWorkspaceAction,
  handleOnboardingAction,
  ONBOARDING_STEPS,
  sendFeatureTour,
};
