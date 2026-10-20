// Standalone auto-post job — runs completely separately from server.js /
// Express. Intended to be run on its own schedule (every 40 minutes) as a
// Render Cron Job, which gets its own container and its own memory budget.
// That way, even if video generation (sharp + ffmpeg, both memory-heavy)
// spikes memory or crashes, it can never take down the main web service —
// it's a different process entirely, not a setInterval living inside it.
//
// Run directly: node video/autoPostJob.js
//
// Required env vars (same ones the web service already has):
//   FXSYNAPSE_BASE_URL, FXSYNAPSE_CHART_PATH, FXSYNAPSE_API_KEY
//   YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN

const { mapFxSynapseToAnalysis } = require("../analysisMapper");
const { generateTradeVideo } = require("./generateTradeVideo");
const { uploadVideo } = require("./youtubeUpload");
const fs = require("fs");

const FXSYNAPSE_BASE_URL = (process.env.FXSYNAPSE_BASE_URL || "").trim();
const FXSYNAPSE_CHART_PATH = (process.env.FXSYNAPSE_CHART_PATH || "").trim();
const FXSYNAPSE_API_KEY = (process.env.FXSYNAPSE_API_KEY || "").trim();

const AUTO_POST_INTERVAL_MS = 40 * 60 * 1000;
const AUTO_POST_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "US30", "NAS100"];
const AUTO_POST_TIMEFRAME = "M15";

// A cron job is a fresh process every run — there's no persisted index to
// increment like the old in-process version had. Instead, pick the symbol
// deterministically from the current time, so consecutive runs 40 minutes
// apart naturally walk through the rotation in order.
function currentSymbol() {
  const slot = Math.floor(Date.now() / AUTO_POST_INTERVAL_MS);
  return AUTO_POST_SYMBOLS[slot % AUTO_POST_SYMBOLS.length];
}

// Mirrors postTradeVideoIfValid() in server.js — kept as its own copy here
// since this script intentionally does not require server.js (that would
// drag in the whole Express app, defeating the point of isolating this job).
async function postTradeVideoIfValid(analysis) {
  const entry = analysis?.potential_entries?.[0];
  const target = analysis?.take_profit?.[0];
  const stop = analysis?.stop_loss;
  if (!entry?.entry_raw || !target?.target_raw || !stop?.value_raw) {
    return false;
  }
  const direction = entry.type === "Long" ? "BUY" : "SELL";
  let videoPath;
  try {
    videoPath = await generateTradeVideo({
      pair: analysis.pair_guess || "—",
      direction,
      entry: entry.entry_zone,
      sl: stop.suggestion,
      tp: target.target,
      confidence: analysis.confidence
    });
    await uploadVideo(videoPath, {
      title: `${analysis.pair_guess || "Market"} ${direction} Signal`,
      description: `${analysis.market_structure?.trend || ""}\n\n${analysis.disclaimer || ""}`,
      privacyStatus: "unlisted"
    });
    return true;
  } finally {
    if (videoPath) fs.rm(videoPath, { force: true }, () => {});
  }
}

async function runAutoPostCycle() {
  if (!FXSYNAPSE_BASE_URL || !FXSYNAPSE_API_KEY) {
    console.error("autoPostJob: missing FXSynapse config, skipping run.");
    return;
  }
  if (!(process.env.YOUTUBE_REFRESH_TOKEN || "").trim()) {
    console.log("autoPostJob: YouTube not connected yet, skipping run.");
    return;
  }
  const symbol = currentSymbol();
  try {
    const fxRes = await fetch(`${FXSYNAPSE_BASE_URL}${FXSYNAPSE_CHART_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${FXSYNAPSE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, timeframe: AUTO_POST_TIMEFRAME, top_down: true }),
      signal: AbortSignal.timeout(55000)
    });
    if (!fxRes.ok) {
      console.error(`autoPostJob: FXSynapse ${fxRes.status} for ${symbol}`);
      return;
    }
    const fxData = await fxRes.json();
    const analysis = mapFxSynapseToAnalysis(fxData);
    const posted = await postTradeVideoIfValid(analysis);
    console.log(posted ? `autoPostJob: posted ${symbol}.` : `autoPostJob: no clean setup on ${symbol}, skipped.`);
  } catch (err) {
    console.error(`autoPostJob: failed for ${symbol}:`, err.message);
  }
}

runAutoPostCycle().then(() => process.exit(0)).catch((err) => {
  console.error("autoPostJob: fatal error:", err);
  process.exit(1);
});
