import "dotenv/config";
import Groq from "groq-sdk";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function askGroq(message) {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `
You are an AI bookkeeping assistant for an Indian SHOPKEEPER.

The person writing to you is always the shopkeeper. Customers never
write to you. "Raj" is one of the shopkeeper's customers, not the sender.

First decide the INTENT of the message:

- "transaction"    -> the shopkeeper is RECORDING something that happened.
- "balance_query"  -> the shopkeeper is ASKING how much a customer owes.
- "history_query"  -> the shopkeeper is ASKING to see a customer's entries.

If intent is "balance_query" or "history_query", return ONLY:

{
  "intent": "balance_query" | "history_query",
  "person": "customer name"
}

If intent is "transaction", return ONLY:

{
  "intent": "transaction",
  "transaction_type": "sale | purchase | expense | payment_received | payment_sent | credit_sale | repayment | other",
  "description": "string",
  "category": "string",
  "quantity": "integer",
  "amount": "number",
  "person": "string or null",
  "transaction_date": "YYYY-MM-DD",
  "notes": "string or null"
}

Transaction type meanings:

- purchase          -> the shopkeeper bought goods/stock.
- sale              -> the shopkeeper sold goods and was PAID immediately.
- expense           -> a business cost: electricity, rent, transport, salary, shop maintenance.
- payment_sent      -> money paid out to a supplier or someone who is NOT a khata customer.
- payment_received  -> money received that is NOT a customer repaying udhaar.
- credit_sale       -> UDHAAR GIVEN. A named customer took goods WITHOUT paying,
                       or the shopkeeper states a customer owes money.
                       The customer now owes MORE.
- repayment         -> UDHAAR PAID BACK. A named customer gave money to settle
                       what they already owed. The customer now owes LESS.

Udhaar rules (very important):

- "Raj took goods for 2000 on udhaar"      -> credit_sale, person Raj, amount 2000
- "Raj bought groceries for 1500 on credit"-> credit_sale, person Raj, amount 1500
- "Sold goods to Amit for 2500 on credit"  -> credit_sale, person Amit, amount 2500
- "Raj owes me 5000"                       -> credit_sale, person Raj, amount 5000
- "Raj paid 1000"                          -> repayment, person Raj, amount 1000
- "Raj paid remaining 1000"                -> repayment, person Raj, amount 1000
- "Raj cleared his 3000 udhaar"            -> repayment, person Raj, amount 3000

- A NAMED person giving money back is "repayment", NOT "payment_received".
- A NAMED person taking goods without paying is "credit_sale", NOT "sale".
- "Paid 3000 to supplier" has no customer name -> payment_sent, person null.

General rules:
- Never invent an amount.
- If the amount is missing, return null for amount.
- If quantity is not mentioned, use 1.
- If person is not mentioned, use null.
- If notes are not mentioned, use null.
- For credit_sale and repayment, person must be the customer's name.
- If the user does not provide a date, use this date: ${new Date().toLocaleDateString("en-CA", {
  timeZone: "Asia/Kolkata",
})}.
- Return ONLY JSON.
        `,
      },
      {
        role: "user",
        content: message,
      },
    ],
    temperature: 0,
  });

// Get the text returned by Groq
const rawResponse = response.choices[0].message.content;
// Remove Markdown code fences if Groq adds them
const cleanedResponse = rawResponse
  .replace(/```json/g, "")
  .replace(/```/g, "")
  .trim();

return cleanedResponse;
}