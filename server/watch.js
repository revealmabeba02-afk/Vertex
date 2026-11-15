// Vertex market watcher — the part of the product that keeps looking.
//
// A scan is a photograph: you ask once, you get one read, and then it is
// stale. The watcher is the loop around it. On an interval it re-reads each
// symbol on its timeframe, compares the new read to the previous one, and
// records an alert when something actually changed — bias flipped, a plan
// appeared or disappeared, entry/stop/target moved, confidence shifted.
//
// Two deliberate design rules:
//
//   1. Detection is deterministic. No model is involved in deciding whether
//      something changed. Every alert can be traced back to two numbers in
//      two reads, which means no invented signals and no per-tick AI spend.
//   2. It is rate-capped by construction. The provider is a paid plan, so
//      every tick is counted against a daily ceiling that closes the loop
//      rather than draining the plan.
//
// Storage is in-memory on purpose: this server holds no service-role key and
// the free disk is ephemeral, so durable history is a database job for later.
// State survives as long as the instance is awake, and `maybeTick()` lets the
// loop catch up the moment anyone opens the app.

const { mapFxSynapseToAnalysis } = require("./analysisMapper");

const ALERT_LIMIT = 300;
const DEFAULT_SYMBOLS = ["EURUSD", "XAUUSD", "US30"];
const DEFAULT_TIMEFRAMES = ["H1"];

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function envList(name, fallback) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback.slice();
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

// FX runs from Sunday 21:00 UTC to Friday 21:00 UTC. Anything outside that
// window can't change price, so it isn't worth a provider call.
function isMarketOpen(now = new Date()) {
  if (process.env.WATCH_IGNORE_HOURS === "true") return true;
  const day = now.getUTCDay(); // 0 = Sunday
  const hour = now.getUTCHours();
  if (day === 6) return false; // Saturday
  if (day === 5 && hour >= 21) return false; // Friday close
  if (day === 0 && hour < 21) return false; // before Sunday open
  return true;
}

// Pairs quote in a lot of different scales (EURUSD 1.08, XAUUSD 2400,
// US30 39000), so "has it moved enough to matter?" has to be relative.
// 0.15% of price is roughly 16 pips on EURUSD at 1.08 and ~5 points on
// US30 at 39000: big enough that normal noise doesn't alert, small enough
// that a real shift in the plan does.
function relativeShift(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return Math.abs(b - a) / Math.abs(a);
}

function snapshotOf(analysis) {
  const plan = Array.isArray(analysis.potential_entries) ? analysis.potential_entries[0] : null;
  const target = Array.isArray(analysis.take_profit) ? analysis.take_profit[0] : null;
  const structureText = String(analysis.market_structure?.trend || "");
  return {
    bias: analysis.market_bias || "Unclear",
    structure: structureText.split(" ")[0] || "—",
    hasPlan: !!plan,
    side: plan ? plan.type : null,
    entry: plan && Number.isFinite(plan.entry_raw) ? plan.entry_raw : null,
    stop: analysis.stop_loss && Number.isFinite(analysis.stop_loss.value_raw) ? analysis.stop_loss.value_raw : null,
    target: target && Number.isFinite(target.target_raw) ? target.target_raw : null,
    confidence: Number.isFinite(analysis.confidence) ? analysis.confidence : null,
    rr: analysis.risk_reward_estimate || "—"
  };
}

function fmt(v, digits) {
  if (!Number.isFinite(v)) return "—";
  const d = Number.isFinite(digits) ? Math.max(0, Math.min(6, digits)) : 2;
  return v.toFixed(d);
}

