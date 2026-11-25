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
const OPENCODE_GO_API_KEY = (process.env.OPENCODE_GO_API_KEY || "").trim();
const OPENCODE_GO_VISION_MODEL = (process.env.OPENCODE_GO_VISION_MODEL || "gemini-4-argon").trim();

const IMAGE_ANALYSIS_MODEL = (
  process.env.IMAGE_ANALYSIS_MODEL ||
  process.env.SUPPORT_AI_MODEL ||
  "claude-haiku-4-5-20251001"
).trim();

const GEMINI_IMAGE_MODEL = (
  process.env.GEMINI_IMAGE_MODEL ||
  process.env.GEMINI_MODEL ||
  // Google retires dated Gemini models for new keys ("no longer available to
  // new users"), so keep a list and use whichever answers.
  "gemini-flash-lite-latest"
).trim();

// Free-tier capacity moves around, so a single model name is a single point of
// failure: the alias can 503 during a demand spike, a pinned version can be
// retired for new keys, and popular models can hit per-model quota.
//
// Measured 2026-11-25 against a real 1m XAUUSD screenshot (same prompt the
// scanner sends):
//   gemini-flash-lite-latest  3.4s  correct pair, full JSON
//   gemini-3.5-flash-lite     5.5s  correct pair, full JSON
//   gemini-3.6-flash         20s+  never finished (this was the head of the
//                                  list, which is why every upload timed out)
//   gemini-3.8-flash          503  overloaded
// So the lite models lead: they read the chart correctly and answer in a
// third of the time. The flagships stay behind them for the day the lite
// models are the ones under load.
const GEMINI_IMAGE_MODELS = [
  ...new Set(
    GEMINI_IMAGE_MODEL.split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .concat([
        "gemini-flash-lite-latest",
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
        "gemini-flash-latest",
        "gemini-3.8-flash",
        "gemini-3.5-flash"
      ])
  )
];

const BIASES = ["Bullish", "Bearish", "Neutral / Ranging"];

// The app speaks M1/H1/D1; the image prompt speaks 1m/1H/1D. Lower-casing the
// app code ("M1" -> "m1") is not the same string, so the prompt used to tell
// the model "the m1 (m1) timeframe" instead of "1 minute (1m)".
const PROMPT_TIMEFRAMES = {
  M1: "1m", M5: "5m", M15: "15m", M30: "30m",
  H1: "1H", H4: "4H", D1: "1D", W1: "1W"
};
function promptTimeframe(timeframe) {
  const code = String(timeframe || "").trim().toUpperCase();
  return PROMPT_TIMEFRAMES[code] || String(timeframe || "").toLowerCase();
}

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

// Decimals to print a price with: follow whatever the model's entry used
// ("2420.50" -> 2), otherwise pick something sensible for the instrument size.
function decimalsOf(sample, fallbackPrice) {
  const m = String(sample == null ? "" : sample).match(/\.(\d+)/);
  if (m) return Math.min(5, m[1].length);
  return fallbackPrice >= 100 ? 2 : fallbackPrice >= 10 ? 3 : 4;
}

// The visible price window from the model's axis calibration. Used to size a
// sane stop buffer and to reject anchors that are clearly misreads.
function visibleRange(scale) {
  if (!scale || typeof scale !== "object") return null;
  let prices = [];
  if (Array.isArray(scale.labels)) {
    for (const l of scale.labels) {
      const p = Number(l?.price);
      if (Number.isFinite(p) && p > 0) prices.push(p);
    }
  }
  if (prices.length < 2) {
    const tp = Number(scale.top_price);
    const bp = Number(scale.bottom_price);
    if (Number.isFinite(tp) && Number.isFinite(bp) && tp !== bp) prices.push(tp, bp);
  }
  if (prices.length < 2) return null;

  // One misread label (a stray digit, a different instrument's scale) would
  // inflate the range and blow out the stop buffer, so keep only labels that
  // sit near the median price.
  if (prices.length >= 3) {
    const sorted = prices.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const keep = prices.filter((p) => Math.abs(p - median) / median < 0.2);
    if (keep.length >= 2) prices = keep;
  }

  const hi = Math.max(...prices);
  const lo = Math.min(...prices);
  return hi > lo ? { hi, lo, span: hi - lo } : null;
}

