const path = require("path");

// Load server/.env by absolute path, so it is found no matter which folder the
// server is started from (project root, server/, a process manager, ...).
// Variables already set in the real environment (Render, Railway, a VPS) win
// over the file, so hosting settings are never overridden.
const ENV_PATH = path.join(__dirname, ".env");
const envLoad = require("dotenv").config({ path: ENV_PATH });

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// FXSynapse AI provides the actual chart analysis. The confirmed/documented
// endpoint analyzes a symbol+timeframe from live price bars (no screenshot).
// There is also an IMAGE-upload endpoint that showed up in FXSynapse's
// dashboard "Quick Start" box, but it has never been confirmed by FXSynapse
// (it even used a different domain, fxsynapse.com vs fxsynapseai.com). We are
// going with it here because that's what the UI needs, but treat its
// response shape as a best guess until it's confirmed — and note that
// nothing will actually call through successfully until the FXSynapse
// account has an active API plan (it currently does not).
const FXSYNAPSE_API_KEY = (process.env.FXSYNAPSE_API_KEY || "").trim();
const FXSYNAPSE_BASE_URL = (process.env.FXSYNAPSE_BASE_URL || "https://fxsynapseai.com")
  .trim()
  .replace(/\/+$/, "");
// Override if your brother confirms a different path/domain for the image endpoint.
const FXSYNAPSE_IMAGE_PATH = (process.env.FXSYNAPSE_IMAGE_PATH || "/api/v1/analyze").trim();

const VALID_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"];
const TIMEFRAME_LABELS = {
  M1: "1 minute", M5: "5 minutes", M15: "15 minutes", M30: "30 minutes",
  H1: "1 hour", H4: "4 hours",
  D1: "1 day", W1: "1 week", MN1: "1 month"
};
function isValidTimeframe(tf) {
  return VALID_TIMEFRAMES.includes(tf);
}

const ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 7 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error("Please upload a PNG, JPG or WEBP image."));
    }
    cb(null, true);
  }
});

// Supabase handles accounts. The URL and anon key are public by design (they
// ship to every browser) and access is enforced by Supabase itself. The
// service_role key must never be put here: it bypasses all of that.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();

// Who gets the admin page. Checked here AND again inside the
// admin_user_count() Postgres function (see supabase/admin_setup.sql) —
// two independent locks, so a bug in one does not expose the other.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "revealmabeba02@gmail.com").trim().toLowerCase();

// --- Credits / Binance Pay ------------------------------------------------
// Pay-per-scan credits. No Binance secret and no Supabase service_role key
// ever sit in the browser: the API key below is a READ-ONLY personal
// Binance key (Account > API Management, "Enable Reading" only — see
// supabase/credits_setup.sql for the full design) used only to check for
// incoming Binance Pay payments, and crediting a user's balance happens
// through a SECURITY DEFINER Postgres function guarded by a shared secret,
// the same pattern already used for the admin functions.
const BINANCE_API_KEY = (process.env.BINANCE_API_KEY || "").trim();
const BINANCE_API_SECRET = (process.env.BINANCE_API_SECRET || "").trim();
const BINANCE_PAY_ID = (process.env.BINANCE_PAY_ID || "1283803211").trim();
const CREDIT_FULFILL_SECRET = (process.env.CREDIT_FULFILL_SECRET || "").trim();
const CREDITS_READY = Boolean(BINANCE_API_KEY && BINANCE_API_SECRET && CREDIT_FULFILL_SECRET);

const CREDIT_BUNDLES = {
  starter: { scans: 20, amount: 8.99, label: "Starter" },
  trader: { scans: 60, amount: 12.99, label: "Trader" },
  pro: { scans: 150, amount: 19.99, label: "Pro" }
};

if (!CREDITS_READY) {
  console.warn(
    "\n[WARN] Credits are not fully configured: missing one of BINANCE_API_KEY, " +
    "BINANCE_API_SECRET, CREDIT_FULFILL_SECRET. Buying credits and the payment\n" +
    "poller will be disabled until all three are set. See supabase/credits_setup.sql.\n"
  );
}

// Read the "role" claim of a JWT-style key without verifying it. Used only to
// refuse a service_role key; never logged or returned.
function jwtRole(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role || null;
  } catch {
    return null;
  }
}

