// --- FXSynapse response shaping ------------------------------------------
// The scanner's result screen expects one steady shape regardless of what
// changed upstream: { pair_guess, market_bias, market_structure, ... }. This
// turns FXSynapse's own JSON (symbol, marketStructure, levels, plan,
// concepts, topDown, ...) into that same shape, so the result UI didn't
// need to be rebuilt from scratch.
//
// Pulled out of server.js so the standalone auto-post job (video/autoPostJob.js)
// can reuse the exact same mapping without requiring the whole Express app —
// that job runs as its own separate Render Cron Job process specifically so a
// crash or memory spike there can never take down the main web service.

// FXSynapse's "digits" field tells us how many decimal places that symbol's
// own price feed actually uses (e.g. 2 for XAUUSD/indices, 5 for most forex
// majors) — using it instead of printing a float's raw length is what turns
// "51073.46785714285" into "51,073.47".
function fmtNum(n, digits) {
  if (typeof n !== "number") return n != null ? String(n) : "—";
  const places = typeof digits === "number" && digits >= 0 && digits <= 8 ? digits : 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
}

function describeLevels(levels, digits) {
  if (!Array.isArray(levels)) return [];
  return levels.slice(0, 6).map((lvl) => {
    const rej =
      lvl && lvl.rejections != null
        ? ` · ${lvl.rejections} rejection${lvl.rejections === 1 ? "" : "s"}`
        : "";
    return `${fmtNum(lvl?.low, digits)} – ${fmtNum(lvl?.high, digits)}${rej}`;
  });
}

function biasFromStructure(structure) {
  const s = (structure || "").toLowerCase();
  if (s.includes("up")) return "Bullish";
  if (s.includes("down")) return "Bearish";
  return "Neutral / Ranging";
}

function computeRR(entry, stop, target) {
  if (typeof entry !== "number" || typeof stop !== "number" || typeof target !== "number") {
    return null;
  }
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (!risk) return null;
  return `~1:${(reward / risk).toFixed(1)}`;
}

// A 0-100 read of how much the pieces of this scan agree with each other —
// not a win-rate promise, just "how aligned is the evidence". Built from
// things we actually have: whether a clean plan exists, how many higher
// timeframes agree with the call, the risk/reward on offer, and whether the
// market is actually trending vs just ranging. Clamped to 35-95 so it never
// reads as a guarantee (100%) or as "don't bother" (near 0%).
function computeConfidence({ planOk, rrRatio, topDown, bias, structureLabel }) {
  let score = 50;
  if (planOk) score += 12;
  if (typeof rrRatio === "number") {
    if (rrRatio >= 3) score += 15;
    else if (rrRatio >= 2) score += 10;
    else if (rrRatio >= 1) score += 4;
    else score -= 6;
  }
  if (Array.isArray(topDown) && topDown.length) {
    const aligned = topDown.filter((td) => td?.bias && bias && String(td.bias).toLowerCase() === String(bias).toLowerCase()).length;
    score += Math.round((aligned / topDown.length) * 18) - 4;
  }
  if (structureLabel && !/range/i.test(structureLabel)) score += 6;
  if (!planOk) score -= 10;
  return Math.max(35, Math.min(95, Math.round(score)));
}

function conceptSummary(concepts) {
  if (!concepts || typeof concepts !== "object") return "";
  const parts = Object.entries(concepts)
    .filter(([, v]) => v && v.found)
    .map(([key, v]) => `${key.toUpperCase()} ×${v.found}`);
  return parts.length ? `Detected: ${parts.join(", ")}.` : "";
}

// FXSynapse's docs say plan.side is "buy"/"sell", but we were seeing every
// single scan come back Sell — turns out some responses use "long"/"short"
// instead, and the old code only ever matched the literal string "buy", so
// anything else (including a real "long") silently fell through to Short.
// Recognize both conventions instead of trusting one literal string.
function isBullishSide(side) {
  const s = String(side || "").toLowerCase();
  if (s === "buy" || s === "long") return true;
  if (s === "sell" || s === "short") return false;
  console.error(`FXSynapse returned an unrecognized plan.side value: ${JSON.stringify(side)} — treating as not-bullish.`);
  return false;
}

