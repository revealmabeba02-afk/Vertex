// Vertex ops agent — the hands.
//
// The parts of an autonomous operator that actually touch the system: read the
// service's health, read its memory, pull its logs from Render, list its
// deploys, and restart it. No language model in here. A model that guesses at
// what the server is doing is worse than useless; a model that is handed facts
// it can trust is the whole point. So the tools come first and get tested on
// their own.
//
// Deliberate limits, enforced at this layer rather than in a prompt:
//   • Reading is unlimited.
//   • Restarting is capped (RESTART_LIMIT per RESTART_WINDOW_MS) so a loop
//     that keeps seeing a symptom cannot hammer the service.
//   • There is no "push a commit" tool. Pushing to main deploys straight to
//     production; that decision stays with a human.
//
// Runs inside the app (server.js imports it) and standalone for testing:
//   node opsAgent.js status
//   node opsAgent.js logs 30
//   node opsAgent.js deploys

const RENDER_API_KEY = (process.env.RENDER_API_KEY || "").trim();
const RENDER_SERVICE_ID = (
  process.env.RENDER_SERVICE_ID || "srv-das2umt9fdbs73bkmum0"
).trim();
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || "https://vertex-9s4c.onrender.com"
).replace(/\/+$/, "");

// Render's log endpoint wants an owner id, not a service id. Deriving it from
// the service keeps one variable to set, and the id is a stable prefix.
const RENDER_OWNER_ID = (process.env.RENDER_OWNER_ID || "tea-das2fal9fdbs73bj2ivg").trim();

const RESTART_LIMIT = Number(process.env.OPS_RESTART_LIMIT) || 2;
const RESTART_WINDOW_MS = 60 * 60 * 1000;

const renderReady = () => Boolean(RENDER_API_KEY);