// Returns null when the settings look usable, otherwise a short reason.
// The reason names the variable and what is wrong, never the value itself.
function checkSupabaseConfig(url, key) {
  if (!url && !key) return "SUPABASE_URL and SUPABASE_ANON_KEY are both missing or empty.";
  if (!url) return "SUPABASE_URL is missing or empty.";
  if (!key) return "SUPABASE_ANON_KEY is missing or empty.";

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "SUPABASE_URL is not a valid URL. It should look like https://your-ref.supabase.co";
  }
  // http is accepted only for a Supabase project running on this computer
  // (the Supabase CLI serves http://127.0.0.1:54321).
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    return "SUPABASE_URL must start with https://";
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return "SUPABASE_URL should be the bare Project URL, with nothing after the domain.";
  }
  if (/your-project|project-ref|[<>]/i.test(url)) {
    return "SUPABASE_URL is still the placeholder from .env.example.";
  }

  if (/^(your|paste|xxx|<)/i.test(key) || /anon-public-key|paste-the/i.test(key)) {
    return "SUPABASE_ANON_KEY is still the placeholder from .env.example.";
  }
  if (key.startsWith("sb_secret_") || jwtRole(key) === "service_role") {
    return "SUPABASE_ANON_KEY is a service_role/secret key. Use the anon/public (publishable) key only.";
  }
  if (key.length <= 40) return "SUPABASE_ANON_KEY is too short to be a real key.";
  return null;
}

const SUPABASE_PROBLEM = checkSupabaseConfig(SUPABASE_URL, SUPABASE_ANON_KEY);
const SUPABASE_READY = !SUPABASE_PROBLEM;

if (envLoad.error) {
  console.warn(
    envLoad.error.code === "ENOENT"
      ? "\n[WARN] No .env file found at server/.env. Using environment variables only.\n"
      : `\n[WARN] Could not read server/.env (${envLoad.error.code || "unknown error"}).\n`
  );
}

if (!SUPABASE_READY) {
  console.warn(
    `\n[WARN] Supabase is not configured: ${SUPABASE_PROBLEM}\n` +
    "Pages will load, but sign up, log in and scanning are disabled until\n" +
    "SUPABASE_URL and SUPABASE_ANON_KEY are set in server/.env. See SUPABASE_SETUP.md.\n"
  );
}

if (!FXSYNAPSE_API_KEY) {
  console.error(
    "\n[FATAL] FXSYNAPSE_API_KEY is not set.\n" +
    "Copy server/.env.example to server/.env and add your key, or set it in\n" +
    "your host's environment variables. Get one from the API Access section\n" +
    "of https://fxsynapseai.com/dashboard.\n"
  );
  process.exit(1);
}

const app = express();

// Trust the first proxy hop (needed for correct rate-limit IPs behind
// something like Render/Heroku/Nginx). Harmless for local dev.
app.set("trust proxy", 1);

app.use(
  cors({
    origin: CORS_ORIGIN.split(",").map((s) => s.trim()),
    methods: ["GET", "POST"]
  })
);

app.use(express.json({ limit: "1mb" }));

// --- Pages ---------------------------------------------------------------
// Supabase keeps the session in the browser, so /app checks for it on load
// and sends logged out visitors to /login. That redirect is a convenience;
// the real gate is requireUser on /api/analyze below.
const PAGES = path.join(__dirname, "..", "pages");
const page = (name) => path.join(PAGES, name);

app.get("/", (req, res) => res.sendFile(page("landing.html")));
app.get("/login", (req, res) => res.sendFile(page("login.html")));
app.get("/signup", (req, res) => res.sendFile(page("signup.html")));
app.get("/app", (req, res) => res.sendFile(page("app.html")));
app.get("/admin", (req, res) => res.sendFile(page("admin.html")));

// Public Supabase settings for the browser, generated from .env so the keys
// live in one place.
app.get("/config.js", (req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-store");
  res.send(
    "window.APP_CONFIG = " +
      JSON.stringify({
        // Only hand values to the browser once they have passed the checks
        // above, so a misplaced secret key is never served from here.
        supabaseUrl: SUPABASE_READY ? SUPABASE_URL : "",
        supabaseAnonKey: SUPABASE_READY ? SUPABASE_ANON_KEY : "",
        ready: SUPABASE_READY
      }) +
      ";"
  );
});

