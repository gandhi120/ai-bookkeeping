import "dotenv/config";
import Groq from "groq-sdk";

import { HOUSEHOLD_CATEGORIES } from "../schemas/transaction.schema.js";
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
// mentions no date. Shared by both prompts so they cannot disagree about
// what "today" means.
function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// Picks the rules for the ledger the user is currently in.
//
// Deliberately two separate prompts rather than one prompt with a "you are in
// workspace X" switch. The prompt is sent with EVERY message, so a combined
// one would make every shop message pay for household rules it can never use,
// and vice versa. Splitting them also means the shopkeeper text below is
// untouched by this feature — the udhaar rules cannot regress if nothing
// edits them.
// `language` is the user's chosen language, and it changes exactly one thing:
// which language the model writes "description" in. Everything else about the
// prompt is unaffected — the LANGUAGE sections below already accept Gujarati,
// Hinglish or English INPUT in any mix, and "person" and "category" stay in
// English letters regardless, which is what keeps the customer lookup
// matching a name typed two different ways.
//
// English adds no line at all rather than "write in English": the prompt is
// sent with every single message, so the token budget is the binding
// production limit and existing users must pay nothing for this feature.
function buildSystemPrompt(workspaceType, language = "en") {
  const base =
    workspaceType === "household"
      ? buildHouseholdPrompt()
      : buildShopkeeperPrompt();

  const aiName = LANGUAGES[language]?.aiName;

  return aiName ? `${base}\nWrite "description" in ${aiName}.\n` : base;
}

// The system prompt is sent with EVERY message, so its length is a running
// cost: prompt tokens x every message the shop sends. On the free tier that
// is the binding limit, not the code. Keep it terse — state a rule once, and
// add an example only for a case the rule alone keeps getting wrong.
//
// Built fresh per message because the default date has to be today's date
// in the shop's timezone. Both providers below use this same text: if the
// fallback had its own prompt they would drift, and the same sentence would
// book differently depending on which one happened to answer.
function buildShopkeeperPrompt() {
  return `
Bookkeeping assistant for an Indian SHOPKEEPER. The sender is always the
shopkeeper; any named person ("Raj") is their customer, never the sender.

"intent" is ALWAYS exactly one of: transaction, balance_query, history_query.
Never copy a transaction_type into "intent". Anything being RECORDED, however
short, is intent "transaction".

ALWAYS return a JSON LIST, even for one thing. One object per distinct entry:
a message with three purchases returns three objects.

ASKING about a customer:
[{"intent": "balance_query" | "history_query", "person": "Name"}]
balance_query = how much is owed. history_query = show their entries.

RECORDING anything else:
[{
  "intent": "transaction",
  "transaction_type": "sale|purchase|expense|payment_received|payment_sent|credit_sale|repayment|other",
  "description": "string",
  "category": "string",
  "quantity": integer,
  "amount": number,
  "person": "string or null",
  "transaction_date": "YYYY-MM-DD",
  "notes": "string or null"
}]

TYPES
purchase          bought goods/stock
sale              sold and was PAID immediately
expense           business cost: electricity, rent, transport, salary, upkeep
payment_sent      money out to a supplier or non-customer
payment_received  money in that is NOT a stated udhaar repayment
credit_sale       UDHAAR GIVEN: a named customer took goods without paying,
                  or is stated to owe money. They now owe MORE.
repayment         UDHAAR PAID BACK: the message SAYS this settles an existing
                  debt. They now owe LESS.

MONEY IN - repayment vs payment_received. NEVER GUESS: this changes what a
customer owes.
Use repayment ONLY if the message contains a debt word: udhaar, credit,
baaki, due, paid back, returned, cleared, settled, remaining, pending,
pacha aapya, "towards his/her".
  "Raj paid 1000 towards his udhaar", "Raj paid back 1000", "Raj paid
  remaining 1000", "Raj ne baaki 500 de diye" -> repayment, person Raj
No debt word means the message never said what the money was for. Use
payment_received and KEEP the name. A name alone is NOT a repayment.
  "Received 5000 from Raj", "Raj gave me 5000", "Raj paid 1000"
  -> payment_received, person Raj
Nobody named -> person null.
  "Received 5000 cash", "Received 5000 from a walk-in customer"
  -> payment_received, null
  "Paid 3000 to supplier" -> payment_sent, null

UDHAAR GIVEN
  "Raj took goods for 2000 on udhaar", "Sold goods to Amit for 2500 on
  credit", "Raj owes me 5000" -> credit_sale, that person, that amount
A named person taking goods without paying is credit_sale, NOT sale.

LANGUAGE
English, Gujarati script, Roman Gujarati, Hinglish or any mix must produce
the SAME JSON. Always write "person" and "category" in ENGLISH LETTERS and
strip grammar endings: રાજેશ / રાજેશે / "Rajesh e" / "Rajesh ne" -> "Rajesh".
  ઉધાર/udhar + માલ,સામાન/maal,saman + લીધો/lidho     -> credit_sale
  પાછા આપ્યા/pacha aapya, ઉધારના આપ્યા/udhar na aapya -> repayment
  બાકી/baki, કેટલા/ketla ... છે/che (a question)      -> balance_query
  હિસાબ/hisab + બતાવો/batavo                          -> history_query
  લીધા/lidha with no name and no udhar word           -> purchase
  બિલ/bill + ભર્યું/bharyu                             -> expense
"aapyu/aapya" alone only means "gave" - repayment ONLY with an
udhar/baki/pacha word, otherwise follow MONEY IN.

RULES
- Never invent an amount. If missing, amount is null.
- Default quantity 1, person null, notes null when not mentioned.
- For credit_sale and repayment, person must be the customer's name.
- No date given -> use ${today()}.
- Return ONLY JSON.
`;
}

