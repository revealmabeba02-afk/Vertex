const path = require("path");
const crypto = require("crypto");

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

// FXSynapse AI provides the actual chart analysis. Confirmed 2026-10-04
// straight from their own API reference (fxsynapseai.com/dashboard ->
// Docs): one real endpoint, POST /api/v1/chart, which takes a symbol +
// timeframe and reads live price bars itself — there is no image-upload
// endpoint at all. The earlier image-based flow was hitting a guessed,
// never-confirmed path and failing almost every call.
const FXSYNAPSE_API_KEY = (process.env.FXSYNAPSE_API_KEY || "").trim();
const FXSYNAPSE_BASE_URL = (process.env.FXSYNAPSE_BASE_URL || "https://fxsynapseai.com")
  .trim()
  .replace(/\/+$/, "");
const FXSYNAPSE_CHART_PATH = (process.env.FXSYNAPSE_CHART_PATH || "/api/v1/chart").trim();

// Confirmed set from FXSynapse's docs — they do not support MN1 (monthly).
const VALID_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];
const TIMEFRAME_LABELS = {
  M1: "1 minute", M5: "5 minutes", M15: "15 minutes", M30: "30 minutes",
  H1: "1 hour", H4: "4 hours",
  D1: "1 day", W1: "1 week"
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
  quick: { scans: 10, amount: 4.99, label: "Quick" },
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

// --- Credits / Whop --------------------------------------------------------
// Replaces Binance Pay as the primary way to buy credits (Binance's API
// blocks requests from Render's server region with HTTP 451 — see the
// pollBinancePayments code below). The Binance code stays in place as a
// fallback but the /credits page now sends people to these Whop checkout
// links instead.
//
// How a Whop payment gets credited: Whop sends a payment.succeeded webhook
// to /api/webhooks/whop. We verify it's really from Whop (Standard
// Webhooks-style HMAC signature, per Whop's docs), then match the payment
// to a bundle by the amount paid (same trick used for Binance) and to a
// Vertex account by the buyer's email, via the whop_credit_by_email()
// Postgres function (supabase/whop_setup.sql).
//
// NOTE ON FIELD NAMES: Whop's exact webhook payload field names for the
// buyer's email weren't fully confirmed from their public docs at the time
// this was built — the handler below tries several likely locations and
// logs the full raw payload either way, so the first real test payment can
// be checked against Render's logs and the extraction adjusted if needed.
const WHOP_WEBHOOK_SECRET = (process.env.WHOP_WEBHOOK_SECRET || "").trim();
const WHOP_API_KEY = (process.env.WHOP_API_KEY || "").trim();
const WHOP_READY = Boolean(WHOP_WEBHOOK_SECRET);

const WHOP_CHECKOUT_LINKS = {
  quick: process.env.WHOP_CHECKOUT_QUICK || "https://whop.com/shadowfx-1eca/quick-5e/",
  starter: process.env.WHOP_CHECKOUT_STARTER || "https://whop.com/shadowfx-1eca/starter-20-scans",
  trader: process.env.WHOP_CHECKOUT_TRADER || "https://whop.com/shadowfx-1eca/trader-60-scans",
  pro: process.env.WHOP_CHECKOUT_PRO || "https://whop.com/shadowfx-1eca/pro-150-scans"
};

if (!WHOP_READY) {
  console.warn(
    "\n[WARN] WHOP_WEBHOOK_SECRET is not set. Whop checkout links will still\n" +
    "show on the credits page, but payments won't auto-credit until this is set.\n"
  );
}

// --- Credits / Whop custom amount -----------------------------------------
// "Name your price" top-up, on top of the 4 fixed bundles. Unlike those
// (static checkout links created once by hand in the Whop dashboard), a
// custom amount has to be priced at the moment the person picks it, so this
// calls Whop's API to create a one-off plan for that exact price and sends
// the person to the purchase_url it returns. Needs a Whop API key
// (dashboard > Settings > API Keys) and one Whop product to attach these
// one-off plans to (any existing product works, or a plain hidden one made
// just for this) — set WHOP_API_KEY and WHOP_CUSTOM_PRODUCT_ID in Render to
// turn this on; until then the custom-amount box just says so.
//
// NOTE ON FIELD NAMES: same caveat as the webhook extraction above — Whop's
// exact plan-creation response field for the checkout link wasn't fully
// confirmed from their public docs. The code below checks the few likely
// field names and logs the full response if none match, so the first real
// attempt can be checked against Render's logs and adjusted if needed.
const WHOP_CUSTOM_PRODUCT_ID = (process.env.WHOP_CUSTOM_PRODUCT_ID || "").trim();
const WHOP_CUSTOM_READY = Boolean(WHOP_API_KEY && WHOP_CUSTOM_PRODUCT_ID);
const CUSTOM_PRICE_PER_SCAN = 0.5; // same per-scan rate as the Quick bundle ($4.99 / 10)
const CUSTOM_MIN_AMOUNT = 5;
const CUSTOM_MAX_AMOUNT = 500;

function scansForCustomAmount(amountUsd) {
  return Math.max(1, Math.round(amountUsd / CUSTOM_PRICE_PER_SCAN));
}

if (!WHOP_CUSTOM_READY) {
  console.warn(
    "\n[WARN] WHOP_API_KEY and/or WHOP_CUSTOM_PRODUCT_ID not set. The \"name\n" +
    "your price\" custom amount box will show but tell people it's not ready yet.\n"
  );
}

// Matches a paid amount to one of the 3 bundles, same ±$0.02 tolerance used
// for Binance.
function bundleByAmount(amountUsd) {
  const entries = Object.entries(CREDIT_BUNDLES);
  for (const [key, bundle] of entries) {
    if (Math.abs(bundle.amount - amountUsd) < 0.02) return { key, ...bundle };
  }
  return null;
}

// Verifies a Whop webhook per the Standard Webhooks pattern their docs
// describe: HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{raw body}",
// signed with the webhook secret (the "ws_..." value), base64-encoded, sent
// as "v1,<signature>" in the webhook-signature header.
function verifyWhopSignature(rawBody, headers) {
  if (!WHOP_READY) return false;
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatureHeader = headers["webhook-signature"];
  if (!id || !timestamp || !signatureHeader) return false;

  // Reject anything older than 5 minutes, per Whop's docs.
  const ts = Number(timestamp);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", WHOP_WEBHOOK_SECRET).update(signedContent).digest("base64");

  // The header can carry multiple "v1,<sig>" values space-separated; match
  // against any of them.
  const candidates = String(signatureHeader)
    .split(" ")
    .map((s) => s.split(",")[1])
    .filter(Boolean);
  return candidates.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, "base64"), Buffer.from(expected, "base64"));
    } catch {
      return false;
    }
  });
}