app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));

// --- Auth gate ---------------------------------------------------------------
// The browser sends its Supabase access token; Supabase confirms who it
// belongs to. A forged, expired or signed out token gets a 401, so nobody
// can spend the FXSynapse key without an account.
async function requireUser(req, res, next) {
  if (!SUPABASE_READY) {
    return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  }
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!match) {
    return res.status(401).json({ error: "Please log in to scan charts." });
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${match[1]}` },
      signal: AbortSignal.timeout(8000)
    });
    if (r.status === 401 || r.status === 403) {
      return res.status(401).json({ error: "Your session has expired. Please log in again." });
    }
    if (!r.ok) {
      console.error("Supabase user check failed:", r.status);
      return res.status(502).json({ error: "Could not verify your account right now. Please try again." });
    }
    const user = await r.json();
    if (!user?.id) {
      return res.status(401).json({ error: "Please log in to scan charts." });
    }
    req.user = { id: user.id, email: user.email, token: match[1] };
    next();
  } catch (err) {
    console.error("Supabase user check error:", err.message);
    res.status(502).json({ error: "Could not verify your account right now. Please try again." });
  }
}

// --- Basic abuse protection -------------------------------------------
// Analysis calls cost real money server-side, so this endpoint is rate
// limited independent of any limits your hosting provider applies.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a minute and try again." }
});

// --- Routes -------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ ok: true, provider: "fxsynapse", accounts: SUPABASE_READY, credits: CREDITS_READY });
});

// --- FXSynapse response shaping ------------------------------------------
// The scanner's result screen expects one steady shape regardless of what
// changed upstream: { pair_guess, market_bias, market_structure, ... }. This
// turns FXSynapse's own JSON (symbol, marketStructure, levels, plan,
// concepts, topDown, ...) into that same shape, so the result UI didn't
// need to be rebuilt from scratch.
function fmtNum(n) {
  return typeof n === "number" ? String(n) : n != null ? String(n) : "—";
}

function describeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels.slice(0, 6).map((lvl) => {
    const rej =
      lvl && lvl.rejections != null
        ? ` · ${lvl.rejections} rejection${lvl.rejections === 1 ? "" : "s"}`
        : "";
    return `${fmtNum(lvl?.low)} – ${fmtNum(lvl?.high)}${rej}`;
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

function conceptSummary(concepts) {
  if (!concepts || typeof concepts !== "object") return "";
  const parts = Object.entries(concepts)
    .filter(([, v]) => v && v.found)
    .map(([key, v]) => `${key.toUpperCase()} ×${v.found}`);
  return parts.length ? `Detected: ${parts.join(", ")}.` : "";
}

function mapFxSynapseToAnalysis(fx) {
  const plan = fx.plan || {};
  const planOk = !!plan.ok;
  const bias = planOk && plan.side
    ? (String(plan.side).toLowerCase() === "buy" ? "Bullish" : "Bearish")
    : biasFromStructure(fx.marketStructure);

  const entries = planOk
    ? [{
        type: String(plan.side || "").toLowerCase() === "buy" ? "Long" : "Short",
        entry_zone: fmtNum(plan.entry),
        trigger: "Rule-based structure entry, calculated from live price bars.",
        rationale: "Derived from detected market structure, levels and order flow — not a visual read of a screenshot."
      }]
    : [];

  const targets = Array.isArray(plan.targets)
    ? plan.targets.map((t) => ({ target: fmtNum(t), rationale: "" }))
    : [];

  const firstTarget = Array.isArray(plan.targets) && typeof plan.targets[0] === "number" ? plan.targets[0] : null;
  const rr = planOk ? computeRR(plan.entry, plan.stop, firstTarget) : null;

  const notesParts = [];
  const cs = conceptSummary(fx.concepts);
  if (cs) notesParts.push(cs);
  if (typeof fx.bars === "number") notesParts.push(`Measured over the last ${fx.bars} bars.`);
  if (!fx.symbol) {
    notesParts.push("Could not read the pair from this screenshot — crop it so the symbol name (e.g. EURUSD) is clearly visible, then rescan.");
  } else if (!planOk) {
    notesParts.push("No clean directional plan on this pair/timeframe right now — structure is unclear or conflicting.");
  }

  const structureLabel = (fx.marketStructure || "range").replace(/^\w/, (c) => c.toUpperCase());

  return {
    pair_guess: fx.symbol || null,
    market_bias: bias,
    confidence: null,
    bars: typeof fx.bars === "number" ? fx.bars : null,
    market_structure: {
      trend: `${structureLabel} market structure, measured directly from live price bars (no screenshot involved).`,
      key_levels: describeLevels(fx.levels),
      chart_pattern: null
    },
    potential_entries: entries,
    stop_loss: {
      suggestion: planOk ? fmtNum(plan.stop) : "—",
      rationale: planOk ? "Calculated from the nearest invalidating structure." : ""
    },
    take_profit: targets,
    risk_reward_estimate: rr,
    invalidation: planOk
      ? `Plan is invalidated if price closes back through ${fmtNum(plan.stop)}.`
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

// --- Scan history ---------------------------------------------------------
// One row per successful scan, written with the user's own access token so
// Supabase's row-level security (not this server) decides who can read or
// write it. Requires a `scan_history` table with RLS policies scoping each
// row to its own user_id — see supabase/scan_history.sql in the repo root.
async function saveHistoryRow(user, analysis, timeframe) {
  if (!SUPABASE_READY || !user?.token) return;
  const firstEntry = Array.isArray(analysis.potential_entries) ? analysis.potential_entries[0] : null;
  const side = (firstEntry?.type || "").toLowerCase();
  const signal = side === "long" ? "buy" : side === "short" ? "sell" : null;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/scan_history`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${user.token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        user_id: user.id,
        pair: analysis.pair_guess || null,
        timeframe,
        bias: analysis.market_bias || null,
        signal
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Could not save scan history:", r.status, await r.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Scan history save error:", err.message);
  }
}