// The household ledger. Much shorter than the shopkeeper prompt because
// there are no customers here: no khata, no udhaar, and therefore none of the
// "is this money in a repayment or not" reasoning that costs most of the
// tokens above.
//
// The category list is interpolated from the schema so there is one source of
// truth — adding a category there is enough, the prompt follows.
function buildHouseholdPrompt() {
  return `
Personal/family finance assistant. The sender is tracking their OWN household
money. There are no customers and no credit here.

ALWAYS return a JSON LIST, even for one thing. One object per distinct entry:
a message with three expenses returns three objects.

If the message ASKS what somebody owes, or asks to see somebody's entries,
return [{"intent": "balance_query", "person": "Name"}] and nothing else. The
app explains that this needs the shop — do not invent an intent of your own.

Return ONLY JSON:
[{
  "intent": "transaction",
  "transaction_type": "expense|income|other",
  "description": "string",
  "category": "string",
  "quantity": integer,
  "amount": number,
  "person": "string or null",
  "transaction_date": "YYYY-MM-DD",
  "notes": "string or null"
}]

TYPES
expense  money out: groceries, bills, rent, fuel, medicine, shopping, fees
income   money in: salary, bonus, interest, refund, gift received
other    only when it is clearly neither

CATEGORY must be exactly one of, lowercase English:
${HOUSEHOLD_CATEGORIES.join(" ")}
A bill is an expense whose category is the thing being paid for.
  "Paid electricity bill 2400" -> expense, electricity
  "Bought groceries for 500"   -> expense, groceries
  "Salary received 65000"      -> income,  salary

LANGUAGE
English, Gujarati script, Roman Gujarati, Hinglish or any mix must produce the
SAME JSON. Always write "category" and "person" in ENGLISH LETTERS.
  ખર્ચ્યા/kharchya, ભર્યું/bharyu, વાપર્યા/vaparya -> expense
  મળ્યા/malya, પગાર/pagar, આવક/aavak            -> income
  કિરાણા/kirana -> groceries     લાઇટ/light -> electricity
  ભાડું/bhadu   -> rent           દવા/dava   -> medical

RULES
- Never invent an amount. If missing, amount is null.
- Default quantity 1, person null, notes null when not mentioned.
- A name in a household message is just a note, never a customer.
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
async function askGroq(message, workspaceType, language) {
  const response = await client().chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: buildSystemPrompt(workspaceType, language) },
      { role: "user", content: message },
    ],
    temperature: 0,
  });

  return stripCodeFences(response.choices[0].message.content);
}

// FALLBACK provider, used when Groq fails — most often because the free
// tier's 100k tokens/day is exhausted. Plain REST with the built-in fetch:
// this is one HTTP POST, so a Google SDK would be more code than the request.
async function askGemini(message, workspaceType, language) {
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
          parts: [{ text: buildSystemPrompt(workspaceType, language) }],
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
// `workspaceType` decides which rules the model gets, and `language` decides
// which language the description comes back in. Both default to what the bot
// did before they existed, so any caller that has not been updated — and both
// providers on the fallback path — keep behaving exactly as they do today.
export async function askAI(message, workspaceType = "shopkeeper", language = "en") {
  if (!process.env.GEMINI_API_KEY) {
    return await askGroq(message, workspaceType, language);
  }

  try {
    return await askGemini(message, workspaceType, language);
  } catch (geminiError) {
    console.warn("Gemini failed, falling back to Groq:", geminiError.message);

    try {
      return await askGroq(message, workspaceType, language);
    } catch (groqError) {
      // Surface both, otherwise a Gemini key typo looks like a Groq outage.
      throw new Error(
        `Both providers failed. Gemini: ${geminiError.message} | Groq: ${groqError.message}`
      );
    }
  }
}