// Best-effort extraction — see the NOTE above on unconfirmed field names.
function extractWhopPaymentFields(data) {
  const email =
    data?.email ||
    data?.user?.email ||
    data?.member?.email ||
    data?.buyer?.email ||
    data?.customer?.email ||
    null;
  const amountRaw =
    data?.final_amount ?? data?.amount ?? data?.subtotal ?? data?.total ?? null;
  const amount = amountRaw !== null ? Number(amountRaw) : null;
  const id = data?.id || data?.payment_id || null;
  return { email, amount, id };
}

// --- Support AI triage -----------------------------------------------------
// Optional: without this key, support messages still save and show up on
// the admin page fine — they just sit as plain "open" messages with no AI
// suggestion, same as before this feature existed. Get a key from
// https://console.anthropic.com/settings/keys.
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const SUPPORT_AI_MODEL = (process.env.SUPPORT_AI_MODEL || "claude-haiku-4-5-20251001").trim();

const SUPPORT_AI_SYSTEM_PROMPT = `You are the support triage assistant for Vertex Chart Scanner (vertex-9s4c.onrender.com), a forex chart analysis tool.

What Vertex does: users type a pair/symbol (e.g. EURUSD, XAUUSD, US30) and pick a timeframe, and get back a technical read calculated from live price bars — market bias, structure, key levels, a BUY/SELL/No-trade signal, stop loss, and take-profit targets. No chart screenshot is needed or accepted. It is a technical read, not financial advice.

Billing: every signed-in user gets 4 free scans a day, resetting at midnight UTC. Beyond that, pay-per-scan credits are bought via Whop, either as a fixed bundle (Quick $4.99/10 scans, Starter $8.99/20 scans, Trader $12.99/60 scans, Pro $19.99/150 scans) or as a custom "name your price" amount from $5, credited at the same ~$0.50/scan rate. Credits never expire. Payment is usually credited within about a minute of paying, as long as the buyer uses the same email at Whop checkout as their Vertex login. A failed scan automatically refunds whatever it used (a free scan or a paid credit).

News tab: a live economic calendar (NFP, CPI, PMIs, etc.). Small/medium events are fully free, including a BUY/SELL read once released. Big ("High" importance) events are free to see on the calendar (time, forecast, previous) but the actual-vs-forecast result and its BUY/SELL read only unlock after the event releases, and unlocking costs one of 2 free monthly unlocks per user — after that, more unlocks aren't available yet (a paid tier is planned).

Known quirk: this runs on a free hosting tier that goes to sleep after a few minutes of no traffic. The very first request after that can take up to ~50 seconds and may show "Could not reach the server" — simply retrying a few seconds later almost always works. This is not a bug.

A user has submitted a support message. Decide: can you answer this confidently and completely using ONLY the information above, with a short, warm, helpful reply? Or does it need a human (account-specific issues, refund requests, bug reports, anything requiring looking something up, or anything outside what's described above)?

Reply with ONLY a JSON object, no other text, in exactly this shape:
{"confidence":"high","reply":"..."} — for a question you can fully answer from the information above
{"confidence":"low","reply":"..."} — a best-effort DRAFT reply for a human to review and edit before sending; still write something useful, just don't claim certainty about anything you don't actually know

Keep replies under 120 words, friendly, plain text (no markdown).`;

async function aiTriageSupportMessage(message) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: SUPPORT_AI_MODEL,
        max_tokens: 400,
        system: SUPPORT_AI_SYSTEM_PROMPT,
        messages: [{ role: "user", content: message }]
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Support AI error:", r.status, data);
      return null;
    }
    const text = Array.isArray(data.content) ? data.content.map((b) => b.text || "").join("") : "";
    const parsed = JSON.parse(text.trim());
    if (!parsed || typeof parsed.reply !== "string") return null;
    return { confidence: parsed.confidence === "high" ? "high" : "low", reply: parsed.reply.trim() };
  } catch (err) {
    console.error("Support AI triage failed:", err.message);
    return null;
  }
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

