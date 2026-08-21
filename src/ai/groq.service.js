import "dotenv/config";
import Groq from "groq-sdk";

import { COMMON_CATEGORIES } from "../schemas/transaction.schema.js";
import { LANGUAGES } from "../i18n/index.js";

// Built on first use, not at import. The SDK throws from its constructor when
// the key is missing, and imports run before any code in the entry point — so
// constructing here made a missing key surface as an SDK stack trace before
// the boot check in bot.js could report the whole list of missing variables.
let groq;

function client() {
  return (groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY }));
}

// Today's date in the user's timezone, used as the default when a message
// mentions no date.
function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ONE prompt, for every ledger.
//
// There used to be two — a shopkeeper one and a household one — picked by
// `workspace.type`, because a household could never record udhaar and should
// not pay prompt tokens for rules about it. Ledgers are now named by the user
// ("🏍️ Bike", "🌾 Farm"), so there is no "kind" left to switch on.
//
// This is not the two old prompts glued together. The model is no longer asked
// to pick a transaction TYPE from a list the code then looks meaning up in —
// it answers the two questions that list existed to answer. That is shorter
// than either old prompt's type table, so the running cost per message goes
// DOWN, which matters: the prompt ships with every single message and the free
// tier's daily token budget is the binding production limit.
//
// `ledgerName` is context, not a rule — it nudges category and description
// ("petrol" in a Bike ledger, "khaad" in a Farm one) for the price of a few
// tokens.
//
// `language` changes exactly one thing: which language the model WRITES in.
// English adds no line at all rather than "write in English", so existing
// users pay nothing for the feature. Input is accepted in any mix regardless,
// and "person" and "category" stay in English letters — that is what keeps the
// (user_id, lower(name)) customer lookup matching a name typed two ways.
function buildSystemPrompt(language = "en", ledgerName = null) {
  const aiName = LANGUAGES[language]?.aiName;

  const where = ledgerName
    ? `The user is writing in a ledger they named "${ledgerName}".\n`
    : "";

  const writeIn = aiName
    ? `\nWrite "description" and "transaction_type" in ${aiName}.\n`
    : "";

  return `${where}${buildLedgerPrompt()}${writeIn}`;
}

// Keep this terse. State a rule once; add an example only for a case the rule
// alone keeps getting wrong. Every line here is paid for on every message.
//
// Built fresh per message because the default date has to be today's date in
// the user's timezone. Both providers below send this same text: if the
// fallback had its own prompt they would drift, and the same sentence would
// book differently depending on which one happened to answer.
function buildLedgerPrompt() {
  return `
Bookkeeping assistant for an Indian user recording their own money — a shop, a
home, a vehicle, a farm, whatever they named this ledger. The sender is always
the user; any named person ("Raj") is someone they deal with, never the sender.

"intent" is ALWAYS exactly one of: transaction, balance_query, history_query.
Anything being RECORDED, however short, is intent "transaction".

ALWAYS return a JSON LIST, even for one thing. One object per distinct entry:
a message with three purchases returns three objects.

ASKING what somebody owes, or to see their entries:
[{"intent": "balance_query" | "history_query", "person": "Name"}]

RECORDING anything else:
[{
  "intent": "transaction",
  "cash": "in|out|none",
  "udhaar": "they_owe_more|they_owe_less|i_owe_more|i_owe_less|none",
  "transaction_type": "two or three words naming what happened",
  "description": "string",
  "category": "string",
  "quantity": integer,
  "amount": number,
  "person": "string or null",
  "transaction_date": "YYYY-MM-DD",
  "notes": "string or null"
}]

"cash" — did rupees actually move?
  in    money came TO the user (sold, salary, received, got paid back)
  out   money LEFT the user (bought, bill, paid, gave, lent)
  none  nothing moved yet — goods handed over on udhaar

"udhaar" — did anyone's debt change?
  they_owe_more  user gave goods or money on credit, or is owed
  they_owe_less  somebody paid the user back
  i_owe_more     user BORROWED money from somebody
  i_owe_less     user PAID somebody back
  none           nobody's debt changed

The two are independent. Most entries answer one and say "none" to the other.

  sold 3 shirts for 1200        -> in,   none
  bought 20kg rice for 900      -> out,  none
  light bill 2400               -> out,  none
  salary 65000 received         -> in,   none
  gave Ramesh 2000 for his trip -> out,  none          (a gift, not a loan)
  Raj took 500 goods on udhaar  -> none, they_owe_more
  Raj paid back 500             -> in,   they_owe_less
  borrowed 10000 from Mama      -> in,   i_owe_more
  paid Mama back 4000           -> out,  i_owe_less

DEBT — NEVER GUESS. This changes what somebody owes.
Only set udhaar when the message contains a debt word: udhaar, credit, baaki,
due, loan, paid back, returned, cleared, settled, remaining, pending, borrowed,
lent, pacha aapya, "towards his/her".
A name alone is NOT a debt. No debt word means the message never said what the
money was for — use cash in/out with udhaar "none", and KEEP the name.
  "Received 5000 from Raj", "Raj gave me 5000"  -> in,  none, person Raj
  "Raj paid 1000 towards his udhaar"            -> in,  they_owe_less, Raj
  "Raj owes me 5000"                            -> none, they_owe_more, Raj
  "Paid 3000 to supplier"                       -> out, none, person null
WHO ACTED decides the direction. In Hindi and Gujarati "ne" marks the DOER
and "ko" marks the receiver. The sender is always the user, so a NAMED person
in front of "ne" means THAT PERSON acted, not the user:
  "Raj ne baaki 500 de diye"   -> in,  they_owe_less   (RAJ gave)
  "Raj ne 500 aapya"           -> in,  none            (RAJ gave)
  "Mama ko 4000 wapas diye"    -> out, i_owe_less      (the USER gave)
  "Mama se 10000 liya"         -> in,  i_owe_more      (the USER took)
"se/pase thi" = from them. "ko/ne (as receiver)" = to them.

CATEGORY, lowercase English, prefer one of:
${COMMON_CATEGORIES.join(" ")}
Anything else is allowed when none of these fit ("petrol", "khaad", "chai").

LANGUAGE
English, Gujarati script, Roman Gujarati, Hinglish or any mix must produce the
SAME JSON. Always write "person" and "category" in ENGLISH LETTERS and strip
grammar endings: રાજેશ / રાજેશે / "Rajesh e" / "Rajesh ne" -> "Rajesh".
  ઉધાર/udhar + માલ,સામાન + લીધો (by a named person)  -> none, they_owe_more
  પાછા આપ્યા/pacha aapya, ઉધારના આપ્યા               -> in,   they_owe_less
  ઉધાર લીધું/udhar lidhu (BY the user)               -> in,   i_owe_more
  બાકી/baki, કેટલા/ketla ... છે/che (a question)     -> balance_query
  હિસાબ/hisab + બતાવો/batavo                         -> history_query
  લીધા/lidha, ખરીદ્યું with no name and no udhar word -> out,  none
  બિલ/bill + ભર્યું/bharyu, ખર્ચ્યા, વાપર્યા            -> out,  none
  મળ્યા/malya, પગાર/pagar, આવક/aavak, વેચ્યું         -> in,   none
"aapyu/aapya" alone only means "gave" — set udhaar ONLY with an
udhar/baki/pacha word, otherwise cash out and udhaar "none".

RULES
- amount is ALWAYS POSITIVE. Direction is carried by cash and udhaar, never by
  a minus sign.
- Never invent an amount. If missing, amount is null.
- Default quantity 1, person null, notes null when not mentioned.
- When udhaar is not "none", person MUST be the other party's name.
- No date given -> use ${today()}.
- Return ONLY JSON.
`;
}

