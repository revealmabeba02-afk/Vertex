// One text engine for every AI feature that isn't chart vision.
//
// Vertex had five separate copies of the same Anthropic fetch: support
// triage, feedback acknowledgements, scan explanation, the admin briefing,
// the two Q2 insight reports and the Q2 chat itself. When the Anthropic
// balance hit zero, all of them went quiet at once — the product was
// advertising an assistant that could not answer.
//
// This module makes provider a detail, not a feature. Gemini (free tier) is
// tried first; Anthropic is used only if Gemini is unavailable. Callers get
// the same thing they always got: a string, or null if nothing could answer.
//
// The Gemini model list is a fallback chain for the same reason as vision:
// Google retires dated models for new keys and the alias 503s under load.

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const OPENCODE_GO_API_KEY = (process.env.OPENCODE_GO_API_KEY || "").trim();
const OPENCODE_GO_MODEL = (process.env.OPENCODE_GO_MODEL || "deepseek-v4.1-flash").trim();

const GEMINI_MODEL = (
  process.env.GEMINI_MODEL ||
  process.env.GEMINI_TEXT_MODEL ||
  // Leading with the currently-healthy model rather than the flagship — an
  // overloaded flagship 503s slowly and burns the caller's patience before
  // the first model that actually answers. Same reasoning as imageAnalysis.
  "gemini-3.6-flash"
).trim();

const GEMINI_MODELS = [
  ...new Set(
    GEMINI_MODEL.split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .concat([
        "gemini-3.6-flash",
        "gemini-3.8-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-flash-lite-latest",
        "gemini-flash-latest"
      ])
  )
];

const ANTHROPIC_MODEL = (
  process.env.SUPPORT_AI_MODEL ||
  "claude-haiku-4-5-20251001"
).trim();

function hasProvider() {
  return !!(OPENCODE_GO_API_KEY || GEMINI_API_KEY || ANTHROPIC_API_KEY);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role === "assistant" || m.role === "model" ? "assistant" : "user", content: m.content }));
}

async function callGemini({ system, messages, maxTokens, temperature, timeoutMs }) {
  const contents = normalizeMessages(messages).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  const body = JSON.stringify({
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens
    }
  });

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent";
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    const data = await res.json().catch(() => null);
    if (res.ok) {
      const parts = data?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("").trim() : "";
      if (text) return text;
      lastError = new Error("Gemini returned an empty reply.");
      continue;
    }
    console.error("AI text error (gemini/" + model + "):", res.status, data?.error?.message || data);
    if (res.status === 404 || res.status === 429 || res.status === 503) {
      lastError = new Error("Gemini " + res.status);
      continue;
    }
    throw new Error(data?.error?.message || "Gemini error " + res.status);
  }
  throw lastError || new Error("No Gemini model answered.");
}

async function callOpenCodeGo({ system, messages, maxTokens, temperature, timeoutMs }) {
  const res = await fetch("https://opencode.ai/inference/go/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + OPENCODE_GO_API_KEY,
      "Content-Type": "application/json",
      "x-opencode-session": "vertex-ai-" + Date.now()
    },
    body: JSON.stringify({
      model: OPENCODE_GO_MODEL,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...normalizeMessages(messages)
      ],
      max_tokens: maxTokens,
      temperature
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || "OpenCode Go error " + res.status);
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error("OpenCode Go returned an empty reply.");
  return text.trim();
}

async function callAnthropic({ system, messages, maxTokens, temperature, timeoutMs }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: normalizeMessages(messages).map((m) => ({ role: m.role, content: m.content }))
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || "Anthropic error " + res.status);
  }
  const text = Array.isArray(data.content) ? data.content.map((b) => b.text || "").join("").trim() : "";
  if (!text) throw new Error("Anthropic returned an empty reply.");
  return text;
}

/**
 * Generate text from whichever provider is configured and willing.
 *
 * @param {object} opts
 * @param {string} [opts.system]      system instructions
 * @param {Array}  opts.messages      [{role:'user'|'assistant', content}]
 * @param {string} [opts.prompt]      shorthand for a single user message
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{text: string, provider: 'gemini'|'anthropic'}>}
 */
async function generateText(opts = {}) {
  const messages = opts.messages || (opts.prompt ? [{ role: "user", content: opts.prompt }] : []);
  if (!messages.length) throw new Error("generateText needs at least one message.");
  const settings = {
    system: opts.system || "",
    messages,
    maxTokens: opts.maxTokens || 400,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.4,
    timeoutMs: opts.timeoutMs || 25000
  };

  const attempts = [];
  if (OPENCODE_GO_API_KEY) {
    try {
      return { text: await callOpenCodeGo(settings), provider: "opencode-go" };
    } catch (err) {
      attempts.push("opencode-go: " + err.message);
    }
  }
  if (GEMINI_API_KEY) {
    try {
      return { text: await callGemini(settings), provider: "gemini" };
    } catch (err) {
      attempts.push("gemini: " + err.message);
    }
  }
  if (ANTHROPIC_API_KEY) {
    try {
      return { text: await callAnthropic(settings), provider: "anthropic" };
    } catch (err) {
      attempts.push("anthropic: " + err.message);
    }
  }
  throw new Error(
    attempts.length
      ? "No AI provider answered (" + attempts.join(" | ") + ")"
      : "No AI provider is configured."
  );
}

module.exports = { generateText, hasProvider, GEMINI_MODELS };