// Mounted BEFORE express.json() because the signature must be verified
// against the exact raw request bytes, not a re-serialized copy.
app.post("/api/webhooks/whop", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : "";
  if (!verifyWhopSignature(rawBody, req.headers)) {
    console.error("Whop webhook: signature verification failed.");
    return res.status(401).json({ error: "Invalid signature." });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON." });
  }

  // Logged regardless of outcome — this is what lets us confirm/adjust the
  // field names in extractWhopPaymentFields() against a real payment.
  console.log("Whop webhook received:", JSON.stringify(event).slice(0, 2000));

  // Acknowledge immediately; do the actual crediting after. Whop only cares
  // about getting a 2xx within 5 seconds.
  res.status(200).json({ ok: true });

  if (event?.type !== "payment.succeeded") return;
  if (!SUPABASE_READY || !WHOP_READY) return;

  try {
    const { email, amount, id } = extractWhopPaymentFields(event.data || {});
    if (!email || amount === null || !id) {
      console.error("Whop webhook: could not extract email/amount/id from payload.", { email: Boolean(email), amount, id });
      return;
    }
    const bundle = bundleByAmount(amount);
    let p_bundle, p_scans, p_amount_usd;
    if (bundle) {
      p_bundle = bundle.key;
      p_scans = bundle.scans;
      p_amount_usd = bundle.amount;
    } else if (amount >= CUSTOM_MIN_AMOUNT) {
      // Doesn't match a fixed bundle's price — treat it as a custom-amount
      // purchase and credit scans at the same rate used to sell it.
      p_bundle = "custom";
      p_scans = scansForCustomAmount(amount);
      p_amount_usd = amount;
    } else {
      console.error(`Whop webhook: paid amount $${amount} doesn't match any known bundle.`);
      return;
    }
    const result = await supabaseRpc(
      "whop_credit_by_email",
      {
        p_email: email,
        p_bundle,
        p_scans,
        p_amount_usd,
        p_external_id: String(id),
        p_secret: CREDIT_FULFILL_SECRET
      },
      SUPABASE_ANON_KEY
    );
    console.log("Whop webhook: credited", result);

    // Real money just changed hands — if this buyer was referred by someone
    // and hasn't triggered a reward yet, pay the referrer now. Best-effort:
    // never block or fail the purchase over this.
    try {
      const rewardResult = await supabaseRpc(
        "reward_referral_on_purchase",
        { p_email: email, p_secret: CREDIT_FULFILL_SECRET },
        SUPABASE_ANON_KEY
      );
      if (rewardResult?.rewarded) console.log("Referral reward paid:", rewardResult);
    } catch (refErr) {
      console.error("Referral reward check failed:", refErr.message);
    }
  } catch (err) {
    console.error("Whop webhook: crediting failed:", err.message);
  }
});

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