// Turn two reads into zero or more alerts. Ordered by how much a trader
// would care, so the feed can lead with the bias flip and bury the noise.
function diffSnapshots(prev, next, digits) {
  if (!prev) return [];
  const out = [];
  const sym = (v, d) => fmt(v, d);

  if (prev.bias !== next.bias) {
    out.push({
      kind: "bias-flip",
      severity: "high",
      title: `Bias flipped to ${next.bias.toLowerCase()}`,
      detail: `Structure went from ${prev.bias.toLowerCase()} to ${next.bias.toLowerCase()} on the latest bars.`
    });
  }

  if (!prev.hasPlan && next.hasPlan) {
    out.push({
      kind: "plan-appeared",
      severity: "high",
      title: `New ${String(next.side || "").toLowerCase()} plan`,
      detail: `Entry ${sym(next.entry, digits)}, stop ${sym(next.stop, digits)}, target ${sym(next.target, digits)}.`
    });
  } else if (prev.hasPlan && !next.hasPlan) {
    out.push({
      kind: "plan-gone",
      severity: "high",
      title: "Plan no longer valid",
      detail: "There was a clean setup on the last read and there isn't one now."
    });
  } else if (prev.hasPlan && next.hasPlan) {
    if (prev.side !== next.side) {
      out.push({
        kind: "side-flip",
        severity: "high",
        title: `Plan flipped to ${String(next.side || "").toLowerCase()}`,
        detail: `The setup reversed direction: was ${String(prev.side || "—").toLowerCase()}, now ${String(next.side || "—").toLowerCase()}.`
      });
    }
    const moves = [
      ["Entry", prev.entry, next.entry],
      ["Stop", prev.stop, next.stop],
      ["Target", prev.target, next.target]
    ];
    const shifted = moves
      .map(([label, a, b]) => ({ label, a, b, shift: relativeShift(a, b) }))
      .filter((m) => m.shift !== null && m.shift >= 0.0015);
    if (shifted.length) {
      out.push({
        kind: "levels-moved",
        severity: "medium",
        title: `${shifted.map((m) => m.label.toLowerCase()).join(", ")} moved`,
        detail: shifted
          .map((m) => `${m.label} ${sym(m.a, digits)} → ${sym(m.b, digits)}`)
          .join(" · ")
      });
    }
  } else if (!prev.hasPlan && !next.hasPlan && prev.structure !== next.structure) {
    out.push({
      kind: "structure-change",
      severity: "medium",
      title: `Structure turned ${String(next.structure).toLowerCase()}`,
      detail: `Was ${String(prev.structure).toLowerCase()}, now ${String(next.structure).toLowerCase()}. No plan on either read.`
    });
  }

  if (prev.confidence !== null && next.confidence !== null) {
    const delta = next.confidence - prev.confidence;
    if (Math.abs(delta) >= 15) {
      out.push({
        kind: "confidence-shift",
        severity: "low",
        title: `Confidence ${delta > 0 ? "up" : "down"} ${Math.abs(delta)} points`,
        detail: `${prev.confidence} → ${next.confidence}.`
      });
    }
  }

  return out;
}