async function renderRequest(path, { method = "GET", timeoutMs = 15000 } = {}) {
  if (!renderReady()) throw new Error("No RENDER_API_KEY on this server, so Render can't be read or controlled.");
  const res = await fetch(`https://api.render.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 400);
  }
  if (!res.ok) {
    const detail = typeof body === "string" ? body : body?.message || JSON.stringify(body || {}).slice(0, 200);
    throw new Error(`Render ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return body;
}

// --- Facts ---------------------------------------------------------------

// What the app says about itself right now. The status endpoint is the same one
// the public /status page reads, so this is exactly what a visitor sees.
async function readHealth() {
  const started = Date.now();
  try {
    const res = await fetch(`${PUBLIC_BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(20000)
    });
    const body = await res.json().catch(() => null);
    return {
      reachable: res.ok,
      status: res.status,
      latencyMs: Date.now() - started,
      body
    };
  } catch (err) {
    return {
      reachable: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: err.message
    };
  }
}

// In-process memory. Called from inside server.js this is the real thing;
// called from the CLI it only describes the CLI process, which is why the
// standalone path reports it as unavailable rather than printing a lie.
function readMemory({ inProcess = false } = {}) {
  if (!inProcess) return { available: false, reason: "Run inside the app to read its memory." };
  const m = process.memoryUsage();
  let limit = 0;
  try {
    limit = require("v8").getHeapStatistics().heap_size_limit;
  } catch {
    limit = 0;
  }
  const mb = (n) => Math.round(n / 1048576);
  return {
    available: true,
    heapUsedMb: mb(m.heapUsed),
    heapLimitMb: mb(limit),
    heapPercent: limit ? Math.round((m.heapUsed / limit) * 100) : null,
    rssMb: mb(m.rss),
    externalMb: mb(m.external)
  };
}

// Render's log stream, newest last. Only what happened in the window, so the
// agent reasons about this morning rather than last Tuesday.
async function readLogs({ minutes = 30, limit = 200 } = {}) {
  const start = new Date(Date.now() - minutes * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const query = new URLSearchParams({
    ownerId: RENDER_OWNER_ID,
    startTime: start,
    resource: RENDER_SERVICE_ID,
    limit: String(Math.min(Math.max(limit, 1), 500))
  });
  const body = await renderRequest(`/v1/logs?${query}`);
  const entries = Array.isArray(body?.logs) ? body.logs : [];
  return entries.map((entry) => ({
    at: entry.timestamp,
    message: String(entry.message || "").replace(/\u001b\[[0-9;]*m/g, "").trim()
  }));
}

// The handful of lines that actually explain a bad night, pulled out of the
// noise so the model doesn't have to be good at grep.
const SIGNAL_PATTERNS = [
  /heap out of memory/i,
  /Reached heap limit/i,
  /Ineffective mark-compacts/i,
  /FATAL/i,
  /unhandledRejection|uncaughtException/i,
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i,
  /quota|429|rate limit/i,
  /401|403|invalid.*key/i
];

function pickSignals(entries) {
  const hits = [];
  for (const entry of entries) {
    if (SIGNAL_PATTERNS.some((re) => re.test(entry.message))) {
      hits.push(entry);
      if (hits.length >= 60) break;
    }
  }
  return hits;
}

// Restarts and boots, so "it died three times" is a number rather than a hunch.
function countRestarts(entries) {
  return entries.filter((e) => /running at http:\/\/localhost/i.test(e.message)).length;
}

async function readDeploys({ limit = 5 } = {}) {
  const body = await renderRequest(`/v1/services/${RENDER_SERVICE_ID}/deploys?limit=${limit}`);
  const deploys = Array.isArray(body) ? body : [];
  return deploys.map((item) => {
    const d = item.deploy || item;
    return {
      id: d.id,
      status: d.status,
      commit: d.commit?.id ? d.commit.id.slice(0, 7) : null,
      message: d.commit?.message ? String(d.commit.message).split("\n")[0].slice(0, 90) : null,
      createdAt: d.createdAt,
      finishedAt: d.finishedAt || null
    };
  });
}

// --- One action ----------------------------------------------------------

const restartHistory = [];

async function restartService({ reason = "" } = {}) {
  const now = Date.now();
  while (restartHistory.length && now - restartHistory[0] > RESTART_WINDOW_MS) restartHistory.shift();
  if (restartHistory.length >= RESTART_LIMIT) {
    return {
      ok: false,
      refused: true,
      reason: `Already restarted ${restartHistory.length} times in the last hour. Not doing it again — this needs a person.`
    };
  }
  const body = await renderRequest(`/v1/services/${RENDER_SERVICE_ID}/restart`, {
    method: "POST",
    timeoutMs: 20000
  });
  restartHistory.push(now);
  return {
    ok: true,
    reason,
    restartsLastHour: restartHistory.length,
    deploy: body?.deploy?.id || null
  };
}

// Everything the brain needs, in one call, cheap enough to run on demand.
async function snapshot({ logMinutes = 30, inProcess = false } = {}) {
  const result = {
    at: new Date().toISOString(),
    service: { id: RENDER_SERVICE_ID, url: PUBLIC_BASE_URL },
    health: null,
    memory: readMemory({ inProcess }),
    restartsLastHour: restartHistory.length,
    logs: { total: 0, restarts: 0, signals: [] },
    deploys: [],
    errors: []
  };

  const settle = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      result.errors.push(`${label}: ${err.message}`);
      return null;
    }
  };

  result.health = await settle("health", () => readHealth());
  const entries = await settle("logs", () => readLogs({ minutes: logMinutes }));
  if (entries) {
    result.logs = {
      total: entries.length,
      restarts: countRestarts(entries),
      signals: pickSignals(entries).map((e) => ({ at: e.at, message: e.message.slice(0, 220) }))
    };
  }
  result.deploys = (await settle("deploys", () => readDeploys())) || [];

  return result;
}

// --- The brain -----------------------------------------------------------
// Two layers, on purpose.
//
// The reflex layer costs nothing and answers the only question that matters on
// a five-minute timer: does this look wrong? Most cycles end there, which is
// what keeps a free-tier Gemini key alive — an agent that calls a model every
// few minutes to be told "everything is fine" is an agent that runs out of
// quota by lunchtime and then blames the model.
//
// The thinking layer runs only when the reflex raises a hand. It is given
// facts, not access: the tool results are already collected, and the only
// thing it can return is a decision from a fixed list. Anything that looks
// like "change the code" comes back as a written suggestion for a human.

const { generateText } = require("./aiText");

const ALLOWED_ACTIONS = ["none", "restart", "escalate"];
const DECISION_LIMIT = 40;
const decisions = [];

const OPS_SYSTEM_PROMPT = `You are the operator on duty for Vertex Chart Scanner, a forex chart-analysis web app running on a single Render instance (512 MB).

Your job is to decide whether the service needs an intervention, and if so, which one. You are given facts collected seconds ago: health, memory, how many times the process restarted, the log lines that matched known failure patterns, and recent deploys.

What you know about this system:
- The Node process has a 384 MB heap limit. "JavaScript heap out of memory" means the process died and Render restarted it; the site is down for about 12 seconds each time.
- Scanning needs an AI provider. Quota errors (429) are expected on a free plan and are not a crash.
- A deploy to main goes live automatically in about two minutes. A bad deploy looks like a build that never reaches "live", or a live service that cannot answer /api/health.
- Restarts are cheap but not free: each one drops in-flight scans. Never restart a healthy service.

Choose exactly one action:
- "none"     — the service is healthy, or the symptom is expected and needs no intervention.
- "restart"  — ONLY if the service is unhealthy (health unreachable, or memory at 90%+ and climbing, or two or more crashes in the last 30 minutes that a restart would plausibly fix).
- "escalate" — the cause is a code or configuration fault that a restart will not fix. A human must look.

Reply with JSON only, no prose and no code fences:
{
  "verdict": "healthy" | "degraded" | "down",
  "assessment": "one or two sentences, plain language, what is happening",
  "action": "none" | "restart" | "escalate",
  "why": "one sentence justifying the action",
  "fix": "if escalate, the specific change a human should make; otherwise an empty string"
}`;

// Deterministic, free, and conservative. Everything in here is a fact about
// the snapshot, not a judgement — the judgement is the model's job.
function triage(snapshot) {
  const reasons = [];
  const health = snapshot?.health || {};
  if (!health.reachable) reasons.push(`health unreachable (${health.error || `HTTP ${health.status}`})`);
  else if (health.status >= 500) reasons.push(`health returned ${health.status}`);
  else if (health.latencyMs > 15000) reasons.push(`health took ${Math.round(health.latencyMs / 1000)}s`);

  const memory = snapshot?.memory || {};
  if (memory.available && memory.heapPercent != null && memory.heapPercent >= 85) {
    reasons.push(`heap at ${memory.heapPercent}%`);
  }

  const restarts = snapshot?.logs?.restarts || 0;
  if (restarts >= 2) reasons.push(`${restarts} restarts in the window`);

  const signals = snapshot?.logs?.signals || [];
  const worrying = signals.filter((s) =>
    /heap out of memory|Reached heap limit|Ineffective mark-compacts|uncaughtException|unhandledRejection/i.test(s.message)
  );
  if (worrying.length) reasons.push(`${worrying.length} crash-level log line(s)`);

  return { suspicious: reasons.length > 0, reasons };
}

function parseDecision(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function think(snapshot, { command = "", timeoutMs = 25000 } = {}) {
  if (typeof generateText !== "function") throw new Error("No text model wired in.");
  const prompt = [
    `Facts collected at ${snapshot?.at || new Date().toISOString()}:`,
    JSON.stringify(
      {
        health: snapshot?.health,
        memory: snapshot?.memory,
        restartsLastHour: snapshot?.restartsLastHour,
        logs: snapshot?.logs,
        deploys: (snapshot?.deploys || []).slice(0, 3)
      },
      null,
      2
    ),
    command ? `\nThe owner is asking: ${command}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const out = await generateText({
    system: OPS_SYSTEM_PROMPT,
    prompt,
    maxTokens: 500,
    temperature: 0.2,
    timeoutMs
  });

  const parsed = parseDecision(out?.text);
  if (!parsed) {
    return {
      verdict: "unknown",
      assessment: "The operator could not produce a decision.",
      action: "escalate",
      why: "Model reply was not valid JSON.",
      fix: "",
      raw: String(out?.text || "").slice(0, 400)
    };
  }

  // The allowlist is enforced here, not trusted from the model.
  if (!ALLOWED_ACTIONS.includes(parsed.action)) {
    parsed.fix = parsed.fix || `Model proposed an unsupported action: ${parsed.action}`;
    parsed.action = "escalate";
  }
  return parsed;
}

// One full cycle: look, decide if needed, and act only within its limits.
async function runCycle({ inProcess = false, allowRestart = true, command = "", logMinutes = 30 } = {}) {
  const snap = await snapshot({ logMinutes, inProcess });
  const reflex = triage(snap);

  const record = {
    at: snap.at,
    reflex,
    decision: null,
    acted: null
  };

  if (!reflex.suspicious && !command) {
    record.decision = {
      verdict: "healthy",
      assessment: "Nothing in the snapshot looks wrong. No model call made.",
      action: "none",
      why: "Reflex layer found nothing to escalate.",
      fix: ""
    };
  } else {
    try {
      record.decision = await think(snap, { command });
    } catch (err) {
      record.decision = {
        verdict: "unknown",
        assessment: `Could not reach the operator model: ${err.message}`,
        action: "escalate",
        why: "Model unavailable.",
        fix: ""
      };
    }
  }

  if (record.decision.action === "restart") {
    if (!allowRestart) {
      record.acted = { ok: false, refused: true, reason: "Restart is disabled for this run." };
    } else {
      try {
        record.acted = await restartService({ reason: record.decision.why || "Operator decision" });
      } catch (err) {
        record.acted = { ok: false, error: err.message };
      }
    }
  }

  decisions.unshift(record);
  if (decisions.length > DECISION_LIMIT) decisions.length = DECISION_LIMIT;
  // The snapshot is returned to the caller but not stored: forty full
  // snapshots of log lines is memory this box cannot spare, and the panel only
  // ever shows the newest one.
  return { ...record, snapshot: snap };
}

module.exports = {
  readHealth,
  readMemory,
  readLogs,
  readDeploys,
  pickSignals,
  countRestarts,
  restartService,
  snapshot,
  triage,
  think,
  runCycle,
  decisions,
  restartHistory,
  renderReady
};

// --- Standalone ----------------------------------------------------------
// Used to check the tools work before any of it is wired into the app.
if (require.main === module) {
  const [command, arg] = process.argv.slice(2);
  (async () => {
    try {
      if (command === "logs") {
        const entries = await readLogs({ minutes: Number(arg) || 30 });
        const signals = pickSignals(entries);
        console.log(`logs: ${entries.length} lines, restarts ${countRestarts(entries)}, signals ${signals.length}`);
        signals.slice(-12).forEach((e) => console.log(`  ${e.at} ${e.message.slice(0, 140)}`));
        return;
      }
      if (command === "deploys") {
        const deploys = await readDeploys();
        deploys.forEach((d) => console.log(`${d.createdAt} ${d.status} ${d.commit || "-"} ${d.message || ""}`));
        return;
      }
      if (command === "cycle") {
        const record = await runCycle({ inProcess: false, allowRestart: false });
        console.log(JSON.stringify(record, null, 2));
        return;
      }
      if (command === "ask") {
        const record = await runCycle({ inProcess: false, allowRestart: false, command: arg || "" });
        console.log(JSON.stringify(record, null, 2));
        return;
      }
      const snap = await snapshot({ inProcess: false });
      console.log(JSON.stringify(snap, null, 2));
    } catch (err) {
      console.error("opsAgent error:", err.message);
      process.exitCode = 1;
    }
  })();
}