// --- Credits ---------------------------------------------------------------
// Thin helper around Supabase's RPC endpoint. `token` is the caller's own
// access token for user-facing functions, or just SUPABASE_ANON_KEY for the
// "system" functions that take a secret instead of checking auth.uid().
async function supabaseRpc(fnName, args, token) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args || {}),
    signal: AbortSignal.timeout(8000)
  });
  const raw = await r.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* leave null */
  }
  if (!r.ok) {
    const message = (data && (data.message || data.error)) || raw.slice(0, 300) || `RPC ${fnName} failed`;
    throw new Error(message);
  }
  return data;
}

// Best-effort refund: a failed scan should never cost a credit, but if the
// refund call itself fails, we log it rather than blocking the error
// response the user is already waiting on.
async function refundIfSpent(user, wasSpent) {
  if (!wasSpent) return;
  try {
    await supabaseRpc("refund_credit", {}, user.token);
  } catch (err) {
    console.error("Credit refund failed:", err.message);
  }
}

app.get("/api/credits/balance", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const balance = await supabaseRpc("my_credit_balance", {}, req.user.token);
    res.json({ balance: typeof balance === "number" ? balance : 0 });
  } catch (err) {
    console.error("Credit balance error:", err.message);
    res.status(502).json({ error: "Could not load your credit balance." });
  }
});