function mapFxSynapseToAnalysis(fx) {
  const plan = fx.plan || {};
  const planOk = !!plan.ok;
  const digits = typeof fx.digits === "number" ? fx.digits : null;
  const bias = planOk && plan.side
    ? (String(plan.side).toLowerCase() === "buy" ? "Bullish" : "Bearish")
    : biasFromStructure(fx.marketStructure);

  const entries = planOk
    ? [{
        type: String(plan.side || "").toLowerCase() === "buy" ? "Long" : "Short",
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

// One row per failed scan, same RLS pattern as scan history — written with
// the user's own token so Supabase decides who can insert, never read by
// anyone but the admin (via admin_scan_failure_summary). Best-effort: a
// logging failure must never affect the error response the user is waiting
// on, so this is fire-and-forget and only ever logs to the console on error.
async function saveScanFailure(user, pair, timeframe, reason) {
  if (!SUPABASE_READY || !user?.token) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/scan_failures`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${user.token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ user_id: user.id, pair: pair || null, timeframe: timeframe || null, reason: reason || null }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Could not save scan failure:", r.status, await r.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Scan failure save error:", err.message);
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
async function refundIfSpent(user, source) {
  if (!source) return;
  try {
    await supabaseRpc("refund_scan", { p_source: source }, user.token);
  } catch (err) {
    console.error("Scan refund failed:", err.message);
  }
}

app.get("/api/credits/balance", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const [balance, freeRemaining] = await Promise.all([
      supabaseRpc("my_credit_balance", {}, req.user.token),
      // Added 2026-10-05 alongside free daily scans. Fails soft to null (not
      // 0) on an old deployment that hasn't run supabase/free_scans.sql yet,
      // so the UI can tell "no free scans configured" apart from "0 left".
      supabaseRpc("free_scans_remaining", {}, req.user.token).catch(() => null)
    ]);
    res.json({
      balance: typeof balance === "number" ? balance : 0,
      freeRemaining: typeof freeRemaining === "number" ? freeRemaining : null
    });
  } catch (err) {
    console.error("Credit balance error:", err.message);
    res.status(502).json({ error: "Could not load your credit balance." });
  }
});

app.get("/api/referral/mine", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const [code, stats] = await Promise.all([
      supabaseRpc("my_referral_code", {}, req.user.token),
      supabaseRpc("my_referral_stats", {}, req.user.token).catch(() => null)
    ]);
    const origin = `${req.protocol}://${req.get("host")}`;
    res.json({
      code,
      link: `${origin}/signup?ref=${code}`,
      referredCount: stats?.referred_count ?? 0,
      paidCount: stats?.paid_count ?? 0,
      creditsEarned: stats?.credits_earned ?? 0
    });
  } catch (err) {
    console.error("Referral code error:", err.message);
    res.status(502).json({ error: "Could not load your referral link." });
  }
});

app.post("/api/referral/claim", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  const code = String(req.body?.code || "").trim();
  if (!code) return res.status(400).json({ error: "Missing code." });
  try {
    const result = await supabaseRpc("claim_referral_code", { p_code: code }, req.user.token);
    res.json(result || { claimed: false });
  } catch (err) {
    console.error("Referral claim error:", err.message);
    res.status(502).json({ error: "Could not claim that referral code." });
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

app.post("/api/credits/custom-checkout", requireUser, async (req, res) => {
  if (!WHOP_CUSTOM_READY) {
    return res.status(503).json({ error: "Custom amounts aren't turned on yet — grab one of the bundles below for now." });
  }

  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount < CUSTOM_MIN_AMOUNT || amount > CUSTOM_MAX_AMOUNT) {
    return res.status(400).json({ error: `Enter an amount between $${CUSTOM_MIN_AMOUNT} and $${CUSTOM_MAX_AMOUNT}.` });
  }
  const amountRounded = Math.round(amount * 100) / 100;

  try {
    const r = await fetch("https://api.whop.com/api/v2/plans", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHOP_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        product_id: WHOP_CUSTOM_PRODUCT_ID,
        plan_type: "one_time",
        base_currency: "usd",
        initial_price: amountRounded
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      console.error("Whop create-plan failed:", r.status, JSON.stringify(data).slice(0, 1000));
      return res.status(502).json({ error: "Could not start checkout for that amount. Try a bundle instead, or try again shortly." });
    }
    const checkoutUrl = data?.purchase_url || data?.direct_link || data?.checkout_url || data?.data?.purchase_url || null;
    if (!checkoutUrl) {
      console.error("Whop create-plan: no checkout URL in response:", JSON.stringify(data).slice(0, 1000));
      return res.status(502).json({ error: "Could not start checkout for that amount. Try a bundle instead, or try again shortly." });
    }
    res.json({ checkoutUrl, scans: scansForCustomAmount(amountRounded) });
  } catch (err) {
    console.error("Whop create-plan error:", err.message);
    res.status(502).json({ error: "Could not reach Whop right now. Please try again in a moment." });
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

// --- News calendar + signals (ForexNewsAPI) --------------------------------
// Small/medium-importance events (PMI, retail sales, etc.) are free and
// unlimited — full forecast/previous/actual always shown. Big ("High"
// importance) events like NFP/CPI/FOMC are free to see on the calendar
// (time, forecast, previous) but the actual-vs-forecast bias signal, once
// the event has released, costs one of 2 free monthly unlocks per user
// until a paid tier exists (supabase/news_signals.sql). This is a
// statistical bias, not a trade call or guarantee — same framing as the
// chart scanner.
const FOREXNEWS_API_KEY = (process.env.FOREXNEWS_API_KEY || "").trim();
const FOREXNEWS_READY = Boolean(FOREXNEWS_API_KEY);

// One shared cache across all users, refreshed at most every 2 minutes —
// the calendar is the same for everyone, no reason to burn API quota (or,
// later, Render's outbound calls) per request.
let newsCalendarCache = { ts: 0, events: [] };
const NEWS_CACHE_MS = 2 * 60 * 1000;
const NEWS_PAID_UNLOCK_CREDITS = 2; // ~$1 at the $0.50/credit rate, once free unlocks run out

function newsEventKey(ev) {
  return `${ev.event_name}|${ev.country}|${ev.date}`;
}

// "High" importance events are the ones worth gating; everything else is
// free forever — this is what "big news costs, small news doesn't" means
// in code.
function isBigNewsEvent(ev) {
  return String(ev.importance || "").toLowerCase() === "high";
}

async function fetchNewsCalendar() {
  if (Date.now() - newsCalendarCache.ts < NEWS_CACHE_MS) return newsCalendarCache.events;
  const params = new URLSearchParams({ date: "today", token: FOREXNEWS_API_KEY });
  const url = `https://forexnewsapi.com/api/v1/economic-calendar?${params.toString()}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const raw = await r.text();
  const data = JSON.parse(raw); // let a bad response throw — caller handles it
  const events = Array.isArray(data?.data) ? data.data : [];
  newsCalendarCache = { ts: Date.now(), events };
  return events;
}

// What a logged-in user is allowed to see without unlocking anything: full
// data for small/medium events, schedule-only (no actual) for big ones.
function publicNewsEvent(ev) {
  const big = isBigNewsEvent(ev);
  const base = {
    event_key: newsEventKey(ev),
    event_name: ev.event_name,
    country: ev.country,
    currency: ev.currency,
    date: ev.date,
    importance: ev.importance,
    forecast: ev.forecast ?? null,
    previous: ev.previous ?? null,
    big
  };
  const released = ev.actual !== undefined && ev.actual !== null && ev.actual !== "";
  if (!big) {
    // Small/medium events are fully free, so the buy/sell read comes for free too.
    const bias = released ? newsBias(ev) : null;
    return { ...base, released, actual: released ? ev.actual : null, locked: false, ...(bias || {}) };
  }
  // Big event: actual (and the bias it drives) is withheld until unlocked.
  return { ...base, released, actual: null, locked: released };
}

function newsBias(ev) {
  const actual = parseFloat(ev.actual);
  const forecast = parseFloat(ev.forecast);
  if (!Number.isFinite(actual) || !Number.isFinite(forecast)) {
    return { bias: "unclear", note: "Actual or forecast wasn't a plain number — no automatic read for this one." };
  }
  if (actual > forecast) return { bias: "bullish", note: `Beat forecast (${ev.actual} vs ${ev.forecast}) — historically a bullish bias for ${ev.currency}.` };
  if (actual < forecast) return { bias: "bearish", note: `Missed forecast (${ev.actual} vs ${ev.forecast}) — historically a bearish bias for ${ev.currency}.` };
  return { bias: "neutral", note: `Came in in line with forecast (${ev.actual}) — no strong bias either way.` };
}

app.get("/api/news/calendar", requireUser, async (req, res) => {
  if (!FOREXNEWS_READY) {
    return res.status(503).json({ error: "News signals aren't set up on this server yet." });
  }
  try {
    const events = await fetchNewsCalendar();
    const freeRemaining = await supabaseRpc("news_signals_remaining", {}, req.user.token).catch(() => null);
    res.json({ events: events.map(publicNewsEvent), freeRemaining });
  } catch (err) {
    console.error("News calendar fetch failed:", err.message);
    res.status(502).json({ error: "Could not reach the news provider right now. Please try again shortly." });
  }
});

app.post("/api/news/unlock", requireUser, async (req, res) => {
  if (!FOREXNEWS_READY) {
    return res.status(503).json({ error: "News signals aren't set up on this server yet." });
  }
  const eventKey = String(req.body?.event_key || "");
  if (!eventKey) return res.status(400).json({ error: "Missing event." });

  try {
    const events = await fetchNewsCalendar();
    const ev = events.find((e) => newsEventKey(e) === eventKey);
    if (!ev) return res.status(404).json({ error: "That event isn't on today's calendar anymore." });
    if (!isBigNewsEvent(ev)) {
      // Small/medium events are never gated — just hand back the data.
      return res.json({ unlocked: true, already: true, remaining: null, event: { ...publicNewsEvent(ev), actual: ev.actual ?? null }, ...(ev.actual ? newsBias(ev) : {}) });
    }
    const released = ev.actual !== undefined && ev.actual !== null && ev.actual !== "";
    if (!released) {
      return res.status(409).json({ error: "This event hasn't released yet — nothing to unlock." });
    }

    const result = await supabaseRpc("can_unlock_news_signal", { p_event_key: eventKey }, req.user.token);
    if (result?.unlocked) {
      const bias = newsBias(ev);
      return res.json({
        unlocked: true,
        already: Boolean(result.already),
        paid: false,
        remaining: result.remaining ?? null,
        event: { ...publicNewsEvent(ev), actual: ev.actual, locked: false },
        ...bias
      });
    }

    // Free allowance used up — fall back to paying with credits.
    if (req.body?.pay !== true) {
      return res.status(402).json({
        error: `You've used your 2 free big-event signals this month. Unlock this one for ${NEWS_PAID_UNLOCK_CREDITS} credits instead?`,
        code: "no_news_unlocks",
        remaining: 0,
        canPay: true,
        creditsRequired: NEWS_PAID_UNLOCK_CREDITS
      });
    }
    try {
      const paidResult = await supabaseRpc("spend_credits_for_news_unlock", { p_event_key: eventKey, p_amount: NEWS_PAID_UNLOCK_CREDITS }, req.user.token);
      const bias = newsBias(ev);
      res.json({
        unlocked: true,
        already: Boolean(paidResult?.already),
        paid: true,
        remaining: 0,
        remainingCredits: paidResult?.remaining_credits ?? null,
        event: { ...publicNewsEvent(ev), actual: ev.actual, locked: false },
        ...bias
      });
    } catch (payErr) {
      return res.status(402).json({
        error: "Not enough credits to unlock this signal. Top up on the Credits tab.",
        code: "insufficient_credits",
        creditsRequired: NEWS_PAID_UNLOCK_CREDITS
      });
    }
  } catch (err) {
    console.error("News unlock failed:", err.message);
    res.status(502).json({ error: "Could not unlock that signal right now. Please try again." });
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
    // Total revenue: sum of amount_usd across every paid order. Soft-fails
    // to null (shown as "—") rather than breaking the rest of the stats.
    const paidSummary = await supabaseRpc("admin_paid_summary", {}, req.user.token).catch((err) => {
      console.error("Admin paid summary RPC (for revenue) failed:", err.message);
      return null;
    });
    const totalRevenue = Array.isArray(paidSummary)
      ? paidSummary.reduce((sum, row) => sum + Number(row.paid_usd || 0), 0)
      : null;
    if (totalUsers === null) {
      return res.status(502).json({ error: "Could not load admin stats. Has supabase/admin_setup.sql been run yet?" });
    }
    res.json({
      totalUsers: typeof totalUsers === "number" ? totalUsers : null,
      payingUsers: typeof payingUsers === "number" ? payingUsers : null,
      totalRevenue
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

// Manual payment confirmation — a fallback for when the automatic Binance
// Pay poller can't reach Binance at all (some Render server regions get a
// 451 "restricted location" error from Binance). The admin sees the
// payment land in their own Binance app and clicks "Mark as Paid" here.
app.get("/api/admin/orders", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const orders = await supabaseRpc("admin_list_pending_orders", {}, req.user.token);
    res.json({ orders: Array.isArray(orders) ? orders : [] });
  } catch (err) {
    console.error("Admin orders error:", err.message);
    res.status(502).json({ error: "Could not load pending orders. Has the latest supabase/credits_setup.sql been run?" });
  }
});

app.post("/api/admin/orders/:id/mark-paid", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    await supabaseRpc("admin_mark_order_paid", { p_order_id: req.params.id }, req.user.token);
    res.json({ ok: true });
  } catch (err) {
    console.error("Admin mark paid error:", err.message);
    res.status(502).json({ error: "Could not mark that order paid." });
  }
});

// --- System health ---------------------------------------------------------
// Four independent checks, each worth 25%, so the admin page can show one
// plain percentage instead of a wall of technical detail. Every check has a
// short timeout and is wrapped so one slow/broken check can never hang or
// crash the others — a check that errors just counts as "down".
async function checkAccounts(adminToken) {
  if (!SUPABASE_READY) return { ok: false, detail: "Supabase keys not configured." };
  try {
    await supabaseRpc("admin_user_count", {}, adminToken);
    return { ok: true, detail: "Accounts and database reachable." };
  } catch (err) {
    return { ok: false, detail: err.message || "Could not reach Supabase." };
  }
}

async function checkScanProvider() {
  if (!FXSYNAPSE_API_KEY) return { ok: false, detail: "FXSYNAPSE_API_KEY not configured." };
  try {
    // Network reachability only — this does not spend a scan or confirm the
    // account has an active plan, just that the provider's server answers.
    const r = await fetch(FXSYNAPSE_BASE_URL, { method: "GET", signal: AbortSignal.timeout(6000) });
    return { ok: true, detail: `Reachable (HTTP ${r.status}). This does not confirm an active API plan.` };
  } catch (err) {
    return { ok: false, detail: `Could not reach ${FXSYNAPSE_BASE_URL}: ${err.message}` };
  }
}

async function checkPaymentsConfigured() {
  if (!CREDITS_READY) return { ok: false, detail: "Missing one of BINANCE_API_KEY/SECRET/CREDIT_FULFILL_SECRET." };
  return { ok: true, detail: "Binance keys and fulfill secret are set." };
}

async function checkPaymentsReachable() {
  try {
    // A free, unsigned Binance endpoint — just checks the network path to
    // Binance works at all, independent of whether our API key is valid.
    const r = await fetch("https://api.binance.com/api/v3/ping", { signal: AbortSignal.timeout(6000) });
    return { ok: r.ok, detail: r.ok ? "Binance API reachable." : `Binance responded with HTTP ${r.status}.` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Binance: ${err.message}` };
  }
}

app.get("/api/admin/health", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const [accounts, scanProvider, paymentsConfigured, paymentsReachable] = await Promise.all([
      checkAccounts(req.user.token),
      checkScanProvider(),
      checkPaymentsConfigured(),
      checkPaymentsReachable()
    ]);
    const checks = [
      { name: "Accounts & database", ...accounts },
      { name: "Scan provider (FXSynapse)", ...scanProvider },
      { name: "Payments configured", ...paymentsConfigured },
      { name: "Payments network (Binance)", ...paymentsReachable }
    ];
    const okCount = checks.filter((c) => c.ok).length;
    res.json({ percent: Math.round((okCount / checks.length) * 100), checks });
  } catch (err) {
    console.error("Admin health error:", err.message);
    res.status(502).json({ error: "Could not run health checks." });
  }
});

// --- AI Briefing -----------------------------------------------------------
// A short "welcome back" status briefing for the admin page, built from the
// same real data as the health card, user stats and support inbox. Uses the
// same ANTHROPIC_API_KEY as support AI triage; falls back to a plain
// templated summary (no AI, but still real numbers) if that key isn't set.
const BRIEFING_AI_SYSTEM_PROMPT = `You are a loyal, sharp AI assistant giving the owner of "Vertex Chart Scanner" a short status briefing, in the style of a calm, capable aide reporting to their commander. Always address them as "sir". Open with a short "Welcome back, sir" style greeting, then report the real numbers you're given in plain, confident language. If something needs attention (a failing system check, open support tickets, pending payments, failed scans), flag it clearly and say what to do about it. When failedScans is greater than 0, always mention the count and, if failedScanReasons is non-empty, name the top reason — this is the kind of thing sir specifically wants surfaced, not buried. If everything looks good, say so and keep it short. Never invent numbers you weren't given — only use what's in the data. Keep it under 90 words, plain text, no markdown, no bullet points, written as natural spoken sentences.`;

async function aiBriefing(data) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: SUPPORT_AI_MODEL,
        max_tokens: 250,
        system: BRIEFING_AI_SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(data) }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    const result = await r.json();
    if (!r.ok) {
      console.error("Briefing AI error:", r.status, result);
      return null;
    }
    const text = Array.isArray(result.content) ? result.content.map((b) => b.text || "").join("") : "";
    return text.trim() || null;
  } catch (err) {
    console.error("Briefing AI failed:", err.message);
    return null;
  }
}

function fallbackBriefing(data) {
  const bits = [`Welcome back, sir. Systems are at ${data.healthPercent}%.`];
  if (data.failingChecks.length > 0) {
    bits.push(`Needs attention: ${data.failingChecks.join(", ")}.`);
  }
  bits.push(`${data.payingUsers ?? "—"} paying users out of ${data.totalUsers ?? "—"} total.`);
  if (data.openTickets > 0) {
    bits.push(`${data.openTickets} support ${data.openTickets === 1 ? "ticket needs" : "tickets need"} a reply.`);
  } else {
    bits.push("No open support tickets.");
  }
  if (data.pendingOrders > 0) {
    bits.push(`${data.pendingOrders} payment${data.pendingOrders === 1 ? "" : "s"} still awaiting confirmation.`);
  }
  if (data.failedScans) {
    const reasonBit = data.failedScanReasons.length ? ` — mostly ${data.failedScanReasons[0]}` : "";
    bits.push(`${data.failedScans} scan${data.failedScans === 1 ? "" : "s"} failed in the last 48 hours${reasonBit}.`);
  }
  return bits.join(" ");
}

app.get("/api/admin/briefing", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const [accounts, scanProvider, paymentsConfigured, paymentsReachable] = await Promise.all([
      checkAccounts(req.user.token),
      checkScanProvider(),
      checkPaymentsConfigured(),
      checkPaymentsReachable()
    ]);
    const checks = [
      { name: "Accounts & database", ...accounts },
      { name: "Scan provider", ...scanProvider },
      { name: "Payments configured", ...paymentsConfigured },
      { name: "Payments network", ...paymentsReachable }
    ];
    const healthPercent = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
    const failingChecks = checks.filter((c) => !c.ok).map((c) => c.name);

    const [totalUsers, payingUsers, supportMessages, pendingOrders, failureSummary] = await Promise.all([
      supabaseRpc("admin_user_count", {}, req.user.token).catch(() => null),
      supabaseRpc("admin_paying_users_count", {}, req.user.token).catch(() => null),
      supabaseRpc("admin_list_support_messages", {}, req.user.token).catch(() => []),
      CREDITS_READY
        ? supabaseRpc("list_pending_orders", { p_secret: CREDIT_FULFILL_SECRET }, SUPABASE_ANON_KEY).catch(() => [])
        : Promise.resolve([]),
      // 48h window: added 2026-10-05. Requires supabase/scan_failures.sql.
      supabaseRpc("admin_scan_failure_summary", { p_hours: 48 }, req.user.token).catch(() => null)
    ]);
    const openTickets = Array.isArray(supportMessages)
      ? supportMessages.filter((m) => m.status === "open").length
      : 0;

    const data = {
      healthPercent,
      failingChecks,
      totalUsers: typeof totalUsers === "number" ? totalUsers : null,
      payingUsers: typeof payingUsers === "number" ? payingUsers : null,
      openTickets,
      pendingOrders: Array.isArray(pendingOrders) ? pendingOrders.length : 0,
      failedScans: failureSummary?.total ?? null,
      failedScanReasons: Array.isArray(failureSummary?.top_reasons)
        ? failureSummary.top_reasons.map((r) => `${r.reason} (${r.count}×)`)
        : []
    };

    const aiText = await aiBriefing(data);
    res.json({ text: aiText || fallbackBriefing(data), source: aiText ? "ai" : "fallback" });
  } catch (err) {
    console.error("Admin briefing error:", err.message);
    res.status(502).json({ error: "Could not build briefing." });
  }
});