// Where would a careful SMC trader actually put the stop? Behind the nearest
// structure that would invalidate the idea — the order block / FVG / swept
// level the entry is based on — plus a small buffer for wick noise and spread.
// A stop that sits inside that zone gets picked off by normal market noise, so
// when the model puts it tighter than the protecting structure we widen it to
// just beyond that structure and recompute the R:R. Everything is skipped when
// the axis or the entry isn't readable.
function refineStopLoss(result) {
  const first = Array.isArray(result.potential_entries) ? result.potential_entries[0] : null;
  if (!first) return;

  const isLong = String(first.type || "").toLowerCase() !== "short";
  const entryPrice = parsePrice(first.entry_zone);
  if (entryPrice == null) return;

  const currentStop = parsePrice(result.stop_loss?.suggestion);
  const currentValid = currentStop != null && (isLong ? currentStop < entryPrice : currentStop > entryPrice);
  const range = visibleRange(result.concepts_scale);
  const buffer = Math.max(entryPrice * 0.0008, range ? range.span * 0.03 : 0);

  const anchors = [];
  const add = (price, label) => {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return;
    if (isLong ? p >= entryPrice : p <= entryPrice) return;
    if (Math.abs(p - entryPrice) > entryPrice * 0.25) return;
    anchors.push({ price: p, label });
  };

  const concepts = result.concepts_data || {};
  for (const ob of Array.isArray(concepts.order_blocks) ? concepts.order_blocks : []) {
    add(isLong ? ob?.bottom_price : ob?.top_price,
        ob?.bias === "bearish" ? "bearish order block" : "bullish order block");
  }
  for (const f of Array.isArray(concepts.fvgs) ? concepts.fvgs : []) {
    add(isLong ? f?.bottom_price : f?.top_price, "fair value gap");
  }
  for (const s of Array.isArray(concepts.liquidity_sweeps) ? concepts.liquidity_sweeps : []) {
    add(s?.price, s?.side === "buy-side" ? "buy-side sweep" : "sell-side sweep");
  }
  const keyLevels = result.market_structure?.key_levels;
  for (const lvl of Array.isArray(keyLevels) ? keyLevels : []) {
    add(parsePrice(lvl), "key level");
  }

  anchors.sort((a, b) => (isLong ? b.price - a.price : a.price - b.price));
  const anchor = anchors[0] || null;

  let nextStop = currentStop;
  let moved = false;

  if (anchor) {
    const structural = isLong ? anchor.price - buffer : anchor.price + buffer;
    const usable = isLong ? structural < entryPrice : structural > entryPrice;
    if (usable) {
      if (!currentValid) {
        nextStop = structural;
        moved = true;
      } else if (isLong ? currentStop > structural : currentStop < structural) {
        // The model's stop sits on the near side of the protecting structure.
        nextStop = structural;
        moved = true;
      }
    }
  }

  if (!moved || nextStop == null) return;

  // Never let risk balloon relative to what's actually on screen.
  if (range) {
    const maxRisk = range.span * 0.6;
    if (isLong && entryPrice - nextStop > maxRisk) nextStop = entryPrice - maxRisk;
    if (!isLong && nextStop - entryPrice > maxRisk) nextStop = entryPrice + maxRisk;
  }
  if (isLong ? nextStop >= entryPrice : nextStop <= entryPrice) return;

  const decimals = decimalsOf(first.entry_zone, entryPrice);
  result.stop_loss = {
    suggestion: nextStop.toFixed(decimals),
    rationale: anchor
      ? `Just beyond the nearest ${anchor.label} (${anchor.price.toFixed(decimals)}) with a small buffer, so normal wicks and spread don't take you out before the idea plays out.${result.stop_loss?.rationale ? " " + result.stop_loss.rationale : ""}`
      : (result.stop_loss?.rationale || "")
  };

  // Keep the drawn stop line on the marked-up image in sync with the text.
  const plan = Array.isArray(result.plan_levels) ? result.plan_levels : [];
  const stopRow = plan.find((row) => row.kind === "stop");
  if (stopRow) stopRow.price = nextStop;
  else plan.push({ kind: "stop", price: nextStop, label: "Stop" });
  result.plan_levels = plan;

  // A moved stop changes the R:R, so recompute it against the furthest target.
  const targets = (Array.isArray(result.take_profit) ? result.take_profit : [])
    .map((t) => parsePrice(t?.target))
    .filter((n) => n != null);
  if (targets.length) {
    const reward = isLong ? Math.max(...targets) - entryPrice : entryPrice - Math.min(...targets);
    const risk = Math.abs(entryPrice - nextStop);
    if (reward > 0 && risk > 0) {
      result.risk_reward_estimate = `~1:${Math.round((reward / risk) * 10) / 10}`;
    }
  }
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

  const result = {
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

  refineStopLoss(result);
  return result;
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
              { type: "text", text: buildUserPrompt(promptTimeframe(timeframe)) }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(20000)
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
          { text: buildUserPrompt(promptTimeframe(timeframe)) }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      // Output tokens are time: every extra field the model writes is latency
      // the trader watches. 2048 was sized for "be thorough"; 1600 is enough
      // for the full shape and measurably faster.
      maxOutputTokens: 1600,
      responseMimeType: "application/json"
    }
  });

  let lastFailure = null;
  const startedAt = Date.now();
  // A scan has to feel instant, not thorough. King's rule: around ten seconds,
  // never past twenty. So the whole model walk gets a hard 15s budget — the
  // browser gives up at 20s, so a slow model must never be allowed to burn the
  // whole window — and each attempt a smaller slice of it. A 1400px chart
  // answers in 3-7s on a lite model when the free tier is healthy, so this only
  // bites when something is actually wrong. 12s was too tight: one lite-model
  // hiccup plus two retries ran out of clock and the user got "took too long"
  // even though the very next attempt worked.
  const OVERALL_BUDGET_MS = 15000;
  const ATTEMPT_TIMEOUT_MS = 8000;

  for (const model of GEMINI_IMAGE_MODELS) {
    const remaining = OVERALL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < 1500) break;
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
        signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining))
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
        // A model can answer 200 and still hand back something that isn't the
        // JSON object the app renders (truncated, prose, a stray brace). That
        // used to end the scan with "couldn't read that screenshot" even though
        // the next model would have answered fine. Validate here so a bad read
        // is just another retry.
        try {
          parseJsonObject(text);
          console.log(`Image analysis answered by gemini/${model} in ${Date.now() - startedAt}ms`);
          return text;
        } catch {
          console.error(`Image analysis: gemini/${model} answered without valid JSON, trying next model`);
          lastFailure = { kind: "json", status: response.status, data };
          continue;
        }
      }
      lastFailure = { kind: "empty", status: response.status, data };
      continue;
    }

    console.error("Image analysis error (gemini/" + model + "):", response.status, data);

    // A retired or overloaded model is worth retrying on the next name.
    // Quota (429) is not: every model shares the same daily cap, so retrying
    // only makes the user wait. Fail fast with the "use pair scanner" copy.
    const retryable = response.status === 404 || response.status === 503;
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

