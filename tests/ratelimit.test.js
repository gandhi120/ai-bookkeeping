// Self-check for the flood guard.
//
// This one protects money, not correctness: the AI budget is shared and
// resets daily, so a guard that silently stops firing means one user can take
// the whole shop offline until tomorrow. Run it with:
//
//   node tests/ratelimit.test.js
//
// No database and no API key needed. Importing bot.js is safe because it only
// starts a transport when it is the process entry point.

import assert from "node:assert/strict";

import { overRateLimit } from "../src/telegram/bot.js";

let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

// Every case picks its own user id, because the counters are module state and
// would otherwise leak between checks.
let nextUser = 1000;
const user = () => nextUser++;

// Kept in sync with bot.js by construction: send LIMIT messages, assert none
// were blocked, and the constant itself never has to be repeated here.
const LIMIT = 20;
const WINDOW_MS = 60_000;

console.log("\nNormal use is never blocked:");

check("a single message passes", () => {
  assert.equal(overRateLimit(user(), 0), 0);
});

check("exactly the limit still passes", () => {
  const id = user();

  for (let i = 0; i < LIMIT; i++) {
    assert.equal(overRateLimit(id, 0), 0, `message ${i + 1} was blocked`);
  }
});

check("one user's flood does not block another", () => {
  const flooder = user();
  const bystander = user();

  for (let i = 0; i < LIMIT + 5; i++) {
    overRateLimit(flooder, 0);
  }

  assert.equal(overRateLimit(bystander, 0), 0);
});

console.log("\nA flood is stopped, and warned exactly once:");

check("the message past the limit crosses", () => {
  const id = user();

  for (let i = 0; i < LIMIT; i++) {
    overRateLimit(id, 0);
  }

  // 1 is the signal the handler replies to. Anything else and the user either
  // gets no warning or gets one per message.
  assert.equal(overRateLimit(id, 0), 1);
});

check("further messages return more than 1, so stay silent", () => {
  const id = user();

  for (let i = 0; i < LIMIT + 1; i++) {
    overRateLimit(id, 0);
  }

  assert.equal(overRateLimit(id, 0), 2);
  assert.equal(overRateLimit(id, 0), 3);
});

console.log("\nThe window reopens:");

check("a blocked user is allowed again after the window", () => {
  const id = user();

  for (let i = 0; i < LIMIT + 3; i++) {
    overRateLimit(id, 0);
  }

  assert.ok(overRateLimit(id, 0) > 0, "should still be blocked inside window");
  assert.equal(overRateLimit(id, WINDOW_MS + 1), 0);
});

check("the window is not reset by traffic inside it", () => {
  const id = user();

  // Sending steadily across the whole minute must not keep pushing the window
  // forward — that would make the limit unenforceable for a patient flooder.
  for (let i = 0; i < LIMIT; i++) {
    assert.equal(overRateLimit(id, i * 1_000), 0);
  }

  assert.equal(overRateLimit(id, LIMIT * 1_000), 1);
});

console.log(
  `\n${passed} checks passed${process.exitCode ? " — SOME FAILED" : ""}\n`
);