// --- Support ---------------------------------------------------------------
app.post("/api/support", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Enter a message first." });
  if (message.length > 4000) return res.status(400).json({ error: "That message is too long." });
  try {
    const row = await supabaseRpc("create_support_message", { p_message: message }, req.user.token);
    res.json({ ok: true });

    // Fire-and-forget: never make the user wait on the AI call, and never
    // let an AI/network hiccup turn a successfully-saved message into an
    // error response. If this fails, the message just sits as a normal
    // open message with no suggestion, same as if AI wasn't configured.
    if (row && row.id) {
      aiTriageSupportMessage(message)
        .then((result) => {
          if (!result) return;
          const args =
            result.confidence === "high"
              ? { p_id: row.id, p_reply: result.reply, p_suggestion: null, p_secret: CREDIT_FULFILL_SECRET }
              : { p_id: row.id, p_reply: null, p_suggestion: result.reply, p_secret: CREDIT_FULFILL_SECRET };
          return supabaseRpc("system_set_ai_reply", args, SUPABASE_ANON_KEY);
        })
        .catch((err) => console.error("Support AI reply save failed:", err.message));
    }
  } catch (err) {
    console.error("Support message error:", err.message);
    res.status(502).json({ error: "Could not send your message. Please try again." });
  }
});

// A user's own support messages, with whatever reply they've gotten so far
// (AI or admin) — shown in their Help tab. RLS already scopes this to the
// caller's own rows regardless of filters, same pattern as /api/credits/orders.
app.get("/api/support/mine", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/support_messages?select=id,message,status,reply,replied_by,created_at,replied_at&order=created_at.desc&limit=20`,
      {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!r.ok) return res.json({ messages: [] });
    const messages = await r.json();
    res.json({ messages: Array.isArray(messages) ? messages : [] });
  } catch (err) {
    console.error("Support mine fetch error:", err.message);
    res.json({ messages: [] });
  }
});

app.get("/api/admin/support", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const messages = await supabaseRpc("admin_list_support_messages", {}, req.user.token);
    res.json({ messages: Array.isArray(messages) ? messages : [] });
  } catch (err) {
    console.error("Admin support list error:", err.message);
    res.status(502).json({ error: "Could not load support messages. Has supabase/support_setup.sql been run?" });
  }
});

app.post("/api/admin/support/:id/reply", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const reply = String(req.body?.reply || "").trim();
  if (!reply) return res.status(400).json({ error: "Reply cannot be empty." });
  try {
    await supabaseRpc("admin_reply_support_message", { p_id: req.params.id, p_reply: reply }, req.user.token);
    res.json({ ok: true });
  } catch (err) {
    console.error("Admin reply support error:", err.message);
    res.status(502).json({ error: "Could not send that reply." });
  }
});

// Belt-and-braces against two /api/analyze requests for the same user
// landing back-to-back (a double-click, a retried network request, etc.)
// each spending their own scan. Only one request per user id is allowed to
// be mid-flight at a time; a second one is told to wait rather than
// charged. Cleared in a `finally` below so it never gets stuck.
const scansInFlight = new Set();

app.post("/api/analyze", requireUser, analyzeLimiter, async (req, res) => {
  const symbol = String(req.body?.symbol || "").trim().toUpperCase();
  const timeframe = String(req.body?.timeframe || "").trim().toUpperCase();

  if (!symbol) {
    return res.status(400).json({ error: "Enter a pair or symbol (e.g. EURUSD, XAUUSD, US30)." });
  }
  if (!timeframe || !isValidTimeframe(timeframe)) {
    return res.status(400).json({ error: "Pick a timeframe." });
  }

  if (scansInFlight.has(req.user.id)) {
    return res.status(429).json({ error: "A scan is already running for your account. Please wait for it to finish." });
  }
  scansInFlight.add(req.user.id);

  try {
    return await runAnalyze(req, res, symbol, timeframe);
  } finally {
    scansInFlight.delete(req.user.id);
  }
});

async function runAnalyze(req, res, symbol, timeframe) {
  // Spend one scan up front — today's free allowance first (4/day), then
  // paid credits (use_scan() in supabase/free_scans.sql handles the split).
  // If both are exhausted, stop here — never call FXSynapse (which costs
  // real money) for a request that can't be charged. If the scan itself
  // fails below, whatever was spent gets refunded, so a failed scan never
  // costs the user anything.
  let scanSource = null;
  if (CREDITS_READY) {
    try {
      const result = await supabaseRpc("use_scan", {}, req.user.token);
      scanSource = result?.source || "paid";
    } catch (err) {
      return res.status(402).json({
        error: "You're out of free scans for today and have no credits left. Buy more to keep scanning.",
        code: "no_credits"
      });
    }
  }

  try {
    const fxRes = await fetch(`${FXSYNAPSE_BASE_URL}${FXSYNAPSE_CHART_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FXSYNAPSE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ symbol, timeframe, top_down: true }),
      // 55s gives slow analysis room to finish without railing past Render's
      // own ~60s request ceiling.
      signal: AbortSignal.timeout(55000)
    });

    const rawBody = await fxRes.text();
    let fxData;
    try {
      fxData = JSON.parse(rawBody);
    } catch {
      console.error("FXSynapse returned non-JSON response:", rawBody.slice(0, 500));
      await refundIfSpent(req.user, scanSource);
      saveScanFailure(req.user, symbol, timeframe, "Unreadable response from FXSynapse");
      return res.status(502).json({ error: "The analysis provider sent back something unreadable. Please try again." });
    }

    if (!fxRes.ok) {
      console.error("FXSynapse error:", fxRes.status, fxData);
      // Reply with our own HTTP status here, never the provider's. In
      // particular, never send back a bare 401: the browser treats a 401
      // from this endpoint as "your login session was rejected" and signs
      // you out (see the 401 handling in app.js). A bad or expired
      // FXSYNAPSE_API_KEY, no active API plan, or an unlisted pair is a
      // server-side/provider problem, not a user auth problem, and must not
      // log the user out.
      const message =
        fxRes.status === 401 || fxRes.status === 403
          ? "Analysis provider rejected the request (no active API plan or invalid key)."
          : fxRes.status === 404
          ? `FXSynapse doesn't carry prices for "${symbol}". Try a major pair, metal or index (e.g. EURUSD, XAUUSD, US30, NAS100).`
          : fxRes.status === 429
          ? "Rate limited by the analysis provider. Please try again shortly."
          : fxRes.status === 503
          ? "Prices are temporarily unavailable from the analysis provider. Please try again shortly."
          : fxData?.error || fxData?.message || "Something went wrong while analyzing that chart.";
      await refundIfSpent(req.user, scanSource);
      saveScanFailure(req.user, symbol, timeframe, `FXSynapse ${fxRes.status}: ${message}`);
      return res.status(502).json({ error: message });
    }

    const analysis = mapFxSynapseToAnalysis(fxData);
    res.json({ analysis, timeframe: timeframe || null });
    saveHistoryRow(req.user, analysis, timeframe || null); // fire-and-forget, never blocks the response
  } catch (err) {
    console.error("Analysis error:", err);
    await refundIfSpent(req.user, scanSource);
    saveScanFailure(req.user, symbol, timeframe, err.message || "Unknown server error");
    res.status(502).json({ error: "Something went wrong while analyzing that chart. Please try again." });
  }
}

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