async function callOpenCodeGoVision({ buffer, mimeType, timeframe, apiKey }) {
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
          { text: buildUserPrompt(promptTimeframe(timeframe)) }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1600,
      responseMimeType: "application/json"
    }
  });
  let response;
  try {
    response = await fetch(
      "https://opencode.ai/inference/go/google/v1beta/models/" +
        encodeURIComponent(OPENCODE_GO_VISION_MODEL) +
        ":generateContent",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          "x-opencode-session": "vertex-vision-" + Date.now()
        },
        body,
        signal: AbortSignal.timeout(12000)
      }
    );
  } catch (err) {
    const e = new Error("The image reader took too long or could not be reached. Please try again.");
    e.status = 502;
    e.cause = err;
    throw e;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    console.error("Image analysis error (opencode-go):", response.status, data);
    throw visionError("opencode-go", response.status, data);
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("") : "";
  if (!text.trim()) throw new Error("OpenCode Go vision returned an empty read.");
  return text;
}

async function analyzeChartImage({ buffer, mimeType, timeframe, apiKey, geminiKey }) {
  const anthropicKey = String(apiKey || "").trim();
  const googleKey = String(geminiKey || "").trim();
  const goKey = String(OPENCODE_GO_API_KEY || "").trim();

  if (!goKey && !googleKey && !anthropicKey) {
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

  let text = null;
  let goFailure = null;
  if (goKey) {
    try {
      text = await callOpenCodeGoVision({
        buffer: shrunk.buffer,
        mimeType: shrunk.mimeType,
        timeframe,
        apiKey: goKey
      });
    } catch (err) {
      goFailure = err;
      console.error("OpenCode Go vision failed, falling back:", err.message);
    }
  }
  if (!text) {
    if (googleKey) {
      text = await callGeminiVision({ buffer: shrunk.buffer, mimeType: shrunk.mimeType, timeframe, apiKey: googleKey });
    } else if (anthropicKey) {
      text = await callAnthropicVision({ buffer: shrunk.buffer, mimeType: shrunk.mimeType, timeframe, apiKey: anthropicKey });
    } else {
      throw goFailure || new Error("No vision provider answered.");
    }
  }

  let payload;
  try {
    payload = parseJsonObject(text);
  } catch (err) {
    const e = new Error("The image reader couldn't read that screenshot. Use Pick a pair for an instant read, or try a clearer screenshot.");
    e.status = 502;
    throw e;
  }

  const isChart = payload.is_chart !== false;
  return { isChart, analysis: mapImageAnalysis(payload, timeframe) };
}

// One decode for the whole request. A phone screenshot can be 4000px wide, and
// every separate sharp() call on the original decodes it again — roughly 48 MB
// of raw pixels each time. Downscaling once here and handing the same buffer to
// both the model and the annotator keeps a single scan from holding three
// full-size bitmaps at the same moment, which is what pushes this 512 MB
// instance into an out-of-memory restart.
const PREPARE_MAX_WIDTH = 1800;
async function prepareImage(buffer, mimeType) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || meta.width <= PREPARE_MAX_WIDTH) return { buffer, mimeType };
    const out = await sharp(buffer)
      .rotate()
      .resize({ width: PREPARE_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { buffer: out, mimeType: "image/jpeg" };
  } catch (err) {
    console.error("Could not prepare the chart image, using it as uploaded:", err.message);
    return { buffer, mimeType };
  }
}

module.exports = { analyzeChartImage, mapImageAnalysis, prepareImage };