// FXSynapse's /api/v1/chart response carries the raw price bars it used for
// analysis, but the exact field name/shape isn't nailed down from their docs
// yet. Try every plausible shape rather than betting on one, so the live
// candlestick chart lights up as soon as a real response comes back instead
// of needing a code change once we see the real field name.
const CANDLE_ARRAY_KEYS = ["candles", "bars_data", "barsData", "ohlc", "ohlcv", "history", "priceData", "price_data", "data", "series"];
function toUnixSeconds(t) {
  if (typeof t === "number") return t > 1e12 ? Math.round(t / 1000) : Math.round(t);
  if (typeof t === "string") {
    const n = Number(t);
    if (!Number.isNaN(n)) return toUnixSeconds(n);
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return Math.round(ms / 1000);
  }
  return null;
}
function normalizeCandle(raw) {
  if (!raw) return null;
  // Object shape: {time|t|timestamp|date, open|o, high|h, low|l, close|c}
  if (!Array.isArray(raw)) {
    const time = toUnixSeconds(raw.time ?? raw.t ?? raw.timestamp ?? raw.date);
    const open = Number(raw.open ?? raw.o);
    const high = Number(raw.high ?? raw.h);
    const low = Number(raw.low ?? raw.l);
    const close = Number(raw.close ?? raw.c);
    if (time == null || [open, high, low, close].some(Number.isNaN)) return null;
    return { time, open, high, low, close };
  }
  // Array shape: [time, open, high, low, close, ...]
  if (raw.length >= 5) {
    const time = toUnixSeconds(raw[0]);
    const [open, high, low, close] = raw.slice(1, 5).map(Number);
    if (time == null || [open, high, low, close].some(Number.isNaN)) return null;
    return { time, open, high, low, close };
  }
  return null;
}
function extractCandles(fx) {
  let found = null;
  for (const key of CANDLE_ARRAY_KEYS) {
    if (Array.isArray(fx?.[key]) && fx[key].length) {
      found = fx[key];
      break;
    }
  }
  if (!found) return [];
  const candles = found.map(normalizeCandle).filter(Boolean);
  // Chart libraries require strictly ascending, deduplicated timestamps.
  candles.sort((a, b) => a.time - b.time);
  const deduped = [];
  for (const c of candles) {
    if (deduped.length && deduped[deduped.length - 1].time === c.time) {
      deduped[deduped.length - 1] = c;
    } else {
      deduped.push(c);
    }
  }
  return deduped;
}

function mapFxSynapseToAnalysis(fx) {
  const plan = fx.plan || {};
  const planOk = !!plan.ok;
  const digits = typeof fx.digits === "number" ? fx.digits : null;
  const bias = planOk && plan.side
    ? (isBullishSide(plan.side) ? "Bullish" : "Bearish")
    : biasFromStructure(fx.marketStructure);

  const entries = planOk
    ? [{
        type: isBullishSide(plan.side) ? "Long" : "Short",
        entry_zone: fmtNum(plan.entry, digits),
        entry_raw: typeof plan.entry === "number" ? plan.entry : null
      }]
    : [];

  const targets = Array.isArray(plan.targets)
    ? plan.targets.map((t, i) => ({
        target: fmtNum(t, digits),
        target_raw: typeof t === "number" ? t : null,
        rationale: `Target ${i + 1}`
      }))
    : [];

  const firstTarget = Array.isArray(plan.targets) && typeof plan.targets[0] === "number" ? plan.targets[0] : null;
  const rr = planOk ? computeRR(plan.entry, plan.stop, firstTarget) : null;
  const rrRatio = planOk && typeof plan.entry === "number" && typeof plan.stop === "number" && typeof firstTarget === "number" && plan.entry !== plan.stop
    ? Math.abs(firstTarget - plan.entry) / Math.abs(plan.entry - plan.stop)
    : null;

  const notesParts = [];
  const cs = conceptSummary(fx.concepts);
  if (cs) notesParts.push(cs);
  if (typeof fx.bars === "number") notesParts.push(`Measured over the last ${fx.bars} bars.`);
  if (!fx.symbol) {
    notesParts.push("Could not confirm the pair from FXSynapse's price source — double-check the symbol and try again.");
  } else if (!planOk) {
    notesParts.push(
      plan.reason
        ? `No trade right now: ${plan.reason}`
        : "No clean directional plan on this pair/timeframe right now — structure is unclear or conflicting."
    );
  }

  const structureLabel = (fx.marketStructure || "range").replace(/^\w/, (c) => c.toUpperCase());

  return {
    pair_guess: fx.symbol || null,
    market_bias: bias,
    confidence: computeConfidence({ planOk, rrRatio, topDown: fx.topDown, bias, structureLabel }),
    bars: typeof fx.bars === "number" ? fx.bars : null,
    digits,
    candles: extractCandles(fx),
    market_structure: {
      trend: `${structureLabel} market structure, measured directly from live price bars.`,
      key_levels: describeLevels(fx.levels, digits),
      chart_pattern: null
    },
    potential_entries: entries,
    stop_loss: {
      suggestion: planOk ? fmtNum(plan.stop, digits) : "—",
      value_raw: planOk && typeof plan.stop === "number" ? plan.stop : null,
      rationale: planOk ? "Calculated from the nearest invalidating structure." : ""
    },
    take_profit: targets,
    risk_reward_estimate: rr || (planOk ? "No clean target to measure against yet." : "No active trade to estimate."),
    invalidation: planOk
      ? `Plan is invalidated if price closes back through ${fmtNum(plan.stop, digits)}.`
      : "No directional plan right now, so nothing to invalidate.",
    notes: notesParts.join(" "),
    disclaimer: "This is a rule-based technical read calculated from live price data, not financial advice. Always confirm with your own analysis and risk management.",
    top_down: Array.isArray(fx.topDown)
      ? fx.topDown.map((td) => ({
          timeframe: td?.timeframe || "—",
          bias: td?.bias || "—",
          zone: td?.zone || "—"
        }))
      : []
  };
}

module.exports = { mapFxSynapseToAnalysis };
