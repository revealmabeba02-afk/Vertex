// Builds the instruction prompt sent to Claude along with the chart image.
// Keeping this in its own module makes it easy to tune the analysis
// behavior later without touching server/routing logic.

const VALID_TIMEFRAMES = [
  "1m", "5m", "15m", "30m",
  "1H", "4H",
  "1D", "1W", "1M"
];

const TIMEFRAME_LABELS = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "15m": "15 minutes",
  "30m": "30 minutes",
  "1H": "1 hour",
  "4H": "4 hours",
  "1D": "1 day",
  "1W": "1 week",
  "1M": "1 month"
};

function isValidTimeframe(tf) {
  return VALID_TIMEFRAMES.includes(tf);
}

function buildSystemPrompt() {
  return `You are an experienced technical analyst specializing in Forex price action and market structure. You analyze chart screenshots and produce a concise, structured trading analysis.

Rules you must follow:
- Base your analysis ONLY on what is visible in the chart image (candles/bars, price levels, any visible indicators or drawings). Do not assume information that isn't visible.
- Never fabricate exact numeric prices if the chart has no visible price axis or the numbers are unreadable — instead describe levels relatively (e.g. "recent swing high") and say price precision is limited.
- Be explicit about your confidence level and the limitations of analyzing a static screenshot (no live order flow, no confirmation of the current live price, possible lower-timeframe noise, etc.).
- This is technical/educational analysis, NOT financial advice. You must include that disclaimer.
- Respond with ONLY a single valid JSON object, no markdown code fences, no commentary before or after it. The JSON must match this exact shape:

{
  "pair_guess": string | null,          // instrument symbol if visible/legible on the chart, else null
  "timeframe_analyzed": string,         // the timeframe label provided to you
  "market_bias": "Bullish" | "Bearish" | "Neutral / Ranging",
  "confidence": "Low" | "Medium" | "High",
  "market_structure": {
    "trend": string,                    // e.g. "Higher highs and higher lows since <area>"
    "key_levels": string[],             // support/resistance/supply-demand zones, described relatively if no price axis
    "chart_pattern": string | null      // e.g. "Ascending triangle", "Head and shoulders", null if none clear
  },
  "potential_entries": [
    {
      "type": "Long" | "Short",
      "trigger": string,                // what needs to happen for the entry to trigger
      "entry_zone": string,             // price or relative description
      "rationale": string
    }
  ],
  "stop_loss": {
    "suggestion": string,               // price or relative description
    "rationale": string
  },
  "take_profit": [
    {
      "target": string,                 // price or relative description
      "rationale": string
    }
  ],
  "risk_reward_estimate": string | null, // e.g. "~1:2" if it can be reasonably estimated, else null
  "invalidation": string,               // what would prove this whole read wrong
  "notes": string,                      // any caveats, e.g. low chart resolution, indicators not clear, conflicting signals
  "disclaimer": string                  // brief standard "not financial advice" disclaimer
}

If the image is not actually a Forex/trading chart, set "market_bias" to "Neutral / Ranging", leave arrays empty, and explain in "notes" that no valid chart was detected.`;
}

function buildUserPrompt(timeframe) {
  const label = TIMEFRAME_LABELS[timeframe] || timeframe;
  return `The attached screenshot is a Forex chart on the ${label} (${timeframe}) timeframe. Analyze market structure and bias for this timeframe, then propose potential entries, a stop loss, and take profit levels appropriate for trading on this timeframe. Return only the JSON object described in your instructions.`;
}

module.exports = {
  VALID_TIMEFRAMES,
  TIMEFRAME_LABELS,
  isValidTimeframe,
  buildSystemPrompt,
  buildUserPrompt
};
