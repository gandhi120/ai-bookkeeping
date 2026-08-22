// The gym module's OWN model call.
//
// This deliberately duplicates the Gemini-then-Groq fallback that
// src/ai/groq.service.js already has, instead of importing it or refactoring
// it into something shared. That is a blast-radius decision, not an oversight:
// the bookkeeping path is deployed and holds somebody's shop accounts, and a
// gym check-in is a personal log. A shared helper means a change made for one
// can break the other, and the two are nowhere near equal in consequence.
//
// It is also smaller than the original, because it needs less: no ledger name,
// no per-message context, no SDK. Both providers are plain REST — Groq speaks
// the OpenAI shape, so `fetch` covers both and the gym module adds no
// dependency of its own.
//
// Model IDs are pinned for the reason CLAUDE.md gives: providers RETIRE
// models. `llama-3.3-70b-versatile` 404'd exactly this way.

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Either provider can wrap its JSON in a markdown code fence.
function stripCodeFences(text) {
  return text.replace(/```json/g, "").replace(/```/g, "").trim();
}

async function askGemini(message, systemPrompt) {
  // `||` not `??`: an unset key in .env reads as "" rather than undefined, and
  // "" would build a URL with no model name in it.
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

  const response = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Gemini ${response.status}: ${(await response.text()).slice(0, 200)}`
    );
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error(
      `Gemini returned no content: ${JSON.stringify(data).slice(0, 200)}`
    );
  }

  return stripCodeFences(text);
}

async function askGroq(message, systemPrompt) {
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Groq ${response.status}: ${(await response.text()).slice(0, 200)}`
    );
  }

  const data = await response.json();

  return stripCodeFences(data?.choices?.[0]?.message?.content ?? "");
}

// Gemini leads because its limit is per-MINUTE (recovers in a minute) while
// Groq's is per-DAY. Without GEMINI_API_KEY this calls Groq directly.
export async function askGym(message, systemPrompt) {
  if (!process.env.GEMINI_API_KEY) {
    return await askGroq(message, systemPrompt);
  }

  try {
    return await askGemini(message, systemPrompt);
  } catch (geminiError) {
    console.warn("[gym] Gemini failed, falling back to Groq:", geminiError.message);

    try {
      return await askGroq(message, systemPrompt);
    } catch (groqError) {
      // Surface both, otherwise a Gemini key typo looks like a Groq outage.
      throw new Error(
        `Both providers failed. Gemini: ${geminiError.message} | Groq: ${groqError.message}`
      );
    }
  }
}
