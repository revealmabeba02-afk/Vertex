// Chart-screenshot analysis: sends an uploaded image to a vision model and
// shapes the reply into exactly the object the scanner result screen already
// renders (pair_guess, market_bias, market_structure, potential_entries,
// stop_loss, take_profit, confidence, ...).
//
// Two providers are supported so the feature keeps working when one of them
// has no credit:
//   • GEMINI_API_KEY    → Google Gemini (free tier covers images)
//   • ANTHROPIC_API_KEY → Claude vision
// Gemini wins when both are configured, because its free tier means chart
// uploads never stop working just because a card ran dry. FXSynapse (the pair
// scanner) only reads symbols from live bars, so image reading is the one
// feature that needs a vision model; when neither key is present the route
// answers 503 before spending anything, and the pair scanner is unaffected.

const sharp = require("sharp");
const { buildSystemPrompt, buildUserPrompt } = require("./analysisPrompt");

const IMAGE_ANALYSIS_MODEL = (
  process.env.IMAGE_ANALYSIS_MODEL ||
  process.env.SUPPORT_AI_MODEL ||
  "claude-haiku-4-5-20251001"
).trim();

const GEMINI_IMAGE_MODEL = (
  process.env.GEMINI_IMAGE_MODEL ||
  process.env.GEMINI_MODEL ||
  // Google retires dated Gemini models for new keys ("no longer available to
  // new users"), so keep a list and use whichever answers. Leading with the
  // currently-healthy model rather than the flagship: a 503 from an
  // overloaded flagship costs ~10-20s of dead time before the first model
  // that actually answers.
  "gemini-3.6-flash"
).trim();

