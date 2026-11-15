// Chart-screenshot analysis: sends an uploaded image to Claude's vision model
// and shapes the reply into exactly the object the scanner result screen
// already renders (pair_guess, market_bias, market_structure, potential_entries,
// stop_loss, take_profit, confidence, ...).
//
// FXSynapse (the pair scanner) only reads symbols from live bars, so image
// reading is the one feature that needs a vision model. It shares the same
// ANTHROPIC_API_KEY as Q2 / support triage. When that key is absent the route
// answers 503 before spending anything, and the pair scanner is unaffected.

const { buildSystemPrompt, buildUserPrompt } = require("./analysisPrompt");

const IMAGE_ANALYSIS_MODEL = (
  process.env.IMAGE_ANALYSIS_MODEL ||
  process.env.SUPPORT_AI_MODEL ||
  "claude-haiku-4-5-20251001"
).trim();

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
    source: "image",
    timeframe
  };
}

async function analyzeChartImage({ buffer, mimeType, timeframe, apiKey }) {
  if (!apiKey) {
    const err = new Error("Image analysis is not configured on this server.");
    err.status = 503;
    throw err;
  }
  if (!buffer || !buffer.length) {
    const err = new Error("The uploaded image was empty.");
    err.status = 400;
    throw err;
  }

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
    console.error("Image analysis error:", response.status, data);
    const e = new Error(
      response.status === 401 || response.status === 403
        ? "The image reader is not authorized right now. Please try the pair scanner, or contact support."
        : response.status === 429
        ? "The image reader is rate limited. Please try again shortly."
        : (data && (data.error?.message || data.message)) || "The image reader could not analyze that chart."
    );
    e.status = 502;
    throw e;
  }

  const text = Array.isArray(data?.content)
    ? data.content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("")
    : "";

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
