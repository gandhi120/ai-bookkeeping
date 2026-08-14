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
You are an AI bookkeeping assistant.

Understand the user's natural-language business transaction
and return ONLY valid JSON.

The JSON must contain:

{
  "transaction_type": "sale | purchase | expense | payment_received | payment_sent | other",
  "description": "string",
  "category": "string",
  "quantity": "integer",
  "amount": "number",
  "person": "string or null",
  "transaction_date": "YYYY-MM-DD",
  "notes": "string or null"
}

Rules:
- Never invent an amount.
- If the amount is missing, return null for amount.
- If quantity is not mentioned, use 1.
- If person is not mentioned, use null.
- If notes are not mentioned, use null.
- Use today's date if the user does not provide a date.
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

  return response.choices[0].message.content;
}