function createWatcher({ fetchChart, digitsHint } = {}) {
  const symbols = envList("WATCH_SYMBOLS", DEFAULT_SYMBOLS);
  const timeframes = envList("WATCH_TIMEFRAMES", DEFAULT_TIMEFRAMES);
  const intervalMs = envInt("WATCH_INTERVAL_MS", 30 * 60 * 1000);
  const maxCallsPerDay = envInt("WATCH_MAX_CALLS_PER_DAY", 120);
  const enabled = (process.env.WATCH_ENABLED || "true") !== "false";

  /** key -> { snap, digits, at, read } */
  const state = new Map();
  const alerts = [];
  const runtime = {
    lastTickAt: null,
    lastError: null,
    callsToday: 0,
    callDay: new Date().toISOString().slice(0, 10),
    running: false,
    ticks: 0,
    skipped: { closed: 0, capped: 0, busy: 0 }
  };

  let timer = null;
  let nextTickAt = null;

  function rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== runtime.callDay) {
      runtime.callDay = today;
      runtime.callsToday = 0;
    }
  }

  function pushAlert(symbol, timeframe, change, snaps) {
    const alert = {
      id: `${symbol}:${timeframe}:${Date.now()}:${alerts.length}`,
      at: new Date().toISOString(),
      symbol,
      timeframe,
      severity: change.severity,
      kind: change.kind,
      title: change.title,
      detail: change.detail,
      from: snaps.prev,
      to: snaps.next
    };
    alerts.unshift(alert);
    if (alerts.length > ALERT_LIMIT) alerts.length = ALERT_LIMIT;
    return alert;
  }

  async function check(symbol, timeframe) {
    if (typeof fetchChart !== "function") throw new Error("No chart source wired into the watcher.");
    rollDay();
    if (runtime.callsToday >= maxCallsPerDay) {
      runtime.skipped.capped += 1;
      return { skipped: "capped" };
    }
    runtime.callsToday += 1;

    const fx = await fetchChart(symbol, timeframe);
    const analysis = mapFxSynapseToAnalysis(fx);
    const next = snapshotOf(analysis);
    const digits = Number.isFinite(analysis.digits) ? analysis.digits : digitsHint;
    const key = `${symbol}:${timeframe}`;
    const prevEntry = state.get(key);
    const prev = prevEntry ? prevEntry.snap : null;

    state.set(key, { snap: next, digits, at: new Date().toISOString(), analysis });
    const changes = diffSnapshots(prev, next, digits);
    const written = changes.map((c) => pushAlert(symbol, timeframe, c, { prev, next }));
    return { symbol, timeframe, changes: written.length, snap: next };
  }

  async function tick({ force = false } = {}) {
    if (!enabled) return { ok: false, reason: "disabled" };
    if (runtime.running) {
      runtime.skipped.busy += 1;
      return { ok: false, reason: "already-running" };
    }
    if (!force && !isMarketOpen()) {
      runtime.skipped.closed += 1;
      runtime.lastTickAt = new Date().toISOString();
      return { ok: true, reason: "market-closed", calls: 0 };
    }
    runtime.running = true;
    const started = Date.now();
    const results = [];
    try {
      for (const symbol of symbols) {
        for (const timeframe of timeframes) {
          // One failure must never stop the rest of the sweep.
          try {
            results.push(await check(symbol, timeframe));
          } catch (err) {
            results.push({ symbol, timeframe, error: err.message });
            runtime.lastError = err.message;
            console.error(`Watcher ${symbol} ${timeframe}:`, err.message);
          }
        }
      }
      runtime.ticks += 1;
      return {
        ok: true,
        calls: results.filter((r) => !r.skipped && !r.error).length,
        alerts: results.reduce((n, r) => n + (r.changes || 0), 0),
        ms: Date.now() - started,
        results
      };
    } finally {
      runtime.running = false;
      runtime.lastTickAt = new Date().toISOString();
    }
  }

  // Called from the feed endpoint. If the instance was asleep (Render free
  // spins down) the interval never fired, so the first person to open the app
  // triggers a catch-up sweep instead of waiting for the clock.
  let catchingUp = false;
  function maybeTick() {
    if (!enabled || catchingUp || runtime.running) return false;
    const last = runtime.lastTickAt ? Date.parse(runtime.lastTickAt) : 0;
    if (Date.now() - last < intervalMs) return false;
    catchingUp = true;
    tick()
      .catch((err) => console.error("Watcher catch-up failed:", err.message))
      .finally(() => {
        catchingUp = false;
      });
    return true;
  }

  function start() {
    if (!enabled) {
      console.log("Market watcher: disabled (WATCH_ENABLED=false)");
      return;
    }
    if (typeof fetchChart !== "function") {
      console.log("Market watcher: no chart source configured, not starting");
      return;
    }
    const arm = () => {
      nextTickAt = new Date(Date.now() + intervalMs).toISOString();
      timer = setInterval(() => {
        arm();
        tick().catch((err) => console.error("Watcher tick failed:", err.message));
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    };
    arm();
    // Give the instance a moment to finish booting before the first sweep,
    // rather than firing provider calls during startup.
    const first = setTimeout(() => {
      tick().catch((err) => console.error("Watcher first tick failed:", err.message));
    }, 90 * 1000);
    if (typeof first.unref === "function") first.unref();
    console.log(
      `Market watcher: ${symbols.join(", ")} on ${timeframes.join("/")} every ${Math.round(intervalMs / 60000)}m, cap ${maxCallsPerDay}/day`
    );
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    nextTickAt = null;
  }

  function feed({ limit = 40, full = false } = {}) {
    const symbolsState = [...state.entries()].map(([key, v]) => ({
      key,
      at: v.at,
      ...v.snap
    }));
    return {
      enabled,
      marketOpen: isMarketOpen(),
      intervalMinutes: Math.round(intervalMs / 60000),
      symbols,
      timeframes,
      lastTickAt: runtime.lastTickAt,
      nextTickAt,
      callsToday: runtime.callsToday,
      maxCallsPerDay,
      ticks: runtime.ticks,
      skipped: runtime.skipped,
      lastError: runtime.lastError,
      alerts: alerts.slice(0, Math.max(1, Math.min(limit, ALERT_LIMIT))),
      symbolsState: full ? symbolsState : undefined,
      watching: symbolsState.length
    };
  }

  return { tick, maybeTick, start, stop, feed, state, alerts, isMarketOpen, symbols, timeframes };
}

module.exports = { createWatcher, diffSnapshots, snapshotOf, isMarketOpen, relativeShift };