// Free-tier capacity moves around, so a single model name is a single point of
// failure: the alias can 503 during a demand spike, a pinned version can be
// retired for new keys, and popular models can hit per-model quota. Live
// tested 2026-11-18: 3.6-flash answered fast, 3.8-flash and the aliases were
// 503/429 at that moment, the 2.5 models are retired for new keys. Order is
// quality-first among the models that actually answer, with the litest
// models last as the near-always-available fallback.
const GEMINI_IMAGE_MODELS = [
  ...new Set(
    GEMINI_IMAGE_MODEL.split(",")
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

const BIASES = ["Bullish", "Bearish", "Neutral / Ranging"];

// The app speaks M1/H1/D1; the image prompt speaks 1m/1H/1D.
const PROMPT_TIMEFRAMES = {
  M1: "1m", M5: "5m", M15: "15m", M30: "30m",
  H1: "1H", H4: "4H", D1: "1D", W1: "1W"
};

function pickConfidence(label) {
  switch (String(label || "").toLowerCase()) {
    case "high": return { score: 85, label: "High" };
    case "low": return { score: 46, label: "Low" };
    default: return { score: 66, label: "Medium" };
  }
}

// Claude is instructed to return bare JSON, but models occasionally wrap it in
// a fence anyway. Pull out the outermost object rather than trusting the text.
function parseJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The image model did not return readable JSON.");
  return JSON.parse(raw.slice(start, end + 1));
}

function parsePrice(value) {
  const m = String(value == null ? "" : value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Every image scan already returns entry / stop / targets / key levels as
// text. Pull the numbers out so the annotator can draw the trade plan onto
// the screenshot even when the model reports no smart-money concepts.
function buildPlanLevels(payload) {
  const rows = [];
  const push = (kind, price, label) => {
    if (price != null) rows.push({ kind, price, label });
  };

  const entry = Array.isArray(payload.potential_entries) ? payload.potential_entries[0] : null;
  if (entry) {
    const side = String(entry.type || "").toLowerCase() === "short" ? "SELL" : "BUY";
    push("entry", parsePrice(entry.entry_zone), `Entry ${side}`);
  }
  push("stop", parsePrice(payload.stop_loss?.suggestion), "Stop");
  (Array.isArray(payload.take_profit) ? payload.take_profit : []).slice(0, 3).forEach((t, i) => {
    push("target", parsePrice(t?.target), `TP${i + 1}`);
  });
  const levels = payload.market_structure?.key_levels;
  (Array.isArray(levels) ? levels : []).slice(0, 4).forEach((lvl) => {
    const label = String(lvl).replace(/^\s*(immediate|major|minor)?\s*(resistance|support)?[:\-–]?\s*/i, "").slice(0, 18) || "Level";
    push("level", parsePrice(lvl), label);
  });

  return rows;
}

function mapImageAnalysis(payload, timeframe) {
  const bias = BIASES.includes(payload.market_bias) ? payload.market_bias : "Neutral / Ranging";
  const confidence = pickConfidence(payload.confidence);

  const structure = payload.market_structure || {};
  const keyLevels = Array.isArray(structure.key_levels)
    ? structure.key_levels.map((l) => String(l)).slice(0, 6)
    : [];

  const entries = Array.isArray(payload.potential_entries)
    ? payload.potential_entries.map((e) => ({
        type: String(e?.type || "").toLowerCase() === "short" ? "Short" : "Long",
        entry_zone: e?.entry_zone ? String(e.entry_zone) : "—",
        trigger: e?.trigger ? String(e.trigger) : "",
        rationale: e?.rationale ? String(e.rationale) : ""
      }))
    : [];

  const targets = Array.isArray(payload.take_profit)
    ? payload.take_profit.map((t, i) => ({
        target: t?.target ? String(t.target) : "—",
        rationale: t?.rationale ? String(t.rationale) : `Target ${i + 1}`
      }))
    : [];

  const notesParts = [];
  if (payload.notes) notesParts.push(String(payload.notes));
  notesParts.push("Read from a static screenshot, so levels may be approximate if the price axis was hard to read.");

  // Smart-money concepts the model saw in the screenshot. `concepts_data`
  // keeps the raw percent positions for the image annotator; `concepts`
  // turns the same rows into the human lines the result card lists.
  const detected = payload.concepts_detected || {};
  const detectedScale = payload.price_scale && typeof payload.price_scale === "object" ? payload.price_scale : null;
  const conceptsData = {};
  const conceptLines = {};
  const addLine = (key, line) => {
    (conceptLines[key] = conceptLines[key] || []).push(line);
  };
  const cap = (key) => (conceptLines[key] || []).length < 3;

  for (const ob of Array.isArray(detected.order_blocks) ? detected.order_blocks : []) {
    if (!cap("order_blocks")) break;
    conceptsData.order_blocks = conceptsData.order_blocks || [];
    conceptsData.order_blocks.push(ob);
    addLine("order_blocks", `${ob?.bias === "bearish" ? "Bearish" : "Bullish"} order block${ob?.note ? " — " + ob.note : ""}`);
  }
  for (const f of Array.isArray(detected.fvgs) ? detected.fvgs : []) {
    if (!cap("fvgs")) break;
    conceptsData.fvgs = conceptsData.fvgs || [];
    conceptsData.fvgs.push(f);
    addLine("fvgs", `${f?.filled ? "Filled" : "Open"} fair value gap${f?.note ? " — " + f.note : ""}`);
  }
  for (const s of Array.isArray(detected.liquidity_sweeps) ? detected.liquidity_sweeps : []) {
    if (!cap("liquidity_sweeps")) break;
    conceptsData.liquidity_sweeps = conceptsData.liquidity_sweeps || [];
    conceptsData.liquidity_sweeps.push(s);
    addLine("liquidity_sweeps", `${s?.side === "buy-side" ? "Buy-side" : "Sell-side"} liquidity sweep${s?.note ? " — " + s.note : ""}`);
  }
  for (const b of Array.isArray(detected.breaks) ? detected.breaks : []) {
    if (!cap("breaks")) break;
    conceptsData.breaks = conceptsData.breaks || [];
    conceptsData.breaks.push(b);
    addLine("breaks", `${String(b?.kind || "Break").toUpperCase()} ${b?.direction || ""}${b?.note ? " — " + b.note : ""}`.replace(/\s+/g, " "));
  }

  const concepts = {};
  for (const [key, lines] of Object.entries(conceptLines)) {
    if (lines.length) concepts[key] = lines;
  }

  return {
    pair_guess: payload.pair_guess ? String(payload.pair_guess).toUpperCase() : null,
    market_bias: bias,
    confidence: confidence.score,
    confidence_breakdown: [
      { label: "Read from your chart image", delta: confidence.score - 50 },
      { label: `Model confidence: ${confidence.label}`, delta: 0 }
    ],
    bars: null,
    digits: null,
    candles: [],
    market_structure: {
      trend: structure.trend ? String(structure.trend) : "Structure not clear from this screenshot.",
      key_levels: keyLevels,
      chart_pattern: structure.chart_pattern ? String(structure.chart_pattern) : null
    },
    potential_entries: entries,
    stop_loss: {
      suggestion: payload.stop_loss?.suggestion ? String(payload.stop_loss.suggestion) : "—",
      rationale: payload.stop_loss?.rationale ? String(payload.stop_loss.rationale) : ""
    },
    take_profit: targets,
    risk_reward_estimate: payload.risk_reward_estimate ? String(payload.risk_reward_estimate) : null,
    invalidation: payload.invalidation ? String(payload.invalidation) : "",
    notes: notesParts.join(" "),
    disclaimer: payload.disclaimer
      ? String(payload.disclaimer)
      : "Technical/educational analysis of a static screenshot, not financial advice. Confirm with your own analysis and risk management.",
    top_down: [],
    concepts,
    concepts_data: conceptsData,
    concepts_scale: detectedScale,
    plan_levels: buildPlanLevels(payload),
    source: "image",
    timeframe
  };
}

// One place to turn a provider's HTTP failure into something a trader can act
// on. "Out of credit" and "daily free limit" are the two states this app has
// actually hit in production, so they get explicit copy instead of a raw
// vendor string.
function visionError(provider, status, data) {
  const message = String(
    (data && (data.error?.message || data.message)) || ""
  ).trim();
  const isCredit = /credit balance is too low|purchase credits|billing/i.test(message);
  const isQuota = /quota|rate limit|exceeded/i.test(message);

  let text;
  if (status === 401 || status === 403) {
    text = "The image reader is not authorized right now. Please try the pair scanner, or contact support.";
  } else if (isCredit) {
    text = "The chart-photo reader is out of credit. Use the pair scanner for now, or add credit to the image provider.";
  } else if (status === 429 || isQuota) {
    text = provider === "gemini"
      ? "The free image reader has hit its limit for now. Use the pair scanner, or try again later."
      : "The image reader is rate limited. Please try again shortly.";
  } else {
    text = message || "The image reader could not analyze that chart.";
  }

  const e = new Error(text);
  e.status = 502;
  return e;
}

async function callAnthropicVision({ buffer, mimeType, timeframe, apiKey }) {
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: IMAGE_ANALYSIS_MODEL,
        max_tokens: 1800,
        system: buildSystemPrompt(),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType || "image/png",
                  data: buffer.toString("base64")
                }
              },
              { type: "text", text: buildUserPrompt(String(timeframe || "").toLowerCase()) }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(52000)
    });
  } catch (err) {
    const e = new Error("The image reader took too long or could not be reached. Please try again.");
    e.status = 502;
    e.cause = err;
    throw e;
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    console.error("Image analysis error (anthropic):", response.status, data);
    throw visionError("anthropic", response.status, data);
  }

  return Array.isArray(data?.content)
    ? data.content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("")
    : "";
}

