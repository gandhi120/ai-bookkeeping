// The entry point. Everything above this file only defines things; this is
// where the process starts, stops, and registers its handlers.
//
// Importing the handler modules is what registers them — bot.onText/bot.on run
// as a side effect of module evaluation, so import order IS registration
// order. Importing this file remains inert: the constructor in core.js is
// passed polling:false/autoOpen:false, and nothing dials out until start().

import { pathToFileURL } from "node:url";

import { pool } from "../database/pool.js";
import {
  bot,
  webhookUrl,
  webhookPath,
} from "./core.js";

// Registering the handlers. Order matters — it is the order they were
// declared in when this was one file.
import "./commands.js";
import "./messages.js";
import "./callbacks.js";

// The gym check-in. A separate domain that shares no code with the ledgers —
// see src/gym/. Registered last because it registers nothing the others need,
// and it is the one import to delete if the feature goes.
import "../gym/telegram.js";


// True only when this file is the process entry point. Importing it — from a
// test, or from server.js if HTTP is ever added back — then defines the
// handlers and helpers without connecting to Telegram. Nothing below reaches
// the network until `start()` runs at the bottom.
const isEntryPoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;


// --------------------------------------------------
// Telegram transport errors
// --------------------------------------------------

// Handles errors reported by Telegram polling.
bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});


// Same, for the webhook transport. Without a listener the library prints the
// raw error itself, so this exists to keep the log format consistent.
bot.on("webhook_error", (error) => {
  console.error(
    "Telegram webhook error:",
    error.message
  );
});


// --------------------------------------------------
// Shutdown
// --------------------------------------------------

// Every redeploy sends SIGTERM and kills the process shortly after. Stopping
// the transport first means no new update is accepted while we are on the way
// out, and `pool.end()` waits for in-flight queries — so a confirmation that
// is mid-`BEGIN` finishes instead of being cut off and rolled back.
async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);

  try {
    if (webhookUrl) {
      await bot.closeWebHook();
    } else {
      await bot.stopPolling();
    }

    await pool.end();
  } catch (error) {
    console.error("Shutdown error:", error.message);
  }

  process.exit(0);
}


for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => shutdown(signal));
}


// --------------------------------------------------
// Boot
// --------------------------------------------------

// Everything above only defines things. This is the only code that touches the
// network, and it runs solely when this file is the entry point.
async function start() {
  // Checked before anything connects. A missing variable otherwise surfaces as
  // a confusing error on the first real message — the bot boots, looks
  // healthy, and fails per user. A typo'd name in a host's dashboard is the
  // most common bad deploy, so it should stop the process, not degrade it.
  const missingEnv = [
    "TELEGRAM_BOT_TOKEN",
    "DATABASE_URL",
    "GROQ_API_KEY",
  ].filter((name) => !process.env[name]);

  if (missingEnv.length) {
    console.error(
      `Missing required environment variables: ${missingEnv.join(", ")}`
    );

    process.exit(1);
  }

  if (webhookUrl) {
    await bot.openWebHook();

    // Tells Telegram where to deliver updates. Safe to repeat on every boot —
    // it overwrites the previous registration rather than erroring, so
    // redeploying on a new URL needs no manual step. Deliberately not wrapped
    // in a try: a bot Telegram cannot reach should crash visibly rather than
    // sit there answering health checks.
    await bot.setWebhook(`${webhookUrl}${webhookPath}`);

    console.log(`Telegram bot listening for webhooks on ${webhookUrl}`);
  } else {
    await bot.startPolling();

    console.log("Telegram bot is running (polling)...");
  }
}


if (isEntryPoint) {
  await start();
}

export { bot };
export { overRateLimit } from "./messages.js";