app.get("/api/credits/orders", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/credit_orders?select=id,bundle,scans,amount_usd,status,created_at,paid_at&order=created_at.desc&limit=20`,
      {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!r.ok) {
      console.error("Orders fetch failed:", r.status, await r.text().catch(() => ""));
      return res.json({ orders: [] });
    }
    const orders = await r.json();
    res.json({ orders: Array.isArray(orders) ? orders : [] });
  } catch (err) {
    console.error("Orders fetch error:", err.message);
    res.json({ orders: [] });
  }
});

app.post("/api/credits/order", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if (!CREDITS_READY) return res.status(503).json({ error: "Buying credits is not set up on this server yet." });

  const bundle = String(req.body?.bundle || "").trim().toLowerCase();
  if (!CREDIT_BUNDLES[bundle]) {
    return res.status(400).json({ error: "Unknown credit bundle." });
  }

  try {
    const order = await supabaseRpc("create_credit_order", { p_bundle: bundle }, req.user.token);
    res.json({
      order,
      payTo: { binancePayId: BINANCE_PAY_ID },
      instructions:
        `Send exactly $${Number(order.amount_usd).toFixed(2)} (USDT or equivalent) via Binance Pay to Binance ID ${BINANCE_PAY_ID}. ` +
        "Your credits are added automatically once the payment is detected — usually within a minute."
    });
  } catch (err) {
    console.error("Create order error:", err.message);
    res.status(502).json({ error: "Could not start that order. Please try again." });
  }
});

// --- Binance Pay poller ----------------------------------------------------
// Background job, not tied to any one request: every POLL interval, ask
// Postgres for pending orders (via the shared-secret system function) and
// ask Binance for recent incoming Pay transactions, then match them by
// amount. The exact shape of Binance's /sapi/v1/pay/transactions response
// has not been confirmed against this live account yet (no order has gone
// through it so far) — this is built strictly from Binance's published API
// docs, so if it turns out the field names differ, this will need a real
// payment to compare the raw response against and adjust.
const crypto = require("crypto");

async function binanceSignedGet(urlPath, params) {
  const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "10000" });
  const signature = crypto.createHmac("sha256", BINANCE_API_SECRET).update(query.toString()).digest("hex");
  query.append("signature", signature);
  const r = await fetch(`https://api.binance.com${urlPath}?${query.toString()}`, {
    headers: { "X-MBX-APIKEY": BINANCE_API_KEY },
    signal: AbortSignal.timeout(10000)
  });
  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Binance returned non-JSON (${r.status}): ${raw.slice(0, 200)}`);
  }
  if (!r.ok) {
    throw new Error(`Binance error ${r.status}: ${data?.msg || raw.slice(0, 200)}`);
  }
  return data;
}

// Pulls recent Binance Pay transactions. Best-effort: on anything going
// wrong (wrong field names, a changed endpoint, a bad key) this logs and
// returns an empty list rather than crashing the poller loop.
async function fetchRecentBinancePayTransactions() {
  try {
    const data = await binanceSignedGet("/sapi/v1/pay/transactions", {
      startTime: String(Date.now() - 48 * 60 * 60 * 1000)
    });
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return list
      .filter((t) => {
        const type = String(t.orderType || t.transactionType || "").toUpperCase();
        // Keep only money coming IN. Binance's own field naming for this
        // isn't confirmed yet (see comment above) — "PAY" / "C2C" / a
        // positive amount with no outgoing marker are the best guesses.
        return !type.includes("WITHDRAW") && !type.includes("SEND");
      })
      .map((t) => ({
        id: String(t.transactionId || t.orderId || t.id || ""),
        amount: Number(t.amount ?? t.orderAmount ?? t.totalFee ?? 0),
        currency: String(t.currency || t.fiatCurrency || "USDT"),
        time: Number(t.transactionTime || t.createTime || 0)
      }))
      .filter((t) => t.id && t.amount > 0);
  } catch (err) {
    console.error("Binance transactions fetch error:", err.message);
    return [];
  }
}

async function pollBinancePayments() {
  if (!CREDITS_READY || !SUPABASE_READY) return;
  try {
    const pendingOrders = await supabaseRpc(
      "list_pending_orders",
      { p_secret: CREDIT_FULFILL_SECRET },
      SUPABASE_ANON_KEY
    );
    if (!Array.isArray(pendingOrders) || pendingOrders.length === 0) return;

    const transactions = await fetchRecentBinancePayTransactions();
    if (transactions.length === 0) return;

    const usedTxIds = new Set();
    for (const order of pendingOrders) {
      const orderCreatedMs = new Date(order.created_at).getTime();
      const amount = Number(order.amount_usd);
      const match = transactions.find(
        (t) =>
          !usedTxIds.has(t.id) &&
          Math.abs(t.amount - amount) < 0.02 &&
          (!t.time || t.time >= orderCreatedMs - 2 * 60 * 1000)
      );
      if (!match) continue;

      try {
        await supabaseRpc(
          "admin_credit_order",
          { p_order_id: order.id, p_secret: CREDIT_FULFILL_SECRET },
          SUPABASE_ANON_KEY
        );
        usedTxIds.add(match.id);
        console.log(`Credited order ${order.id} (${order.scans} scans) after matching Binance Pay transaction ${match.id}.`);
      } catch (err) {
        console.error(`Could not credit order ${order.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Payment poll error:", err.message);
  }
}

