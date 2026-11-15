// Self-test for the market watcher's change detection.
//
// Runs two fake reads through the real mapper and the real diff, so the
// alerts you see here are produced by exactly the code the server runs.
// No network, no provider spend, no AI.
//
// Usage: node scripts/watch-selftest.js

process.env.WATCH_SYMBOLS = "EURUSD";
process.env.WATCH_TIMEFRAMES = "H1";
process.env.WATCH_IGNORE_HOURS = "true";
process.env.WATCH_ENABLED = "true";

const { createWatcher } = require("../server/watch");

const longRead = {
  symbol: "EURUSD",
  digits: 5,
  bars: 300,
  marketStructure: "uptrend",
  topDown: [{ timeframe: "D1", bias: "Bullish", zone: "discount" }],
  levels: { support: [1.075, 1.07], resistance: [1.095] },
  plan: { ok: true, side: "long", entry: 1.08, stop: 1.075, targets: [1.09, 1.095] }
};

const shortRead = {
  ...longRead,
  marketStructure: "downtrend",
  topDown: [{ timeframe: "D1", bias: "Bearish", zone: "premium" }],
  plan: { ok: true, side: "short", entry: 1.078, stop: 1.083, targets: [1.068, 1.062] }
};

const flatRead = {
  ...longRead,
  marketStructure: "range",
  plan: { ok: false, reason: "price is mid-range" },
  topDown: [{ timeframe: "D1", bias: "Neutral", zone: "equilibrium" }]
};

async function main() {
  let reads = [longRead, shortRead];
  const watcher = createWatcher({
    fetchChart: async () => reads.shift()
  });

  const first = await watcher.tick({ force: true });
  console.log("tick 1:", first.calls, "calls,", first.alerts, "alerts (a first read has nothing to compare to)");

  const second = await watcher.tick({ force: true });
  console.log("tick 2:", second.calls, "calls,", second.alerts, "alerts");
  const feed = watcher.feed({ limit: 10 });
  for (const a of feed.alerts) {
    console.log(`  [${a.severity}] ${a.symbol} ${a.timeframe} — ${a.title} :: ${a.detail}`);
  }

  // Third read: plan disappears entirely.
  reads = [flatRead];
  const third = await watcher.tick({ force: true });
  console.log("tick 3:", third.alerts, "alerts (plan lost)");

  const kinds = new Set(watcher.feed({ limit: 50 }).alerts.map((a) => a.kind));
  const expected = ["bias-flip", "side-flip", "levels-moved", "confidence-shift", "plan-gone"];
  const missing = expected.filter((k) => !kinds.has(k));
  console.log("\nkinds seen:", [...kinds].join(", ") || "(none)");
  if (missing.length) {
    console.error("MISSING:", missing.join(", "));
    process.exitCode = 1;
    return;
  }
  console.log("all expected detections fired");
}

main().catch((err) => {
  console.error("selftest failed:", err);
  process.exitCode = 1;
});