async function callGeminiVision({ buffer, mimeType, timeframe, apiKey }) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: mimeType || "image/png",
              data: buffer.toString("base64")
            }
          },
          { text: buildUserPrompt(String(timeframe || "").toLowerCase()) }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: "application/json"
    }
  });

  let lastFailure = null;
  const startedAt = Date.now();
  // The app gives up on a scan after 75s. Google's free tier can answer a 503
  // quickly but a busy model slowly, so cap the whole fallback walk well
  // under that: better a clear "try again" than a request that dies client-
  // side with no explanation.
  const OVERALL_BUDGET_MS = 55000;

  for (const model of GEMINI_IMAGE_MODELS) {
    if (Date.now() - startedAt > OVERALL_BUDGET_MS) break;
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent";

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json"
        },
        body,
        signal: AbortSignal.timeout(52000)
      });
    } catch (err) {
      lastFailure = { kind: "network", err };
      continue;
    }

    const data = await response.json().catch(() => null);
    if (response.ok) {
      const parts = data?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("") : "";
      if (text.trim()) {
        console.log(`Image analysis answered by gemini/${model} in ${Date.now() - startedAt}ms`);
        return text;
      }
      lastFailure = { kind: "empty", status: response.status, data };
      continue;
    }

    console.error("Image analysis error (gemini/" + model + "):", response.status, data);

    // A model that is retired, overloaded or missing is worth retrying on the
    // next name in the list. Auth, credit and quota failures are not — the
    // next model would fail exactly the same way.
    const retryable = response.status === 404 || response.status === 503 || response.status === 429;
    if (!retryable) throw visionError("gemini", response.status, data);
    lastFailure = { kind: "http", status: response.status, data };
  }

  if (lastFailure && lastFailure.kind === "http") {
    throw visionError("gemini", lastFailure.status, lastFailure.data);
  }
  const e = new Error("The image reader took too long or could not be reached. Please try again.");
  e.status = 502;
  if (lastFailure && lastFailure.err) e.cause = lastFailure.err;
  throw e;
}