if (CREDITS_READY && SUPABASE_READY) {
  const POLL_MS = Number(process.env.CREDIT_POLL_INTERVAL_MS) || 20000;
  setInterval(pollBinancePayments, POLL_MS);
  console.log(`Binance Pay poller running every ${Math.round(POLL_MS / 1000)}s.`);
}

app.get("/api/history", requireUser, async (req, res) => {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/scan_history?select=pair,timeframe,bias,signal,created_at&order=created_at.desc&limit=50`,
      {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!r.ok) {
      // Most likely cause: the scan_history table/policies don't exist yet.
      console.error("History fetch failed:", r.status, await r.text().catch(() => ""));
      return res.json({ items: [] });
    }
    const items = await r.json();
    res.json({ items: Array.isArray(items) ? items : [] });
  } catch (err) {
    console.error("History fetch error:", err.message);
    res.json({ items: [] });
  }
});

// --- Admin ---------------------------------------------------------------
// Only the configured ADMIN_EMAIL gets anything back. The real security
// boundary is in Postgres (admin_user_count() checks the caller's own
// email again) — this check is just a fast, friendly reject for everyone
// else, and keeps unauthorized calls from spending a round trip.
app.get("/api/admin/stats", requireUser, async (req, res) => {
  if (!SUPABASE_READY) {
    return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  }
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const totalUsers = await supabaseRpc("admin_user_count", {}, req.user.token).catch((err) => {
      console.error("Admin stats RPC failed:", err.message);
      return null;
    });
    // Paying-users count needs supabase/credits_setup.sql to have been run;
    // fail soft (null, shown as "—" by admin.html) rather than taking the
    // whole stats card down if it hasn't been yet.
    const payingUsers = await supabaseRpc("admin_paying_users_count", {}, req.user.token).catch((err) => {
      console.error("Admin paying-users RPC failed:", err.message);
      return null;
    });
    if (totalUsers === null) {
      return res.status(502).json({ error: "Could not load admin stats. Has supabase/admin_setup.sql been run yet?" });
    }
    res.json({
      totalUsers: typeof totalUsers === "number" ? totalUsers : null,
      payingUsers: typeof payingUsers === "number" ? payingUsers : null
    });
  } catch (err) {
    console.error("Admin stats error:", err.message);
    res.status(502).json({ error: "Could not load admin stats." });
  }
});

// Same admin-only pattern as /api/admin/stats, but the actual user list
// (name, email, signup date). admin_list_users() in Postgres re-checks the
// admin email independently — see supabase/admin_setup.sql.
app.get("/api/admin/users", requireUser, async (req, res) => {
  if (!SUPABASE_READY) {
    return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  }
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_users`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${req.user.token}`,
        "Content-Type": "application/json"
      },
      body: "{}",
      signal: AbortSignal.timeout(8000)
    });
    const raw = await r.text();
    if (!r.ok) {
      console.error("Admin users RPC failed:", r.status, raw.slice(0, 300));
      return res.status(502).json({ error: "Could not load users. Has the latest supabase/admin_setup.sql been run?" });
    }
    let users = [];
    try {
      const parsed = JSON.parse(raw);
      users = Array.isArray(parsed) ? parsed : [];
    } catch {
      /* leave empty, handled below */
    }

    // Merge in who has actually paid. Soft-fails to "no paid data" if
    // credits_setup.sql hasn't been run yet, rather than breaking the whole
    // user list.
    const paidSummary = await supabaseRpc("admin_paid_summary", {}, req.user.token).catch((err) => {
      console.error("Admin paid summary RPC failed:", err.message);
      return [];
    });
    const paidByUser = new Map(
      (Array.isArray(paidSummary) ? paidSummary : []).map((row) => [row.user_id, row])
    );
    users = users.map((u) => {
      const paid = paidByUser.get(u.id);
      return {
        ...u,
        paid_usd: paid ? Number(paid.paid_usd) : 0,
        paid_scans: paid ? Number(paid.paid_scans) : 0,
        orders_count: paid ? Number(paid.orders_count) : 0
      };
    });

    res.json({ users });
  } catch (err) {
    console.error("Admin users error:", err.message);
    res.status(502).json({ error: "Could not load users." });
  }
});

app.post("/api/analyze", requireUser, analyzeLimiter, (req, res) => {
  upload.single("image")(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg =
        uploadErr.code === "LIMIT_FILE_SIZE"
          ? "That image is too large. Keep it under 7MB."
          : uploadErr.message || "Could not read the uploaded image.";
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Upload a chart screenshot first." });
    }

    const timeframe = String(req.body.timeframe || "").trim().toUpperCase();
    if (timeframe && !isValidTimeframe(timeframe)) {
      return res.status(400).json({ error: "Invalid timeframe." });
    }

    // Spend one credit up front. If the user has none left, stop here —
    // never call FXSynapse (which costs real money) for a request that
    // can't be charged. If the scan itself fails below, the credit is
    // refunded, so a failed scan never costs the user anything.
    let creditSpent = false;
    if (CREDITS_READY) {
      try {
        await supabaseRpc("spend_credit", {}, req.user.token);
        creditSpent = true;
      } catch (err) {
        return res.status(402).json({
          error: "You're out of scan credits. Buy more to keep scanning.",
          code: "no_credits"
        });
      }
    }

    try {
      const form = new FormData();
      form.append(
        "image",
        new Blob([req.file.buffer], { type: req.file.mimetype }),
        req.file.originalname || "chart.png"
      );
      if (timeframe) form.append("timeframe", timeframe);

      const fxRes = await fetch(`${FXSYNAPSE_BASE_URL}${FXSYNAPSE_IMAGE_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${FXSYNAPSE_API_KEY}` },
        body: form,
        // 55s gives slow image analysis room to finish without railing past
        // Render's own ~60s request ceiling.
        signal: AbortSignal.timeout(55000)
      });

      const rawBody = await fxRes.text();
      let fxData;
      try {
        fxData = JSON.parse(rawBody);
      } catch {
        console.error("FXSynapse returned non-JSON response:", rawBody.slice(0, 500));
        await refundIfSpent(req.user, creditSpent);
        return res.status(502).json({ error: "The analysis provider sent back something unreadable. Please try again." });
      }

      if (!fxRes.ok) {
        console.error("FXSynapse error:", fxRes.status, fxData);
        // Reply with our own HTTP status here, never the provider's. In
        // particular, never send back a bare 401: the browser treats a 401
        // from this endpoint as "your login session was rejected" and signs
        // you out (see the 401 handling in app.js). A bad or expired
        // FXSYNAPSE_API_KEY, or no active API plan, is a server-side/provider
        // problem, not a user auth problem, and must not log the user out.
        const message =
          fxRes.status === 401 || fxRes.status === 403
            ? "Analysis provider rejected the request (no active API plan or invalid key)."
            : fxRes.status === 429
            ? "Rate limited by the analysis provider. Please try again shortly."
            : fxData?.error || "Something went wrong while analyzing that chart.";
        await refundIfSpent(req.user, creditSpent);
        return res.status(502).json({ error: message });
      }

      const analysis = mapFxSynapseToAnalysis(fxData);
      res.json({ analysis, timeframe: timeframe || null });
      saveHistoryRow(req.user, analysis, timeframe || null); // fire-and-forget, never blocks the response
    } catch (err) {
      console.error("Analysis error:", err);
      await refundIfSpent(req.user, creditSpent);
      res.status(502).json({ error: "Something went wrong while analyzing that chart. Please try again." });
    }
  });
});

// Unknown API routes get JSON; unknown pages go back to the landing page.
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.get("*", (req, res) => res.redirect("/"));

// Last resort, so an unexpected error returns JSON rather than an HTML stack trace.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log(`Vertex Chart Scanner running at http://localhost:${PORT}`);
  console.log(`Using provider: FXSynapse AI (${FXSYNAPSE_BASE_URL})`);
});