// Either provider can wrap its JSON in a markdown code fence.
function stripCodeFences(text) {
  return text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

// PRIMARY provider.
async function askGroq(message, language, ledgerName) {
  const response = await client().chat.completions.create({
    // Pinned, and overridable, for the same reason GEMINI_MODEL is: providers
    // RETIRE models. `llama-3.3-70b-versatile` was pinned here and 404'd —
    // silently, because Gemini answers almost every message and the fallback
    // is only reached when it does not. A dead fallback looks exactly like a
    // working one until the day it is needed.
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    messages: [
      { role: "system", content: buildSystemPrompt(language, ledgerName) },
      { role: "user", content: message },
    ],
    temperature: 0,
  });

  return stripCodeFences(response.choices[0].message.content);
}

// FALLBACK provider, used when Groq fails — most often because the free
// tier's 100k tokens/day is exhausted. Plain REST with the built-in fetch:
// this is one HTTP POST, so a Google SDK would be more code than the request.
async function askGemini(message, language, ledgerName) {
  // `||` not `??`: an unset key in .env reads as "" rather than undefined,
  // and "" would build a URL with no model name in it.
  //
  // Pinned to an exact version on purpose. The `-latest` aliases get
  // repointed by Google without warning, and this prompt is tuned to one
  // model's behaviour — a silent swap would change how messages classify
  // with no deploy on our side. Google also retires old models outright
  // (gemini-2.0-flash now 404s), so this needs reviewing, not forgetting.
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        // Gemini keeps instructions separate from the user's message — the
        // same split as Groq's system/user roles.
        system_instruction: {
          parts: [{ text: buildSystemPrompt(language, ledgerName) }],
        },
        contents: [{ role: "user", parts: [{ text: message }] }],
        generationConfig: {
          temperature: 0,
          // Ask for raw JSON instead of prose wrapped in a fence.
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Gemini ${response.status}: ${(await response.text()).slice(0, 200)}`
    );
  }

  const data = await response.json();

  // Gemini nests the answer, and omits parts entirely when it declines.
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error(
      `Gemini returned no content: ${JSON.stringify(data).slice(0, 200)}`
    );
  }

  return stripCodeFences(text);
}

// Asks Gemini first and falls back to Groq if it fails for any reason
// (rate limit, outage, network). Both get the identical prompt, so the
// caller cannot tell which one answered.
//
// Gemini leads because its limit is 15 requests per MINUTE, which recovers
// in a minute, while Groq's is 100k tokens per DAY — once that runs out the
// shop is down until tomorrow. Gemini is also cheaper per message (~1,105
// tokens vs ~1,200) and faster (~1.3s vs ~1.5s), and passes all 32 cases in
// tests/ai.test.js including the Gujarati ones.
//
// Without GEMINI_API_KEY this calls Groq directly and behaves exactly as it
// did before the fallback existed.
//
// `language` decides which language the model writes in; `ledgerName` is the
// name the user gave this ledger, passed through as context. Both default to
// what the bot did before they existed, so an un-updated caller — and both
// providers on the fallback path — keep behaving exactly as they do today.
export async function askAI(message, language = "en", ledgerName = null) {
  if (!process.env.GEMINI_API_KEY) {
    return await askGroq(message, language, ledgerName);
  }

  try {
    return await askGemini(message, language, ledgerName);
  } catch (geminiError) {
    console.warn("Gemini failed, falling back to Groq:", geminiError.message);

    try {
      return await askGroq(message, language, ledgerName);
    } catch (groqError) {
      // Surface both, otherwise a Gemini key typo looks like a Groq outage.
      throw new Error(
        `Both providers failed. Gemini: ${geminiError.message} | Groq: ${groqError.message}`
      );
    }
  }
}