// A chart screenshot straight off a phone can be 6-7 MB. Sending that to the
// vision model is slow and, during a busy hour, is what pushes a scan past
// the server's 60s request ceiling. 1400px is still plenty for reading
// candles, axes and labels, and turns the request into a fraction of the
// bytes — same analysis, far faster and far more reliable.
const MODEL_IMAGE_MAX_WIDTH = 1400;
async function shrinkForModel(buffer, mimeType) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || meta.width <= MODEL_IMAGE_MAX_WIDTH) return { buffer, mimeType };
    const shrunk = await sharp(buffer)
      .rotate()
      .resize({ width: MODEL_IMAGE_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { buffer: shrunk, mimeType: "image/jpeg" };
  } catch (err) {
    console.error("Could not shrink the chart image, sending it as-is:", err.message);
    return { buffer, mimeType };
  }
}

async function analyzeChartImage({ buffer, mimeType, timeframe, apiKey, geminiKey }) {
  const anthropicKey = String(apiKey || "").trim();
  const googleKey = String(geminiKey || "").trim();

  if (!googleKey && !anthropicKey) {
    const err = new Error("Image analysis is not configured on this server.");
    err.status = 503;
    throw err;
  }
  if (!buffer || !buffer.length) {
    const err = new Error("The uploaded image was empty.");
    err.status = 400;
    throw err;
  }

  const shrunk = await shrinkForModel(buffer, mimeType);

  const text = googleKey
    ? await callGeminiVision({ buffer: shrunk.buffer, mimeType: shrunk.mimeType, timeframe, apiKey: googleKey })
    : await callAnthropicVision({ buffer: shrunk.buffer, mimeType: shrunk.mimeType, timeframe, apiKey: anthropicKey });

  let payload;
  try {
    payload = parseJsonObject(text);
  } catch (err) {
    const e = new Error("The image reader sent back something unreadable. Please try again.");
    e.status = 502;
    throw e;
  }

  const isChart = payload.is_chart !== false;
  return { isChart, analysis: mapImageAnalysis(payload, timeframe) };
}

module.exports = { analyzeChartImage, mapImageAnalysis };
