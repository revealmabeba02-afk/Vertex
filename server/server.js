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

// --- Admin PIN gate --------------------------------------------------------
// An extra lock in front of /admin, on top of the real security (requireUser
// + ADMIN_EMAIL on every /api/admin/* call below). Without a PIN set, anyone
// who finds the /admin URL can at least see the page shell load before every
// API call 401s; with one set, the page itself won't render until the right
// PIN is entered. Not cryptographic-grade — it's a deterrent for a casual
// visitor, not a defense against someone reading the server's source.
const ADMIN_PIN = (process.env.ADMIN_PIN || "").trim();
// Optional second PIN that unlocks /admin exactly like the main one — a
// backup in case the main PIN is forgotten. Either one works; the cookie
// they get is identical either way (signed with ADMIN_PIN as the HMAC key
// regardless of which PIN was entered), so nothing downstream needs to know
// which one was used.
const ADMIN_PIN_BACKUP = (process.env.ADMIN_PIN_BACKUP || "").trim();
const ADMIN_PIN_COOKIE = "vx_admin_pin";
const ADMIN_PIN_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

function signAdminPinToken(expiresAt) {
  const hmac = crypto.createHmac("sha256", ADMIN_PIN || "no-pin-set").update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${hmac}`;
}

function adminPinCookieIsValid(cookieHeader) {
  if (!ADMIN_PIN) return true; // no PIN configured — gate is off
  if (!cookieHeader) return false;
  const match = cookieHeader.match(/(?:^|;\s*)vx_admin_pin=([^;]+)/);
  if (!match) return false;
  const value = decodeURIComponent(match[1]);
  const [expiresAtStr, hmac] = value.split(".");
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || !hmac || Date.now() > expiresAt) return false;
  const expected = signAdminPinToken(expiresAt);
  try {
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  } catch {
    return false;
  }
}

const adminPinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." }
});

const ADMIN_PIN_LOCK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>Admin · Vertex Chart Scanner</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #06100B; color: #EAF7F0;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif;
    padding: 20px;
  }
  .card {
    width: 100%; max-width: 340px; padding: 32px 28px; border-radius: 18px;
    border: 1px solid #1E3A2C; background: #0B1A13;
    text-align: center;
  }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { margin: 0 0 22px; font-size: 13.5px; color: #8FA89B; }
  input {
    width: 100%; font-size: 22px; letter-spacing: 6px; text-align: center;
    padding: 14px 10px; border-radius: 10px; border: 1px solid #2A4B3A;
    background: #0E2118; color: #EAF7F0; margin-bottom: 14px;
  }
  input:focus { outline: none; border-color: #4FE3A0; }
  button {
    width: 100%; padding: 12px; border-radius: 10px; border: none;
    background: #4FE3A0; color: #06281A; font-weight: 700; font-size: 15px; cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .err { color: #E25C63; font-size: 13px; margin-top: 12px; min-height: 16px; }
</style>
</head>
<body>
  <form class="card" id="pin-form">
    <h1>Admin access</h1>
    <p>Enter the PIN to continue.</p>
    <input id="pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="12" autofocus />
    <button type="submit" id="pin-submit">Unlock</button>
    <div class="err" id="pin-err"></div>
  </form>
  <script>
    var form = document.getElementById("pin-form");
    var input = document.getElementById("pin-input");
    var btn = document.getElementById("pin-submit");
    var err = document.getElementById("pin-err");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true;
      try {
        var res = await fetch("/api/admin/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: input.value })
        });
        if (res.ok) {
          window.location.reload();
          return;
        }
        var data = await res.json().catch(function () { return {}; });
        err.textContent = data.error || "Wrong PIN.";
      } catch (e2) {
        err.textContent = "Something went wrong. Try again.";
      }
      btn.disabled = false;
      input.value = "";
      input.focus();
    });
  </script>
</body>
</html>`;

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

// MetaApi.cloud bridges Vertex to a user's real MT4/MT5 broker account —
// King is signing up for this separately and will hand over the token.
// METAAPI_READY gates the whole feature off cleanly until then, same
// pattern as SUPABASE_READY/FXSYNAPSE below.
const METAAPI_TOKEN = (process.env.METAAPI_TOKEN || "").trim();
const METAAPI_READY = METAAPI_TOKEN.length > 0;
const METAAPI_PROVISIONING_URL = (
  process.env.METAAPI_PROVISIONING_URL || "https://mt-provisioning-api-v1.agiliumtrade.ai"
).trim().replace(/\/+$/, "");

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

// --- Social link tracking --------------------------------------------------
// /go/:platform links go in King's TikTok/Instagram/YouTube/Facebook bios
// instead of the raw profile URLs. Each one logs the click (so the admin
// page can show totals per platform) and emails him instantly, then sends
// the visitor straight on to the real profile — nothing changes for them.
// Every value below can be overridden by an env var without a code change.
const SOCIAL_LINKS = {
  tiktok: process.env.SOCIAL_LINK_TIKTOK || "https://www.tiktok.com/@verxter6",
  instagram: process.env.SOCIAL_LINK_INSTAGRAM || "https://instagram.com/verte.x6",
  youtube: process.env.SOCIAL_LINK_YOUTUBE || "https://www.youtube.com/@Vertex06",
  facebook: process.env.SOCIAL_LINK_FACEBOOK || "https://www.facebook.com/share/1EGMWwPbXv/"
};
const PLATFORM_LABELS = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", facebook: "Facebook" };

// Email alerts via Resend (https://resend.com — free tier, no API key means
// this just silently stops sending emails; logging/redirect still work).
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const LINK_ALERT_EMAIL = (process.env.LINK_ALERT_EMAIL || "revealmabeba02@icloud.com").trim();
// Resend requires the "from" address to be on a domain you've verified with
// them. Until shadowfx.co.za (or another domain) is verified there, their
// shared onboarding@resend.dev address works for any destination.
const LINK_ALERT_FROM = (process.env.LINK_ALERT_FROM || "Vertex Scanner <onboarding@resend.dev>").trim();

// --- Safe self-upgrade -----------------------------------------------------
// Render deploys on every push, but its GitHub webhook has silently missed a
// commit before. This process therefore checks the tracked branch every two
// minutes and asks Render to build the newer commit when the live instance is
// behind. A deploy never interrupts the running instance: if the new build
// fails, Render keeps this version serving, so an automatic upgrade can only
// ever add code that builds. Needs a Render API key (Dashboard → Account
// Settings → API Keys) in RENDER_API_KEY; without it the check is off.
const RENDER_API_KEY = (process.env.RENDER_API_KEY || "").trim();
const RENDER_SERVICE_ID = (process.env.RENDER_SERVICE_ID || "srv-das2umt9fdbs73bkmum0").trim();
const UPGRADE_REPO = (process.env.UPGRADE_REPO || "revealmabeba02-afk/Vertex").trim();
const RUNNING_COMMIT = (process.env.RENDER_GIT_COMMIT || "").trim();
const UPGRADE_INTERVAL_MS = 2 * 60 * 1000;

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
// PayPal.Me is the one payment route that needs no integration, no webhook and
// no API key: the buyer pays to a public link, and the order sits pending until
// King confirms it in /admin. It exists because Binance Pay is blocked in some
// countries and Whop needs a store review — a payment method that can't be
// switched on is not a payment method.
const PAYPAL_ME_HANDLE = (process.env.PAYPAL_ME_HANDLE || "").trim().replace(/^@/, "");
// The agent's own key to the money numbers. It is not a database key: it only
// unlocks agent_money(), a read-only summary function. That is deliberate —
// the alternative (service_role on the server) would let one process read and
// write every row in the database, and a summary is all the agents need.
const AGENT_MONEY_SECRET = (process.env.AGENT_MONEY_SECRET || "").trim();
// The old fulfilment secret was published in the public repo. It has been
// rotated in Postgres; if Render still has the dead value, use the private
// agent secret so credits and webhooks keep working until the env is updated.
const LEAKED_CREDIT_SECRET = "5b43538659fe69465f251809e20f1ef73eb99a61ff6f4b57";
let CREDIT_FULFILL_SECRET = (process.env.CREDIT_FULFILL_SECRET || "").trim();
if (!CREDIT_FULFILL_SECRET || CREDIT_FULFILL_SECRET === LEAKED_CREDIT_SECRET) {
  CREDIT_FULFILL_SECRET = (process.env.AGENT_MONEY_SECRET || "").trim();
}
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

const YOCO_CHECKOUT_LINKS = {
  quick: (process.env.YOCO_CHECKOUT_QUICK || "").trim(),
  starter: (process.env.YOCO_CHECKOUT_STARTER || "").trim(),
  trader: (process.env.YOCO_CHECKOUT_TRADER || "").trim(),
  pro: (process.env.YOCO_CHECKOUT_PRO || "").trim()
};
const YOCO_READY = Object.values(YOCO_CHECKOUT_LINKS).some(Boolean);

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

// --- Broker connect unlock --------------------------------------------------
// One-time paid unlock for real MT4/MT5 broker connect (R450). Charged as
// its USD equivalent through the same Whop one-off-plan mechanism as the
// custom credit top-up above (reuses WHOP_CUSTOM_PRODUCT_ID), but the Whop
// webhook tells a broker-access payment apart from a credit top-up by its
// exact amount — see BROKER_ACCESS_PRICE_USD below and the webhook handler.
// This is a reasonably distinctive, non-round price specifically so it's
// unlikely to collide with someone's hand-typed custom top-up amount; if a
// real collision ever shows up in the logs, change this value.
const BROKER_ACCESS_PRICE_USD = 24.63;

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

// Every text-AI feature goes through one engine so a dead provider can't take
// five features down at once. Gemini (free) is preferred; Anthropic is the
// fallback.
const { generateText, hasProvider } = require("./aiText");
const SUPPORT_AI_MODEL = (process.env.SUPPORT_AI_MODEL || "claude-haiku-4-5-20251001").trim();

// Optional: free-tier Google Gemini key for reading chart screenshots. When it
// is set, chart-photo scanning keeps working even if the Anthropic balance is
// zero, which is exactly the state this app found itself in. Image reading is
// the only feature that needs a vision key; the pair scanner never touches it.
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const OPENCODE_GO_API_KEY = (process.env.OPENCODE_GO_API_KEY || "").trim();

const SUPPORT_AI_SYSTEM_PROMPT = `You are the support triage assistant for Vertex Chart Scanner (vertex-9s4c.onrender.com), a forex chart analysis tool.

What Vertex does: users type a pair/symbol (e.g. EURUSD, XAUUSD, US30) and pick a timeframe, and get back a technical read calculated from live price bars — market bias, structure, key levels, a BUY/SELL/No-trade signal, stop loss, take-profit targets, and a confidence % (shown as an animated ring by the pair name and an animated bar in the trade stats — it reflects how aligned the plan, risk/reward and top-down timeframes are, not a win-rate promise). Users can also upload a chart screenshot; the pair scanner is faster and more reliable, so suggest it when an image scan is slow or fails. It is a technical read, not financial advice.

Billing: every signed-in user gets 2 free scans a day, resetting at midnight UTC. Beyond that, pay-per-scan credits are bought under Credits as a fixed bundle (Quick $4.99/10 scans, Starter $8.99/20 scans, Trader $12.99/60 scans, Pro $19.99/150 scans) or as a custom "name your price" amount from $5, at the same ~$0.50/scan rate. Card (Yoco), PayPal and bank transfer are all accepted; card, PayPal and bank payments are credited by hand, usually the same day. Credits never expire. A failed scan automatically refunds whatever it used (a free scan or a paid credit).

News tab: a live economic calendar (NFP, CPI, PMIs, etc.) with a BUY/SELL tag per event once a clear bias shows. Small/medium events are fully free and unlimited, actual result included. Big ("High" importance) events are free to see on the calendar (time, forecast, previous) but the actual-vs-forecast result only unlocks after the event releases — 2 unlocks are free per user per calendar month, and after that each extra unlock costs 2 credits from the same balance used for scans.

Referrals (Settings tab): every user has a personal invite link. No free credits just for signing up via a link — the referrer only gets rewarded (2 credits) the first time their referred friend actually buys a credit bundle, so it only pays out on a real purchase.

Login: sessions are not kept signed in across visits on purpose — closing the browser/tab signs you out, and you log in again next time. This is expected behavior, not a bug.

Known quirk: the pair scanner is the reliable path. Image reading depends on a separate vision service and can be slow or unavailable; if that happens, tell the user to tap "Use Pick a pair" and type the symbol. The first request after a long idle period can also take a few seconds while the server wakes.

A user has submitted a support message. Decide: can you answer this confidently and completely using ONLY the information above, with a short, warm, helpful reply? Or does it need a human (account-specific issues, refund requests, bug reports, anything requiring looking something up, or anything outside what's described above)?

Reply with ONLY a JSON object, no other text, in exactly this shape:
{"confidence":"high","reply":"..."} — for a question you can fully answer from the information above
{"confidence":"low","reply":"..."} — a best-effort DRAFT reply for a human to review and edit before sending; still write something useful, just don't claim certainty about anything you don't actually know

Keep replies under 120 words, friendly, plain text (no markdown).

Hard limits, no exceptions: never state a win rate, probability, expected return or past-performance figure. Vertex does not publish any of those, so any number would be invented — say plainly that the confidence figure is not a win-rate promise. Never tell a user to place a specific trade or to enter/exit a position; describe what the scan shows and let them decide. Never promise profit.`;

const SUPPORT_HOLD_REPLY = "Thanks — I've passed this to the team. We'll check it and get back to you here.";

// 001's built-in support brain. These are the questions that do not need a
// model: the answers are fixed product facts. Keeping them deterministic means
// support still works when every AI provider is rate-limited or out of credit.
function deterministicSupportReply(message) {
  const m = String(message || "").toLowerCase();
  const has = (...words) => words.some((w) => m.includes(w));

  if (has("paypal", "pay pal")) {
    return {
      confidence: "high",
      reply:
        "PayPal is available. Open Credits, pick a pack, then tap “Pay with PayPal”. It opens the exact amount at paypal.me/JThanos. Put your Vertex login email in the PayPal note, then tap “I've paid” so the owner can check it."
    };
  }
  if (has("bank transfer", "bank details", "bank pay", "pay by bank")) {
    return {
      confidence: "high",
      reply:
        "Bank transfer is available. Open Credits, pick a pack, tap “Bank transfer”, then “Request bank details”. The owner sends the account details privately, and you use your Vertex email as the reference. Vertex never stores bank numbers."
    };
  }
  if (has("credit", "credits", "price", "pricing", "bundle", "how much", "cost")) {
    return {
      confidence: "high",
      reply:
        "You get 2 free scans every day. Bundles: Quick $4.99 for 10 scans, Starter $8.99 for 20, Trader $12.99 for 60, Pro $19.99 for 150. Credits never expire. Whop credits automatically; PayPal and bank transfers are checked manually."
    };
  }
  if (has("how do i scan", "how to scan", "how does it work", "upload", "pick a pair", "timeframe")) {
    return {
      confidence: "high",
      reply:
        "Open Scanner, upload a chart screenshot or switch to “Pick a pair”, choose the timeframe, then tap Scan. Vertex returns the bias, entry, stop, target and what would invalidate the idea."
    };
  }
  if (has("failed", "refund", "charged", "money back", "didn't work", "did not work")) {
    return {
      confidence: "high",
      reply:
        "A failed scan is refunded automatically. If a payment or credit did not land, reply with your Vertex email and what happened; the owner will check it and fix it."
    };
  }
  if (has("login", "log in", "logged out", "password", "sign in")) {
    return {
      confidence: "high",
      reply:
        "Sessions end when the browser or tab closes, so you may need to log in again. Use “Forgot password?” on the login page if you cannot get in."
    };
  }
  if (has("image", "screenshot", "photo", "picture")) {
    return {
      confidence: "high",
      reply:
        "If an image scan fails, tap “Use Pick a pair instead” and type the symbol — it gives the same read and is faster. Image scans can take longer when the vision service is busy."
    };
  }
  // The trust question, answered the same way every time — and without the
  // model, so it never turns into "the team will get back to you". This is the
  // one a stranger asks before paying, and the one that must never be answered
  // loosely.
  if (has("financial advice", "is this advice", "advice or", "guarantee", "guaranteed", "win rate", "sure thing", "can't lose", "cannot lose", "will i make")) {
    return {
      confidence: "high",
      reply:
        "No — Vertex gives a technical read, not financial advice or a recommendation to trade. The confidence number is how aligned the plan and timeframes are, not a win rate or a promise. It shows you what the chart is doing and where the levels sit; whether to trade it is your call, and trading carries real risk."
    };
  }
  return null;
}

// Admin-only tone overlay (King's own requests to Q2/Q3, never shown to any
// other user). Added on top of the real rules above — it changes voice
// only; the output shape (JSON for support, plain text for Q3) and every
// factual/scope rule above it still apply exactly as written.
const ADMIN_TONE_ADDENDUM = `

ONE EXCEPTION: this message is from the site owner (King), not a regular user. Keep the reply's content and required format exactly as specified above, but write it in the voice of Sung Jin-Woo from Solo Leveling — controlled, supremely confident, economical with words, zero filler or hedging, nothing servile. Address him with that same quiet authority, like a system reporting to its one commander. Still fully honest and accurate — the voice changes, the substance doesn't.`;

// Feature-suggestion acknowledgment — much lighter than support triage.
// This never answers a question or promises a timeline (only King decides
// what gets built and when); it just makes sure every suggestion gets a
// real, specific, human-sounding response instead of the generic "Thanks —
// added to the build list" the user already saw on submit.
const FEEDBACK_AI_SYSTEM_PROMPT = `You are Q2, the AI running on Vertex Chart Scanner, a forex chart analysis tool. A user just submitted a feature suggestion through the "Suggest a feature" box.

Write a short, warm, genuine acknowledgment (under 60 words, plain text, no markdown). Reference something specific from what they actually wrote, so it doesn't read as generic. Do NOT promise it will be built, give a timeline, or claim it's already planned — only the site owner decides that. Just make them feel heard, and reply with only the message text, nothing else.`;

async function aiAcknowledgeFeedback(message) {
  if (!hasProvider()) return null;
  try {
    const out = await generateText({
      system: FEEDBACK_AI_SYSTEM_PROMPT,
      prompt: message,
      maxTokens: 150,
      temperature: 0.6,
      timeoutMs: 15000
    });
    return out.text || null;
  } catch (err) {
    console.error("Feedback AI ack failed:", err.message);
    return null;
  }
}

async function aiTriageSupportMessage(message, isAdmin) {
  if (!hasProvider()) return null;
  try {
    const out = await generateText({
      system: isAdmin ? SUPPORT_AI_SYSTEM_PROMPT + ADMIN_TONE_ADDENDUM : SUPPORT_AI_SYSTEM_PROMPT,
      prompt: message,
      maxTokens: 400,
      temperature: 0.4,
      timeoutMs: 20000
    });
    // Models sometimes wrap JSON in a fence even when told not to. Pull the
    // outermost object rather than trusting the wrapper.
    const raw = String(out.text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed.reply !== "string") return null;
    return { confidence: parsed.confidence === "high" ? "high" : "low", reply: parsed.reply.trim() };
  } catch (err) {
    console.error("Support AI triage failed:", err.message);
    return null;
  }
}

// "Q2" — the admin-facing name for fully-autonomous support mode. Off by
// default: the AI only auto-replies to messages it's confident about, and
// anything else waits as a draft for a human. With Q2 on, its best-effort
// answer goes out immediately for every message, no review. Read fresh each
// time (cheap single-row lookup) rather than cached, so flipping the switch
// in the admin page takes effect on the very next message, not after a
// restart or a cache expiry.
async function getQ2Autopilot() {
  try {
    const result = await supabaseRpc("get_q2_autopilot", {}, SUPABASE_ANON_KEY);
    return result === true;
  } catch (err) {
    console.error("Q2 autopilot read failed:", err.message);
    return false; // fail closed — never silently go autonomous on an error
  }
}

// "Q3" — "Ask about this scan". Off by default. Unlike Q2 (which answers
// support tickets), Q3 only ever explains a scan result the server itself
// already produced for that user, and nothing else — it has no access to
// other pairs, other users' data, or general trading advice, specifically
// to keep this out of "is this a good trade" financial-advice territory.
// Read fresh each time, same reasoning as getQ2Autopilot above.
async function getQ3Insight() {
  try {
    const result = await supabaseRpc("get_q3_insight", {}, SUPABASE_ANON_KEY);
    return result === true;
  } catch (err) {
    console.error("Q3 insight read failed:", err.message);
    return false; // fail closed
  }
}

const Q3_AI_MODEL = (process.env.Q3_AI_MODEL || SUPPORT_AI_MODEL || "claude-haiku-4-5-20251001").trim();

const Q3_SYSTEM_PROMPT = `You are "Ask about this scan" inside Vertex Chart Scanner. You explain ONE chart scan result that the user is looking at right now — you are given that exact result as JSON. Rules, no exceptions:
- Only explain the fields in the JSON you're given (bias, entry, stop, targets, structure, notes, top-down bias). Never introduce a number, level, or claim that isn't already in that JSON.
- Never discuss any pair, timeframe or scan other than the one in the JSON. Never give a new trade idea, a different entry/stop/target, or advice on position sizing, leverage or money management.
- If asked something outside this scan (another pair, "should I trade this", general market opinion, strategy advice unrelated to this result), decline briefly and say you can only explain the scan shown, then suggest they open a new scan or contact support for anything else.
- Keep answers short — 2-4 sentences, plain language, no financial-advice framing ("you should buy/sell"). You're explaining what the tool already calculated, not recommending anything.
- Reply with ONLY the answer text, no JSON, no preamble.`;

async function aiExplainScan(analysis, question, isAdmin) {
  if (!hasProvider()) return null;
  try {
    const out = await generateText({
      system: isAdmin ? Q3_SYSTEM_PROMPT + ADMIN_TONE_ADDENDUM : Q3_SYSTEM_PROMPT,
      prompt: `Scan result JSON:\n${JSON.stringify(analysis)}\n\nQuestion: ${question}`,
      maxTokens: 300,
      temperature: 0.3,
      timeoutMs: 20000
    });
    return (out.text || "").trim() || null;
  } catch (err) {
    console.error("Q3 explain failed:", err.message);
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

    if (Math.abs(amount - BROKER_ACCESS_PRICE_USD) < 0.02) {
      try {
        const grantResult = await supabaseRpc(
          "grant_broker_access_by_email",
          { p_email: email, p_amount_usd: amount, p_external_id: String(id), p_secret: CREDIT_FULFILL_SECRET },
          SUPABASE_ANON_KEY
        );
        console.log("Whop webhook: broker access granted", grantResult);
      } catch (err) {
        console.error("Whop webhook: broker access grant failed:", err.message);
      }
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
    sendReceiptEmail(email, p_bundle, p_scans, p_amount_usd).catch(() => {});

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

// Baseline response hardening. Deliberately no Content-Security-Policy: every
// page uses inline scripts, so a real policy needs a nonce pipeline first and
// a half-done CSP would break the site. These four cost nothing and stop the
// common classes of abuse (MIME sniffing, referrer leakage, framing, device
// permissions this product never uses).
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("X-Permitted-Cross-Domain-Policies", "none");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.secure || process.env.NODE_ENV === "production") {
    res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

// --- Pages ---------------------------------------------------------------
// Supabase keeps the session in the browser, so /app checks for it on load
// and sends logged out visitors to /login. That redirect is a convenience;
// the real gate is requireUser on /api/analyze below.
const PAGES = path.join(__dirname, "..", "pages");
const page = (name) => path.join(PAGES, name);

// The public origin is baked into the pages (canonical, og:url, og:image) and
// into sitemap.xml / robots.txt. The moment a custom domain is attached, every
// one of those should name the domain the visitor actually used: otherwise
// Google indexes the onrender.com host and link previews advertise it too.
// Rather than hand-editing thirty-odd hard-coded URLs — and doing it again the
// next time the domain changes — swap the origin while serving.
const CANONICAL_ORIGIN = "https://vertex-9s4c.onrender.com";
// Outbound email and keepalive need one absolute base URL; PUBLIC_BASE_URL
// overrides it once the custom domain is live.
const SELF_URL = (process.env.PUBLIC_BASE_URL || CANONICAL_ORIGIN).replace(/\/+$/, "");
const PUBLIC_HOSTS = new Set([
  "vertex-9s4c.onrender.com",
  "vertexchartscanner.us.kg",
  "www.vertexchartscanner.us.kg",
]);

// Only hosts we own are honoured, so a forged Host header can never inject a
// canonical URL into the page.
function requestOrigin(req) {
  if (!req || !req.headers) return CANONICAL_ORIGIN;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
  if (!PUBLIC_HOSTS.has(host)) return CANONICAL_ORIGIN;
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  return `${proto}://${host}`;
}

function rewriteOrigin(html, origin) {
  return origin === CANONICAL_ORIGIN ? html : html.split(CANONICAL_ORIGIN).join(origin);
}

// These pages change often while the product is being iterated on, and
// browsers — mobile Safari especially, via its back-forward cache — will
// otherwise keep showing an old UI after a deploy until the person manually
// clears site data. no-store forces a real fetch of the current file every
// time, so a shipped change is what the next load actually shows.
function sendFreshPage(res, name) {
  res.set("Cache-Control", "no-store");
  const origin = requestOrigin(res.req);
  // Fast path: on the canonical host nothing is rewritten, so keep serving
  // straight off disk exactly as before.
  if (origin === CANONICAL_ORIGIN) return res.sendFile(page(name));
  res.type("html").send(rewriteOrigin(require("fs").readFileSync(page(name), "utf8"), origin));
}

// Same treatment for the crawler files. They live in public/ and would
// otherwise be served by the static middleware with the old host baked in.
function sendRewrittenStatic(res, relPath, type) {
  res.set("Cache-Control", "public, max-age=3600");
  res.type(type).send(rewriteOrigin(require("fs").readFileSync(path.join(__dirname, "..", relPath), "utf8"), requestOrigin(res.req)));
}

app.get("/sitemap.xml", (req, res) => sendRewrittenStatic(res, "public/sitemap.xml", "application/xml"));
app.get("/robots.txt", (req, res) => sendRewrittenStatic(res, "public/robots.txt", "text/plain"));

app.get("/", (req, res) => sendFreshPage(res, "landing.html"));
app.get("/welcome", (req, res) => sendFreshPage(res, "splash.html"));
app.get("/login", (req, res) => sendFreshPage(res, "login.html"));
app.get("/signup", (req, res) => sendFreshPage(res, "signup.html"));
app.get("/forgot-password", (req, res) => sendFreshPage(res, "forgot-password.html"));
app.get("/privacy", (req, res) => sendFreshPage(res, "privacy.html"));
app.get("/terms", (req, res) => sendFreshPage(res, "terms.html"));
app.get("/update-password", (req, res) => sendFreshPage(res, "update-password.html"));
app.get("/app", (req, res) => sendFreshPage(res, "app.html"));
app.get("/status", (req, res) => sendFreshPage(res, "status.html"));
app.get("/mentorship", (req, res) => sendFreshPage(res, "mentorship.html"));
app.get("/maintenance", (req, res) => sendFreshPage(res, "maintenance.html"));
app.get("/admin", (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    res.set("Cache-Control", "no-store");
    return res.type("html").send(ADMIN_PIN_LOCK_HTML);
  }
  sendFreshPage(res, "admin.html");
});

function pinMatches(given, candidate) {
  if (!candidate) return false;
  const expected = Buffer.from(candidate);
  const givenBuf = Buffer.from(given);
  return expected.length === givenBuf.length && crypto.timingSafeEqual(expected, givenBuf);
}

app.post("/api/admin/unlock", adminPinLimiter, (req, res) => {
  if (!ADMIN_PIN) return res.status(400).json({ error: "No admin PIN is configured." });
  const pin = String((req.body && req.body.pin) || "").trim();
  const ok = pinMatches(pin, ADMIN_PIN) || pinMatches(pin, ADMIN_PIN_BACKUP);
  if (!ok) return res.status(401).json({ error: "Wrong PIN." });
  const expiresAt = Date.now() + ADMIN_PIN_MAX_AGE_MS;
  const token = signAdminPinToken(expiresAt);
  res.set(
    "Set-Cookie",
    `${ADMIN_PIN_COOKIE}=${encodeURIComponent(token)}; Max-Age=${Math.floor(ADMIN_PIN_MAX_AGE_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${
      req.secure ? "; Secure" : ""
    }`
  );
  res.json({ ok: true });
});

// --- Key check (admin only) -------------------------------------------------
// The image reader is the one feature that depends on an outside AI key, and
// when it fails the provider's own status code is the only thing that says
// why: 401/403 = key rejected, 402 = out of credit, 429 = daily cap reached,
// 503 = provider overloaded. That code only ever lands in the server log,
// which nobody can read from a browser. This asks each configured vision
// provider the same question the scanner asks (a tiny image + a one-word
// answer) and returns just the status and the provider's own message — never
// the key itself.
const KEY_CHECK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

app.get("/api/admin/key-check", async (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).json({ error: "Unlock /admin with the PIN first." });
  }

  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: KEY_CHECK_PNG } },
          { text: "Reply with the single word: ok" }
        ]
      }
    ],
    generationConfig: { maxOutputTokens: 16, temperature: 0 }
  });

  const checks = [];

  async function probe(label, url, headers) {
    if (!headers) {
      checks.push({ provider: label, configured: false, status: null, ok: false, message: "No key set on this server." });
      return;
    }
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
        signal: AbortSignal.timeout(12000)
      });
      const data = await r.json().catch(() => null);
      const message = String(data?.error?.message || (r.ok ? "Answered." : "")).slice(0, 300);
      checks.push({ provider: label, configured: true, status: r.status, ok: r.ok, message });
    } catch (err) {
      checks.push({
        provider: label,
        configured: true,
        status: null,
        ok: false,
        message: "Could not reach the provider: " + err.message
      });
    }
  }

  await probe(
    "opencode-go:gemini-4-argon",
    "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:generateContent",
    OPENCODE_GO_API_KEY ? { Authorization: "Bearer " + OPENCODE_GO_API_KEY } : null
  );

  for (const model of ["gemini-3.6-flash", "gemini-flash-latest"]) {
    await probe(
      "gemini:" + model,
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
      GEMINI_API_KEY ? { "x-goog-api-key": GEMINI_API_KEY } : null
    );
  }

  // Claude is the paid fallback the image reader uses when the free Gemini
  // tier is overloaded, so its state matters just as much.
  if (ANTHROPIC_API_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: (process.env.IMAGE_ANALYSIS_MODEL || "claude-haiku-4-5-20251001").trim(),
          max_tokens: 16,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: KEY_CHECK_PNG } },
                { type: "text", text: "Reply with the single word: ok" }
              ]
            }
          ]
        }),
        signal: AbortSignal.timeout(12000)
      });
      const data = await r.json().catch(() => null);
      checks.push({
        provider: "anthropic:" + (process.env.IMAGE_ANALYSIS_MODEL || "claude-haiku-4-5-20251001").trim(),
        configured: true,
        status: r.status,
        ok: r.ok,
        message: String(data?.error?.message || (r.ok ? "Answered." : "")).slice(0, 300)
      });
    } catch (err) {
      checks.push({ provider: "anthropic", configured: true, status: null, ok: false, message: "Could not reach the provider: " + err.message });
    }
  } else {
    checks.push({ provider: "anthropic", configured: false, status: null, ok: false, message: "No key set on this server." });
  }

  res.json({ checkedAt: new Date().toISOString(), checks });
});

// --- Truth (admin only) ----------------------------------------------------
// One honest status read for the owner: the real money numbers, and which AI
// providers are actually configured. No invented reasoning, no cached "ACTIVE"
// badge — every field is either a number from Postgres or a boolean from the
// server's own environment. For a live provider handshake use
// /api/admin/key-check, which spends a real request.
app.get("/api/admin/truth", async (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).json({ error: "Unlock /admin with the PIN first." });
  }

  let money = null;
  try {
    money = await readMoneyUnattended();
  } catch {
    money = null;
  }

  res.json({
    at: new Date().toISOString(),
    money: money
      ? {
          users: money.users,
          payingUsers: money.payingUsers,
          revenueUsd: money.revenueUsd,
          orders: money.orders,
          paidScansSold: money.paidScansSold,
          scansLast14Days: money.scansLast14Days,
          pendingOrders: money.pendingOrders,
          topPairs: money.topPairs
        }
      : null,
    ai: {
      gemini: Boolean(GEMINI_API_KEY),
      anthropic: Boolean(ANTHROPIC_API_KEY),
      opencodeGo: Boolean(OPENCODE_GO_API_KEY)
    },
    imageScan: Boolean(OPENCODE_GO_API_KEY || GEMINI_API_KEY || ANTHROPIC_API_KEY),
    note: money
      ? "Money comes from agent_money(). AI flags only say a key is present — use /api/admin/key-check for a live handshake."
      : "Money is unavailable: AGENT_MONEY_SECRET is not set, or supabase/agent_money.sql has not been run."
  });
});

// A real, current read for the landing page sample card. Cached for 45 minutes
// so the public page can never hammer the paid provider: one request at most
// every 45 min no matter how much traffic the site gets. The card used to show
// a frozen example with old gold prices (2,418 when gold trades near 3,566),
// which told any trader who glanced at it that the product was stale — or that
// the numbers were made up. Now it shows what the scanner actually says, and
// falls back to the static example only if the provider is down.
let sampleCache = { at: 0, data: null };
const SAMPLE_CACHE_MS = 45 * 60 * 1000;

app.get("/api/sample", async (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  if (sampleCache.data && Date.now() - sampleCache.at < SAMPLE_CACHE_MS) {
    return res.json({ ok: true, cached: true, ...sampleCache.data });
  }
  if (!FXSYNAPSE_API_KEY) {
    return res.json({ ok: false, error: "no key" });
  }

  try {
    const fxRes = await fetch(`${FXSYNAPSE_BASE_URL}${FXSYNAPSE_CHART_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${FXSYNAPSE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "XAUUSD", timeframe: "H4", top_down: true }),
      signal: AbortSignal.timeout(12000)
    });
    const data = await fxRes.json().catch(() => null);
    if (!fxRes.ok) throw new Error("provider " + fxRes.status);

    const a = mapFxSynapseToAnalysis(data);
    const entry = Array.isArray(a.potential_entries) ? a.potential_entries[0] : null;
    const firstLevel = Array.isArray(a.market_structure?.key_levels) ? a.market_structure.key_levels[0] : null;
    const payload = {
      pair: "XAUUSD",
      timeframe: "H4",
      call: String(entry?.type || "").toLowerCase() === "short" ? "SELL" : entry ? "BUY" : "—",
      bias: a.market_bias || "Neutral / Ranging",
      confidence: Number.isFinite(Number(a.confidence)) ? Math.round(Number(a.confidence)) : null,
      structure: a.market_structure?.trend || "",
      entry: entry?.entry_zone || "—",
      stop: a.stop_loss?.suggestion || "—",
      target: a.take_profit?.[0]?.target || "—",
      level: firstLevel ? String(firstLevel).split(" · ")[0] : "—",
      rr: a.risk_reward_estimate || "—",
      invalidation: a.invalidation || ""
    };
    sampleCache = { at: Date.now(), data: payload };
    return res.json({ ok: true, cached: false, ...payload });
  } catch (err) {
    // Serve the last good read rather than nothing; the page keeps its static
    // example if this has never succeeded.
    if (sampleCache.data) return res.json({ ok: true, cached: true, stale: true, ...sampleCache.data });
    return res.json({ ok: false, error: err.message });
  }
});

// --- YouTube auto-post connection -------------------------------------------
// One-time admin step: King authorizes Vertex's Google Cloud OAuth client to
// upload videos to his YouTube channel. Google hands back a refresh_token,
// which is what lets the server upload videos later without King logging in
// again. Render's disk isn't persistent across deploys, so instead of saving
// the refresh_token to a file, this just displays it once for King to copy —
// it then gets set as the YOUTUBE_REFRESH_TOKEN env var on Render.
const YOUTUBE_CLIENT_ID = (process.env.YOUTUBE_CLIENT_ID || "").trim();
const YOUTUBE_CLIENT_SECRET = (process.env.YOUTUBE_CLIENT_SECRET || "").trim();
const YOUTUBE_REDIRECT_URI = (process.env.YOUTUBE_REDIRECT_URI || "").trim();
const YOUTUBE_OAUTH_STATE_COOKIE = "vx_yt_oauth_state";

// Gated the same way as /admin itself (PIN cookie), since this is a sensitive
// one-time setup action, not a regular logged-in-user feature.
app.get("/api/admin/youtube/connect", (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).send("Unlock /admin with the PIN first, then try this link again.");
  }
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_REDIRECT_URI) {
    return res.status(500).send("YOUTUBE_CLIENT_ID / YOUTUBE_REDIRECT_URI are not set on the server yet.");
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.set(
    "Set-Cookie",
    `${YOUTUBE_OAUTH_STATE_COOKIE}=${state}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax${req.secure ? "; Secure" : ""}`
  );
  const params = new URLSearchParams({
    client_id: YOUTUBE_CLIENT_ID,
    redirect_uri: YOUTUBE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.upload",
    access_type: "offline",
    prompt: "consent",
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/api/admin/youtube/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Google said: ${error}`);
  const cookieMatch = /(?:^|;\s*)vx_yt_oauth_state=([^;]+)/.exec(req.headers.cookie || "");
  const expectedState = cookieMatch ? cookieMatch[1] : null;
  if (!state || !expectedState || state !== expectedState) {
    return res.status(400).send("State mismatch — please start again from the Connect YouTube link.");
  }
  if (!code) return res.status(400).send("Missing code from Google.");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: YOUTUBE_CLIENT_ID,
        client_secret: YOUTUBE_CLIENT_SECRET,
        redirect_uri: YOUTUBE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.refresh_token) {
      console.error("YouTube token exchange failed:", data);
      return res
        .status(502)
        .send(
          `Google did not return a refresh token (${data.error || "unknown error"}). This usually means you've already connected once before — remove Vertex's access at https://myaccount.google.com/permissions and try the Connect link again.`
        );
    }
    res.type("html").send(`
      <body style="font-family:system-ui;background:#0a0d12;color:#dde3ea;padding:40px;">
        <h2>YouTube connected</h2>
        <p>Copy this and send it back in chat — it will be saved as a server setting, then this page is done being needed:</p>
        <textarea readonly style="width:100%;max-width:600px;height:80px;font-family:monospace;font-size:13px;">${data.refresh_token}</textarea>
      </body>
    `);
  } catch (err) {
    console.error("YouTube OAuth callback error:", err.message);
    res.status(502).send("Could not reach Google to finish connecting. Try the Connect link again.");
  }
});

// --- Trade-recap video generator --------------------------------------------
// Builds a short vertical video (pair + direction, stats over the chart,
// outro) from a scan's details, and can upload it straight to YouTube.
// PIN-gated like the routes above — this is an admin tool, not a user one.
const { generateTradeVideo } = require("./video/generateTradeVideo");
const { uploadVideo: uploadToYoutube } = require("./video/youtubeUpload");

// No-parameter version for a plain link that can't get mangled by a
// messaging app trimming a URL at its "&" characters — fixed demo numbers,
// just proves the generate-and-upload pipeline itself works end to end.
app.get("/api/admin/videos/demo-post", async (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).send("Unlock /admin with the PIN first, then try this link again.");
  }
  req.query = { pair: "XAUUSD", direction: "BUY", entry: "3640", sl: "3630", tp: "3660" };
  return quickPostHandler(req, res);
});

// One-click version of the route below for when typing into a form isn't
// convenient — same PIN gate, just reads from the URL's query string and
// always uploads straight to YouTube. Example:
// /api/admin/videos/quick-post?pair=XAUUSD&direction=BUY&entry=3640&sl=3630&tp=3660
app.get("/api/admin/videos/quick-post", quickPostHandler);

async function quickPostHandler(req, res) {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).send("Unlock /admin with the PIN first, then try this link again.");
  }
  const { pair, direction, entry, sl, tp, confidence } = req.query || {};
  if (!pair || !direction || !entry || !sl || !tp) {
    return res.status(400).send("Need pair, direction, entry, sl and tp in the link.");
  }
  try {
    const videoPath = await generateTradeVideo({
      pair,
      direction: String(direction).toUpperCase(),
      entry,
      sl,
      tp,
      confidence: confidence != null && confidence !== "" ? Number(confidence) : undefined,
      handle: "@VertexScanner"
    });
    try {
      const result = await uploadToYoutube(videoPath, {
        title: `${pair} ${String(direction).toUpperCase()} Signal`,
        description: "Vertex Signal — not financial advice, trade your own plan.",
        tags: ["forex", "trading", "signals", pair]
      });
      res.type("html").send(`<body style="font-family:system-ui;background:#0a0d12;color:#dde3ea;padding:40px;"><h2>Posted ✅</h2><p><a href="${result.url}" style="color:#3ddc84;">${result.url}</a></p></body>`);
    } finally {
      require("fs").unlink(videoPath, () => {});
    }
  } catch (err) {
    console.error("Quick-post video failed:", err.message);
    res.status(502).send(`Failed: ${err.message}`);
  }
}

// Posts a video King already made/recorded himself, straight to YouTube —
// no generation step, just upload. Disk storage (not memory) since these
// files run tens of MB. The cap below is deliberately small: the uploader
// has to hold the whole file in RAM to build the multipart body, and this
// instance only has 512 MB. A 300 MB limit used to crash the server.
const uploadRawVideo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, require("os").tmpdir()),
    filename: (req, file, cb) => cb(null, `vx-raw-${crypto.randomBytes(6).toString("hex")}.mp4`)
  }),
  limits: { fileSize: 48 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^video\//.test(file.mimetype)) {
      return cb(new Error("Please upload a video file."));
    }
    cb(null, true);
  }
});

// Simple phone-friendly upload form — pick a video, type a title, hit post.
app.get("/api/admin/videos/upload-raw-form", (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).send("Unlock /admin with the PIN first, then try this link again.");
  }
  res.type("html").send(`
    <body style="font-family:system-ui;background:#0a0d12;color:#dde3ea;padding:24px;max-width:480px;margin:0 auto;">
      <h2>Post a video to YouTube</h2>
      <form id="f" style="display:flex;flex-direction:column;gap:12px;">
        <label>Video file<br><input type="file" name="video" accept="video/*" required></label>
        <label>Title<br><input type="text" name="title" placeholder="Vertex Signal" style="width:100%;padding:8px;"></label>
        <label>Description<br><textarea name="description" style="width:100%;padding:8px;height:70px;"></textarea></label>
        <label><input type="checkbox" name="public" id="pub"> Post as public (default: unlisted)</label>
        <button type="submit" style="padding:12px;font-size:16px;background:#3ddc84;border:0;border-radius:8px;">Upload & Post</button>
      </form>
      <p id="status" style="margin-top:16px;"></p>
      <script>
        document.getElementById('f').addEventListener('submit', async (e) => {
          e.preventDefault();
          const status = document.getElementById('status');
          status.textContent = 'Uploading...';
          const fd = new FormData(e.target);
          if (document.getElementById('pub').checked) fd.set('privacyStatus', 'public');
          fd.delete('public');
          try {
            const res = await fetch('/api/admin/videos/upload-raw', { method: 'POST', body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || res.status);
            status.innerHTML = 'Posted! <a href="' + data.url + '" style="color:#3ddc84;">' + data.url + '</a>';
          } catch (err) {
            status.textContent = 'Failed: ' + err.message;
          }
        });
      </script>
    </body>
  `);
});

app.post("/api/admin/videos/upload-raw", uploadRawVideo.single("video"), async (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    require("fs").unlink(req.file?.path || "", () => {});
    return res.status(401).json({ error: "Unlock /admin first." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No video file received (field name must be 'video')." });
  }
  const { title, description, privacyStatus } = req.body || {};
  try {
    const result = await uploadToYoutube(req.file.path, {
      title: title || "Vertex Signal",
      description: description || "Not financial advice — trade your own plan.",
      tags: ["forex", "trading", "signals"],
      privacyStatus: privacyStatus || "unlisted"
    });
    res.json({ uploaded: true, ...result });
  } catch (err) {
    console.error("Raw video upload failed:", err.message);
    res.status(502).json({ error: err.message });
  } finally {
    require("fs").unlink(req.file.path, () => {});
  }
});

app.post("/api/admin/videos/generate", upload.single("chart"), async (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).json({ error: "Unlock /admin first." });
  }
  const { pair, direction, entry, sl, tp, confidence, handle, uploadToYoutube: shouldUpload, title, description } = req.body || {};
  if (!pair || !direction || !entry || !sl || !tp) {
    return res.status(400).json({ error: "pair, direction, entry, sl and tp are required." });
  }
  let chartImagePath = null;
  const fs = require("fs");
  const os = require("os");
  try {
    if (req.file) {
      chartImagePath = path.join(os.tmpdir(), `vx-chart-${crypto.randomBytes(6).toString("hex")}.png`);
      fs.writeFileSync(chartImagePath, req.file.buffer);
    }
    const videoPath = await generateTradeVideo({
      pair,
      direction,
      entry,
      sl,
      tp,
      confidence: confidence != null && confidence !== "" ? Number(confidence) : undefined,
      chartImagePath,
      handle: handle || "@VertexScanner"
    });
    try {
      if (String(shouldUpload) === "true") {
        const result = await uploadToYoutube(videoPath, {
          title: title || `${pair} ${String(direction).toUpperCase()} Signal`,
          description: description || "Vertex Signal — not financial advice, trade your own plan.",
          tags: ["forex", "trading", "signals", pair]
        });
        return res.json({ uploaded: true, ...result });
      }
      res.set("Content-Type", "video/mp4");
      res.set("Content-Disposition", 'attachment; filename="vertex-signal.mp4"');
      return fs.createReadStream(videoPath).pipe(res).on("close", () => fs.unlink(videoPath, () => {}));
    } finally {
      if (String(shouldUpload) === "true") fs.unlink(videoPath, () => {});
    }
  } catch (err) {
    console.error("Video generation failed:", err.message);
    res.status(502).json({ error: err.message || "Could not generate the video." });
  } finally {
    if (chartImagePath) fs.unlink(chartImagePath, () => {});
  }
});

// Tracked social links — put these in TikTok/Instagram/YouTube/Facebook
// bios instead of the raw profile URLs. Logging and the email alert are
// both fire-and-forget: a slow Supabase or Resend call never delays the
// redirect the visitor is waiting on.
app.get("/go/:platform", (req, res) => {
  const platform = String(req.params.platform || "").toLowerCase();
  const destination = SOCIAL_LINKS[platform];
  if (!destination) return res.redirect("/");
  logLinkClick(platform);
  sendLinkClickEmail(platform);
  res.redirect(destination);
});

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
        ready: SUPABASE_READY,
        // Chart-photo scanning needs a vision model, so the app can hide /
        // explain the Upload tab instead of offering a button that 503s.
        imageScan: !!(OPENCODE_GO_API_KEY || GEMINI_API_KEY || ANTHROPIC_API_KEY),
        // Public PayPal.Me handle. It is a pay link, not a secret.
        paypalHandle: PAYPAL_ME_HANDLE || "",
        // Card checkout links (Yoco). Empty until the owner creates them in the
        // Yoco dashboard, so the app can say "card checkout isn't live yet"
        // instead of opening a checkout that doesn't exist.
        yoco: YOCO_CHECKOUT_LINKS
      }) +
      ";"
  );
});

// The HTML pages above are no-store so a deploy is always fetched fresh,
// but that's useless if the CSS/JS they reference can still be served from
// a stale cache — exactly what mobile Safari was doing here (old style.css
// missing newly-added rules, serving alongside brand-new HTML). no-cache
// doesn't disable caching, it forces a conditional revalidation (a quick
// 304 if unchanged) on every request, so a real change is always picked up
// without losing the bandwidth savings for unchanged files.
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    index: false,
    setHeaders: (res) => res.set("Cache-Control", "no-cache")
  })
);

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
  res.json({ ok: true, provider: "vertex-feed", accounts: SUPABASE_READY, credits: CREDITS_READY });
});

// --- Watcher routes -------------------------------------------------------
// The feed is what the dashboard polls. Reading it is also what wakes the
// loop up: on a sleeping free instance the interval never fires, so the first
// request after idle triggers a catch-up sweep instead of waiting for a clock
// that isn't running.
app.get("/api/watch/feed", requireUser, (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
    watcher.maybeTick();
    res.json({ ok: true, ...watcher.feed({ limit, full: req.query.full === "1" }) });
  } catch (err) {
    console.error("Watch feed error:", err.message);
    res.status(500).json({ error: "Could not read the watcher right now." });
  }
});

// --- Growth agent routes ---------------------------------------------------
// Admin-only: run a research mission (posts / research / ideas) or read the
// brief history. Capped by GROWTH_MAX_RUNS_PER_DAY to protect the free quota.
app.get("/api/growth/feed", requireUser, (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    res.json({ ok: true, ...growth.feed(Number(req.query.limit) || 10) });
  } catch (err) {
    console.error("Growth feed error:", err.message);
    res.status(500).json({ error: "Could not read the growth agent right now." });
  }
});

app.post("/api/growth/run", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const kind = String(req.body?.kind || "").trim();
    const brief = await growth.run(kind, req.body || {});
    res.json({ ok: true, brief, feed: growth.feed(5) });
  } catch (err) {
    console.error("Growth run error:", err.message);
    res.status(502).json({ error: err.message || "The growth agent could not complete the mission." });
  }
});

// Admin-only: force a sweep now, even outside market hours, so the loop can
// be proven end to end without waiting for the next interval.
app.post("/api/watch/tick", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const result = await watcher.tick({ force: req.query.force === "1" || req.body?.force === true });
    res.json({ ok: true, ...result, feed: watcher.feed({ limit: 10 }) });
  } catch (err) {
    console.error("Watch tick error:", err.message);
    res.status(500).json({ error: err.message || "Watcher tick failed." });
  }
});

// --- FXSynapse response shaping ------------------------------------------
// Moved to analysisMapper.js so the standalone auto-post job can reuse the
// exact same mapping without pulling in the whole Express app.
const { mapFxSynapseToAnalysis } = require("./analysisMapper");
const { analyzeChartImage, prepareImage } = require("./imageAnalysis");
const { annotateChartImage } = require("./imageAnnotate");

// --- Image self-test (admin only) -----------------------------------------
// Runs the exact production image path — same downscale, same prompt, same
// provider walk, same budget — on a screenshot the admin uploads, and reports
// what happened with timings. It skips login and credits on purpose: this is a
// diagnostic, not a scan. Also returns the latest rows from scan_failures so a
// repeat failure leaves a trace even when nobody is watching the live log.
app.post("/api/admin/image-self-test", upload.single("chart"), async (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).json({ error: "Unlock /admin with the PIN first." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "Attach a chart screenshot as 'chart'." });
  }

  const timeframe = String(req.body?.timeframe || "M1").trim().toUpperCase();

  // Probe mode: send the real prompt to each candidate model once and report
  // how long each one actually took, so the production model order and budget
  // are chosen from measurements instead of guesses.
  if (String(req.query?.probe || "") === "1") {
    const { buildSystemPrompt, buildUserPrompt } = require("./analysisPrompt");
    const prepared = await prepareImage(req.file.buffer, req.file.mimetype);
    const probeBody = JSON.stringify({
      systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: prepared.mimeType, data: prepared.buffer.toString("base64") } },
            { text: buildUserPrompt(timeframe.toLowerCase()) }
          ]
        }
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1600, responseMimeType: "application/json" }
    });

    const probe = [];
    for (const model of ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.8-flash"]) {
      const t0 = Date.now();
      try {
        const r = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
          {
            method: "POST",
            headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
            body: probeBody,
            signal: AbortSignal.timeout(20000)
          }
        );
        const d = await r.json().catch(() => null);
        const text = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        probe.push({
          model,
          status: r.status,
          ms: Date.now() - t0,
          ok: r.ok && text.length > 0,
          chars: text.length,
          snippet: text.slice(0, 60)
        });
      } catch (e) {
        probe.push({ model, status: null, ms: Date.now() - t0, ok: false, error: e.message });
      }
    }
    return res.json({ probe });
  }

  let failures = [];
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/scan_failures?select=created_at,pair,timeframe,reason&order=created_at.desc&limit=8`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) failures = await r.json().catch(() => []);
  } catch {}

  const started = Date.now();
  try {
    const prepared = await prepareImage(req.file.buffer, req.file.mimetype);
    const out = await analyzeChartImage({
      buffer: prepared.buffer,
      mimeType: prepared.mimeType,
      timeframe,
      apiKey: ANTHROPIC_API_KEY,
      geminiKey: GEMINI_API_KEY
    });
    res.json({
      ok: true,
      ms: Date.now() - started,
      isChart: out.isChart,
      pair: out.analysis?.pair_guess || null,
      bias: out.analysis?.market_bias || null,
      failures
    });
  } catch (err) {
    res.json({
      ok: false,
      ms: Date.now() - started,
      status: err.status || null,
      error: err.message || String(err),
      failures
    });
  }
});

// --- Pair check (admin only) ----------------------------------------------
// Runs one real pair scan with no login and no credit spent, so the read can
// be inspected (and screenshotted) without touching anyone's balance. Costs one
// FXSynapse call. Read-only: nothing is charged, refunded or written to history.
app.get("/api/admin/pair-check", async (req, res) => {
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).json({ error: "Unlock /admin with the PIN first." });
  }
  const symbol = String(req.query?.symbol || "XAUUSD").trim().toUpperCase();
  const timeframe = String(req.query?.timeframe || "H4").trim().toUpperCase();
  if (!isValidTimeframe(timeframe)) {
    return res.status(400).json({ error: "Pick a valid timeframe (M1, M5, M15, M30, H1, H4, D1, W1)." });
  }
  if (!FXSYNAPSE_API_KEY) {
    return res.status(503).json({ error: "FXSYNAPSE_API_KEY is not set on this server." });
  }

  const started = Date.now();
  try {
    const fxRes = await fetch(`${FXSYNAPSE_BASE_URL}${FXSYNAPSE_CHART_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FXSYNAPSE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ symbol, timeframe, top_down: true }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await fxRes.json().catch(() => null);
    if (!fxRes.ok) {
      return res.json({
        ok: false,
        ms: Date.now() - started,
        status: fxRes.status,
        error: data?.error || data?.message || "The analysis provider returned an error."
      });
    }

    const a = mapFxSynapseToAnalysis(data);
    return res.json({
      ok: true,
      ms: Date.now() - started,
      symbol,
      timeframe,
      bias: a.market_bias,
      confidence: a.confidence,
      confidence_breakdown: a.confidence_breakdown,
      trend: a.market_structure?.trend,
      key_levels: a.market_structure?.key_levels,
      chart_pattern: a.market_structure?.chart_pattern,
      entries: a.potential_entries,
      stop_loss: a.stop_loss,
      take_profit: a.take_profit,
      rr: a.risk_reward_estimate,
      invalidation: a.invalidation,
      notes: a.notes,
      concepts: a.concepts
    });
  } catch (err) {
    return res.json({ ok: false, ms: Date.now() - started, error: err.message || String(err) });
  }
});

// --- Market watcher ------------------------------------------------------
// The loop that keeps looking between scans. It calls the provider through
// the exact same request a scan uses, so a watched read and a scanned read
// can never disagree about what the market is doing.
const { createWatcher } = require("./watch");

async function fetchChartForWatcher(symbol, timeframe) {
  if (!FXSYNAPSE_API_KEY) throw new Error("Market data is not configured on this server.");
  const fxRes = await fetch(`${FXSYNAPSE_BASE_URL}${FXSYNAPSE_CHART_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FXSYNAPSE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ symbol, timeframe, top_down: true }),
    signal: AbortSignal.timeout(55000)
  });
  const rawBody = await fxRes.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`Unreadable market data for ${symbol}.`);
  }
  if (!fxRes.ok) {
    throw new Error(data?.detail || data?.error || `Market data unavailable for ${symbol} (${fxRes.status}).`);
  }
  return data;
}

const watcher = createWatcher({ fetchChart: fetchChartForWatcher });

// The growth brain: goes online through Gemini's Google Search grounding and
// writes marketing/growth briefs for the owner. Admin-only endpoints.
const { createGrowthAgent } = require("./growth");
const growth = createGrowthAgent();


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

// --- Social link tracking ---------------------------------------------------
// Fire-and-forget by design: a slow or failing log/email must never delay
// the redirect the visitor is actually waiting on. Both just log to the
// console on failure and never throw.
async function logLinkClick(platform) {
  if (!SUPABASE_READY) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_link_click`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_platform: platform }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Could not log link click:", r.status, await r.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Link click log error:", err.message);
  }
}

async function sendLinkClickEmail(platform) {
  if (!RESEND_API_KEY || !LINK_ALERT_EMAIL) return;
  const label = PLATFORM_LABELS[platform] || platform;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: LINK_ALERT_FROM,
        to: [LINK_ALERT_EMAIL],
        subject: `Someone clicked your ${label} link`,
        text: `Someone just clicked your ${label} link on Vertex Scanner, just now.`
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Could not send link-click email:", r.status, await r.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Link click email error:", err.message);
  }
}

// Lets the admin know the moment a user sends a support or feedback
// message, so King doesn't have to keep checking the admin panel. Same
// Resend wiring/address as the link-click alerts above; best-effort, never
// blocks the user's message from saving.
async function sendAdminInboxAlert(kind, fromEmail, message) {
  if (!RESEND_API_KEY || !LINK_ALERT_EMAIL) return;
  const label = kind === "feedback" ? "feedback" : "support message";
  const preview = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: LINK_ALERT_FROM,
        to: [LINK_ALERT_EMAIL],
        subject: `New ${label} from ${fromEmail || "a user"}`,
        text: `${fromEmail || "A user"} sent a new ${label} on Vertex Scanner:\n\n${preview}\n\nReply from the admin panel.`
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error(`Could not send admin ${label} alert:`, r.status, await r.text().catch(() => ""));
    }
  } catch (err) {
    console.error(`Admin ${label} alert error:`, err.message);
  }
}

// Purchase receipt, sent to the buyer once their credits are actually added
// — not a payment confirmation from Whop/Binance themselves, just "here's
// what you got". Reuses the same Resend wiring/shared sending address as
// the admin link-click alerts above; best-effort, never blocks crediting.
const BUNDLE_LABELS = { quick: "Quick", starter: "Starter", trader: "Trader", pro: "Pro", custom: "Custom" };
async function sendReceiptEmail(toEmail, bundle, scans, amountUsd) {
  if (!RESEND_API_KEY || !toEmail) return;
  const label = BUNDLE_LABELS[bundle] || bundle || "Credits";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: LINK_ALERT_FROM,
        to: [toEmail],
        subject: `Your Vertex credits are ready (${scans} scans)`,
        text:
          `Thanks for your purchase!\n\n` +
          `${label} bundle — ${scans} scans added to your account` +
          (amountUsd != null ? ` ($${Number(amountUsd).toFixed(2)})` : "") +
          `.\n\n` +
          `Log in at ${SELF_URL}/app to start scanning.\n\n` +
          `— Vertex Chart Scanner`
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Could not send receipt email:", r.status, await r.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Receipt email error:", err.message);
  }
}

// Proactive "you're running low" email — fired once per crossing by
// use_scan() in supabase/free_scans.sql (low_credit_alert.sql adds the flag
// it uses to avoid re-sending on every low-balance scan).
async function sendLowCreditAlertEmail(toEmail, balance) {
  if (!RESEND_API_KEY || !toEmail) return;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: LINK_ALERT_FROM,
        to: [toEmail],
        subject: `Low on scans — ${balance} credit${balance === 1 ? "" : "s"} left`,
        text:
          `Heads up — you're down to ${balance} paid scan credit${balance === 1 ? "" : "s"}.\n\n` +
          `Top up anytime at ${SELF_URL}/app (Credits tab) so you don't run out mid-session.\n\n` +
          `— Vertex Chart Scanner`
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Could not send low-credit alert email:", r.status, await r.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Low-credit alert email error:", err.message);
  }
}

// Weekly trading recap — one per user who actually logged a journal trade
// in the last 7 days (see weekly_recap_data() in supabase/weekly_recap.sql).
// Triggered by /api/cron/weekly-recap, a Render cron job hits that weekly.
async function sendWeeklyRecapEmail(row) {
  if (!RESEND_API_KEY || !row.email) return;
  const { trades_count, wins, losses, win_rate, top_pair, scans_count } = row;
  const winRateLine = win_rate === null ? "No closed trades yet" : `${win_rate}% win rate (${wins}W / ${losses}L)`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: LINK_ALERT_FROM,
        to: [row.email],
        subject: `Your week on Vertex: ${trades_count} trade${trades_count === 1 ? "" : "s"} logged`,
        text:
          `Here's your week on Vertex:\n\n` +
          `• ${trades_count} trade${trades_count === 1 ? "" : "s"} logged in your journal\n` +
          `• ${winRateLine}\n` +
          (top_pair ? `• Most traded pair: ${top_pair}\n` : "") +
          `• ${scans_count} chart${scans_count === 1 ? "" : "s"} scanned\n\n` +
          `Keep it up - log in at ${SELF_URL}/app to scan more.\n\n` +
          `— Vertex Chart Scanner`
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Could not send weekly recap email:", r.status, await r.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Weekly recap email error:", err.message);
  }
}

// force=true (the admin "send now" button) skips the once-a-week gate and
// sends immediately, without resetting the weekly timer — so testing it
// doesn't push back or double-fire the real scheduled send.
async function runWeeklyRecap(force) {
  if (!SUPABASE_READY) return 0;
  try {
    let due = force;
    if (!due) {
      due = await supabaseRpc("weekly_recap_claim_if_due", { p_secret: CREDIT_FULFILL_SECRET }, SUPABASE_ANON_KEY);
    }
    if (!due) return 0;
    const rows = await supabaseRpc("weekly_recap_data", { p_secret: CREDIT_FULFILL_SECRET }, SUPABASE_ANON_KEY);
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      await sendWeeklyRecapEmail(row);
    }
    console.log(`Weekly recap: sent to ${list.length} user(s).`);
    return list.length;
  } catch (err) {
    console.error("Weekly recap run error:", err.message);
    return 0;
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

// Best-effort audit trail for admin actions (maintenance toggles, feedback
// status changes, support replies, ...). Fire-and-forget — a logging
// failure should never block the admin action it's describing.
function logAdminAction(token, action, detail) {
  supabaseRpc("admin_log_action", { p_action: action, p_detail: detail || null }, token).catch((err) => {
    console.error("Audit log write failed:", err.message);
  });
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
      creditsEarned: stats?.credits_earned ?? 0,
      percentile: stats?.percentile ?? null,
      totalReferrers: stats?.total_referrers ?? null
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
    const amount = Number(order.amount_usd);
    res.json({
      order,
      payTo: { binancePayId: BINANCE_PAY_ID },
      paypal: PAYPAL_ME_HANDLE
        ? {
            handle: PAYPAL_ME_HANDLE,
            meUrl: `https://paypal.me/${encodeURIComponent(PAYPAL_ME_HANDLE)}/${amount.toFixed(2)}`,
            email: ADMIN_EMAIL
          }
        : null,
      instructions:
        `Send exactly $${amount.toFixed(2)} (USDT or equivalent) via Binance Pay to Binance ID ${BINANCE_PAY_ID}. ` +
        "Your credits are added automatically once the payment is detected — usually within a minute."
    });
  } catch (err) {
    console.error("Create order error:", err.message);
    res.status(502).json({ error: "Could not start that order. Please try again." });
  }
});

// "I've paid" on the PayPal path. PayPal.Me has no webhook we can trust without
// a business account, so the buyer tells us and the admin confirms. This does
// not credit anything — it only rings the bell, loudly enough that the buyer
// isn't left waiting. Crediting still happens by a human in /admin.
app.post("/api/credits/paypal-claim", requireUser, async (req, res) => {
  if (!PAYPAL_ME_HANDLE) {
    return res.status(503).json({ error: "PayPal isn't switched on yet — use Binance Pay for now." });
  }
  const orderId = String(req.body?.orderId || "").trim();
  const note = String(req.body?.note || "").trim().slice(0, 300);
  // The amount is what the buyer was shown on their own screen. It is a hint
  // for King to check against PayPal, never a source of truth — nothing is
  // credited from this request.
  const shownAmount = Number(req.body?.amount);
  try {
    notify({
      title: "001: PayPal payment claimed",
      text: [
        "Someone says they paid with PayPal.",
        "",
        `Account: ${req.user.email}`,
        orderId ? `Order: ${orderId}` : "Order: not specified",
        Number.isFinite(shownAmount) && shownAmount > 0 ? `They say they sent: $${shownAmount.toFixed(2)}` : "",
        note ? `Their note: ${note}` : "",
        "",
        "Check PayPal, then confirm the order in /admin so the credits are added.",
        SELF_URL + "/admin"
      ].filter(Boolean).join("\n")
    }).catch((err) => console.error("PayPal claim notice failed:", err.message));

    // Also leave a ticket in the admin inbox, so a missed push notification
    // can never lose a real PayPal payment.
    supabaseRpc(
      "create_support_message",
      {
        p_message:
          "PAYPAL PAYMENT CLAIM\n" +
          `Account: ${req.user.email}\n` +
          (orderId ? `Order: ${orderId}\n` : "") +
          (Number.isFinite(shownAmount) && shownAmount > 0 ? `Amount shown: $${shownAmount.toFixed(2)}\n` : "") +
          (note ? `Buyer note: ${note}\n` : "") +
          "Check PayPal, then add the credits from /admin."
      },
      req.user.token
    ).catch((err) => console.error("PayPal claim ticket failed:", err.message));

    res.json({
      ok: true,
      message: "Thanks — the owner has been told. Credits are usually added within a few hours once the payment is checked."
    });
  } catch (err) {
    console.error("PayPal claim error:", err.message);
    res.status(502).json({ error: "Could not send that just now. If you already paid, it will still be credited." });
  }
});

// "Name your price" is handled entirely in the browser now: PayPal.Me takes the
// amount in the URL, so there is no server checkout to create. The old route
// here built a one-off Whop plan and has been removed with Whop.

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
      `${SUPABASE_URL}/rest/v1/scan_history?select=id,pair,timeframe,bias,signal,starred,created_at&order=created_at.desc&limit=50`,
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

// Delete one of the user's own scan history rows — RLS (scan_history_delete_own,
// see supabase/scan_history.sql) scopes this to the caller's own rows.
app.delete("/api/history/:id", requireUser, async (req, res) => {
  const id = String(req.params.id || "");
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/scan_history?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("History delete failed:", r.status, await r.text().catch(() => ""));
      return res.status(502).json({ error: "Could not delete that scan." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("History delete error:", err.message);
    res.status(502).json({ error: "Could not delete that scan." });
  }
});

// Star/unstar one of the user's own scan history rows — RLS
// (scan_history_update_own, see supabase/scan_history_starred.sql) scopes
// this to the caller's own rows, same pattern as the delete route above.
app.patch("/api/history/:id/star", requireUser, async (req, res) => {
  const id = String(req.params.id || "");
  const starred = !!req.body?.starred;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/scan_history?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${req.user.token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ starred }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("History star failed:", r.status, await r.text().catch(() => ""));
      return res.status(502).json({ error: "Could not update that scan." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("History star error:", err.message);
    res.status(502).json({ error: "Could not update that scan." });
  }
});

// Consecutive-day scan streak, purely a motivational badge on the Scanner
// home — computed here from scan_history's own created_at timestamps rather
// than a separate table. "Today" counts even with zero scans yet (the
// streak just isn't broken until a full day is missed), so the number
// doesn't drop to 0 the moment someone opens the app in the morning.
app.get("/api/stats/streak", requireUser, async (req, res) => {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/scan_history?select=created_at&order=created_at.desc&limit=400`,
      {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!r.ok) return res.json({ streak: 0 });
    const rows = await r.json();
    const days = new Set(
      (Array.isArray(rows) ? rows : []).map((row) => new Date(row.created_at).toISOString().slice(0, 10))
    );
    let streak = 0;
    const cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    // Allow today to be scan-free without breaking the streak yet.
    if (!days.has(cursor.toISOString().slice(0, 10))) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    while (days.has(cursor.toISOString().slice(0, 10))) {
      streak += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    res.json({ streak });
  } catch (err) {
    console.error("Streak fetch error:", err.message);
    res.json({ streak: 0 });
  }
});

// --- Trade journal ----------------------------------------------------------
// A user's own private log of trades, independent of Vertex scans — RLS
// (trade_journal_owner_policy, see supabase/trade_journal.sql) scopes every
// row to its own user_id, so these just pass the caller's own token through,
// same pattern as scan_history.
app.get("/api/journal", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/trade_journal?select=*&order=created_at.desc&limit=200`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) {
      console.error("Journal fetch failed:", r.status, await r.text().catch(() => ""));
      return res.json({ items: [] });
    }
    const items = await r.json();
    res.json({ items: Array.isArray(items) ? items : [] });
  } catch (err) {
    console.error("Journal fetch error:", err.message);
    res.json({ items: [] });
  }
});

app.post("/api/journal", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  const pair = String(req.body?.pair || "").trim().toUpperCase().slice(0, 20);
  const direction = req.body?.direction === "sell" ? "sell" : req.body?.direction === "buy" ? "buy" : null;
  if (!pair) return res.status(400).json({ error: "Pair is required." });
  if (!direction) return res.status(400).json({ error: "Direction must be buy or sell." });

  const entry = Number.isFinite(Number(req.body?.entry)) ? Number(req.body.entry) : null;
  const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 1000) : null;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/trade_journal`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${req.user.token}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({ user_id: req.user.id, pair, direction, entry, notes }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Journal create failed:", r.status, await r.text().catch(() => ""));
      return res.status(502).json({ error: "Could not save that trade. Has supabase/trade_journal.sql been run?" });
    }
    const rows = await r.json().catch(() => []);
    res.json({ ok: true, item: Array.isArray(rows) ? rows[0] : null });
  } catch (err) {
    console.error("Journal create error:", err.message);
    res.status(502).json({ error: "Could not save that trade." });
  }
});

app.patch("/api/journal/:id", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  const id = String(req.params.id || "");
  const patch = {};
  if (req.body?.exit !== undefined) {
    const exit = Number(req.body.exit);
    patch.exit = Number.isFinite(exit) ? exit : null;
  }
  if (req.body?.entry !== undefined) {
    const entry = Number(req.body.entry);
    patch.entry = Number.isFinite(entry) ? entry : null;
  }
  if (req.body?.result && ["open", "win", "loss", "breakeven"].includes(req.body.result)) {
    patch.result = req.body.result;
    if (req.body.result !== "open") patch.closed_at = new Date().toISOString();
  }
  if (req.body?.pnl !== undefined) {
    const pnl = Number(req.body.pnl);
    patch.pnl = Number.isFinite(pnl) ? pnl : null;
  }
  if (typeof req.body?.notes === "string") patch.notes = req.body.notes.slice(0, 1000);
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing to update." });

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/trade_journal?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${req.user.token}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Journal update failed:", r.status, await r.text().catch(() => ""));
      return res.status(502).json({ error: "Could not update that trade." });
    }
    const rows = await r.json().catch(() => []);
    res.json({ ok: true, item: Array.isArray(rows) ? rows[0] : null });
  } catch (err) {
    console.error("Journal update error:", err.message);
    res.status(502).json({ error: "Could not update that trade." });
  }
});

app.delete("/api/journal/:id", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  const id = String(req.params.id || "");
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/trade_journal?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Journal delete failed:", r.status, await r.text().catch(() => ""));
      return res.status(502).json({ error: "Could not delete that trade." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Journal delete error:", err.message);
    res.status(502).json({ error: "Could not delete that trade." });
  }
});

// --- MT4/MT5 broker connection (MetaApi.cloud) -------------------------------
// One broker account per user. The password is sent once, straight through
// to MetaApi's provisioning API in this same request, and never written to
// our own database — see supabase/broker_accounts.sql.
app.get("/api/broker/mine", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const [accountRes, hasAccess] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/broker_accounts?select=platform,login,server,status,status_detail,created_at&limit=1`,
        {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` },
          signal: AbortSignal.timeout(8000)
        }
      ),
      supabaseRpc("has_broker_access", {}, req.user.token).catch(() => false)
    ]);
    const rows = accountRes.ok ? await accountRes.json() : [];
    res.json({
      account: Array.isArray(rows) && rows[0] ? rows[0] : null,
      metaapiReady: METAAPI_READY,
      hasAccess: Boolean(hasAccess),
      priceUsd: BROKER_ACCESS_PRICE_USD
    });
  } catch (err) {
    console.error("Broker account fetch error:", err.message);
    res.json({ account: null, metaapiReady: METAAPI_READY, hasAccess: false, priceUsd: BROKER_ACCESS_PRICE_USD });
  }
});

// Starts the one-time R450 (≈ $24.63) broker-connect unlock purchase via the
// same Whop one-off-plan mechanism as the custom credit top-up.
app.post("/api/broker/checkout", requireUser, async (req, res) => {
  if (!WHOP_CUSTOM_READY) {
    return res.status(503).json({
      error: "Broker connect is unlocked by hand right now. Message support in the app and the owner will send you the payment details and unlock it after payment.",
      code: "broker_manual"
    });
  }
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
        initial_price: BROKER_ACCESS_PRICE_USD
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      console.error("Whop broker-access plan failed:", r.status, JSON.stringify(data).slice(0, 1000));
      return res.status(502).json({ error: "Could not start checkout. Please try again shortly." });
    }
    const checkoutUrl = data?.purchase_url || data?.direct_link || data?.checkout_url || data?.data?.purchase_url || null;
    if (!checkoutUrl) {
      console.error("Whop broker-access plan: no checkout URL in response:", JSON.stringify(data).slice(0, 1000));
      return res.status(502).json({ error: "Could not start checkout. Please try again shortly." });
    }
    res.json({ checkoutUrl });
  } catch (err) {
    console.error("Whop broker-access checkout error:", err.message);
    res.status(502).json({ error: "Could not reach checkout right now. Please try again in a moment." });
  }
});

app.post("/api/broker/connect", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if (!METAAPI_READY) {
    return res.status(503).json({ error: "Broker connections aren't turned on yet — check back soon." });
  }
  try {
    const hasAccess = await supabaseRpc("has_broker_access", {}, req.user.token);
    if (!hasAccess) {
      return res.status(402).json({ error: "Unlock broker connect first." });
    }
  } catch (err) {
    console.error("Broker access check failed:", err.message);
    return res.status(502).json({ error: "Could not confirm broker-connect access. Please try again." });
  }
  const platform = String(req.body?.platform || "").toLowerCase();
  const login = String(req.body?.login || "").trim();
  const password = String(req.body?.password || "");
  const server = String(req.body?.server || "").trim();
  if (!["mt4", "mt5"].includes(platform) || !login || !password || !server) {
    return res.status(400).json({ error: "Platform, login, password and server are all required." });
  }

  try {
    // Provision the account with MetaApi. Their API is region-sharded in
    // practice, but this base URL is the documented entry point that
    // resolves correctly for a freshly-created account — confirm against
    // MetaApi's own docs once the real token is in and adjust
    // METAAPI_PROVISIONING_URL if their dashboard points somewhere else.
    const provisionRes = await fetch(`${METAAPI_PROVISIONING_URL}/users/current/accounts`, {
      method: "POST",
      headers: {
        "auth-token": METAAPI_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        login,
        password,
        server,
        platform,
        name: `vertex-${req.user.id}`,
        magic: 0,
        type: "cloud-g2"
      }),
      signal: AbortSignal.timeout(15000)
    });
    const provisionData = await provisionRes.json().catch(() => null);
    if (!provisionRes.ok) {
      const message = (provisionData && (provisionData.message || provisionData.error)) || "MetaApi rejected that account.";
      console.error("MetaApi provisioning failed:", provisionRes.status, message);
      return res.status(502).json({ error: message });
    }

    const metaapiAccountId = provisionData && provisionData.id ? provisionData.id : null;
    const row = {
      user_id: req.user.id,
      platform,
      login,
      server,
      metaapi_account_id: metaapiAccountId,
      status: "pending",
      status_detail: "Connecting to your broker…",
      updated_at: new Date().toISOString()
    };

    // Upsert on user_id — one broker account per user (see the unique index
    // in broker_accounts.sql).
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/broker_accounts?on_conflict=user_id`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${req.user.token}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(8000)
    });
    if (!upsertRes.ok) {
      console.error("Broker account save failed:", upsertRes.status, await upsertRes.text().catch(() => ""));
      return res.status(502).json({ error: "Connected to your broker, but couldn't save it — try again." });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Broker connect error:", err.message);
    res.status(502).json({ error: "Could not reach the broker connection service. Please try again." });
  }
});

app.delete("/api/broker/disconnect", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    // Look up the MetaApi account id first so we can deprovision it there
    // too — otherwise disconnecting here would leave an orphaned account
    // (and its credentials) sitting on MetaApi's side forever.
    let metaapiAccountId = null;
    try {
      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/broker_accounts?user_id=eq.${encodeURIComponent(req.user.id)}&select=metaapi_account_id&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` }, signal: AbortSignal.timeout(8000) }
      );
      if (lookupRes.ok) {
        const rows = await lookupRes.json().catch(() => []);
        metaapiAccountId = Array.isArray(rows) && rows[0] ? rows[0].metaapi_account_id : null;
      }
    } catch {
      // Non-fatal — fall through and still remove our own row.
    }

    if (METAAPI_READY && metaapiAccountId) {
      try {
        const deprovisionRes = await fetch(
          `${METAAPI_PROVISIONING_URL}/users/current/accounts/${encodeURIComponent(metaapiAccountId)}`,
          { method: "DELETE", headers: { "auth-token": METAAPI_TOKEN }, signal: AbortSignal.timeout(15000) }
        );
        if (!deprovisionRes.ok && deprovisionRes.status !== 404) {
          console.error("MetaApi deprovision failed:", deprovisionRes.status, await deprovisionRes.text().catch(() => ""));
          // Still proceed to remove our own row — the user asked to disconnect,
          // and we don't want a MetaApi hiccup to trap them into "connected" forever.
        }
      } catch (err) {
        console.error("MetaApi deprovision error:", err.message);
      }
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/broker_accounts?user_id=eq.${encodeURIComponent(req.user.id)}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      console.error("Broker disconnect failed:", r.status, await r.text().catch(() => ""));
      return res.status(502).json({ error: "Could not disconnect that account." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Broker disconnect error:", err.message);
    res.status(502).json({ error: "Could not disconnect that account." });
  }
});

// Self-service account deletion — deprovisions any connected MT4/MT5 broker
// account first (so nothing is left dangling on MetaApi's side), then calls
// self_delete_account() (supabase/self_delete_account.sql), a security
// definer RPC that deletes every one of the caller's own rows plus their
// auth.users row, using only their own JWT. No service-role key involved.
app.delete("/api/account", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    if (METAAPI_READY) {
      try {
        const lookupRes = await fetch(
          `${SUPABASE_URL}/rest/v1/broker_accounts?user_id=eq.${encodeURIComponent(req.user.id)}&select=metaapi_account_id&limit=1`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` }, signal: AbortSignal.timeout(8000) }
        );
        if (lookupRes.ok) {
          const rows = await lookupRes.json().catch(() => []);
          const metaapiAccountId = Array.isArray(rows) && rows[0] ? rows[0].metaapi_account_id : null;
          if (metaapiAccountId) {
            await fetch(`${METAAPI_PROVISIONING_URL}/users/current/accounts/${encodeURIComponent(metaapiAccountId)}`, {
              method: "DELETE",
              headers: { "auth-token": METAAPI_TOKEN },
              signal: AbortSignal.timeout(15000)
            }).catch((err) => console.error("MetaApi deprovision on account delete failed:", err.message));
          }
        }
      } catch (err) {
        console.error("Broker lookup before account delete failed:", err.message);
      }
    }

    await supabaseRpc("self_delete_account", {}, req.user.token);
    res.json({ ok: true });
  } catch (err) {
    console.error("Account delete error:", err.message);
    res.status(502).json({ error: "Could not delete your account. Please contact support." });
  }
});

// --- Email preferences (user_prefs) ----------------------------------------
// Plain owner-scoped table with RLS already restricting rows to their
// creator, so these just read/write through the caller's own JWT — no
// service-role key or security-definer RPC needed.
app.get("/api/preferences", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_prefs?select=weekly_recap_opt_out,low_credit_alert_opt_out&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return res.json({ weekly_recap_opt_out: false, low_credit_alert_opt_out: false });
    const rows = await r.json().catch(() => []);
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    res.json({
      weekly_recap_opt_out: !!(row && row.weekly_recap_opt_out),
      low_credit_alert_opt_out: !!(row && row.low_credit_alert_opt_out)
    });
  } catch (err) {
    console.error("Preferences fetch error:", err.message);
    res.json({ weekly_recap_opt_out: false, low_credit_alert_opt_out: false });
  }
});

app.post("/api/preferences", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  const body = req.body || {};
  const payload = { user_id: req.user.id, updated_at: new Date().toISOString() };
  if (typeof body.weekly_recap_opt_out === "boolean") payload.weekly_recap_opt_out = body.weekly_recap_opt_out;
  if (typeof body.low_credit_alert_opt_out === "boolean") payload.low_credit_alert_opt_out = body.low_credit_alert_opt_out;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_prefs?on_conflict=user_id`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${req.user.token}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("Preferences save failed:", r.status, text);
      return res.status(502).json({ error: "Could not save your preferences." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Preferences save error:", err.message);
    res.status(502).json({ error: "Could not save your preferences." });
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

// Usage analytics: scans/day (last 14), top pairs (30d), busiest hour (30d).
// See supabase/scan_history.sql's companion admin_scan_analytics() function.
app.get("/api/admin/analytics", requireUser, async (req, res) => {
  if (!SUPABASE_READY) {
    return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  }
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const data = await supabaseRpc("admin_scan_analytics", {}, req.user.token);
    res.json(data || { per_day: [], top_pairs: [], by_hour: [] });
  } catch (err) {
    console.error("Admin analytics error:", err.message);
    res.status(502).json({ error: "Could not load usage analytics. Has the admin_scan_analytics() migration been run?" });
  }
});

// Which day of the week credits actually get bought on — a read-only report
// off existing paid orders, no scheduled job needed: it's just grouped by
// weekday fresh every time the admin page asks.
app.get("/api/admin/purchase-patterns", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const rows = await supabaseRpc("admin_purchase_day_pattern", {}, req.user.token);
    res.json({ days: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error("Admin purchase pattern error:", err.message);
    res.status(502).json({ error: "Could not load purchase patterns. Has supabase/purchase_day_pattern.sql been run?" });
  }
});

// This-month-vs-last-month revenue/orders/signups, for a quick growth-trend
// glance on the admin Stats panel (see supabase/admin_month_comparison.sql).
app.get("/api/admin/month-comparison", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const result = await supabaseRpc("admin_month_comparison", {}, req.user.token);
    res.json(result || {});
  } catch (err) {
    console.error("Admin month comparison error:", err.message);
    res.status(502).json({ error: "Could not load month comparison. Has supabase/admin_month_comparison.sql been run?" });
  }
});

// Per-platform click totals for the TikTok/Instagram/YouTube/Facebook
// tracked links (see /go/:platform above). Same admin-email gate pattern
// as the other admin routes — admin_link_click_summary() in Postgres
// re-checks the admin email independently. See supabase/link_clicks.sql.
app.get("/api/admin/link-clicks", requireUser, async (req, res) => {
  if (!SUPABASE_READY) {
    return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  }
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const rows = await supabaseRpc("admin_link_click_summary", {}, req.user.token);
    res.json({ clicks: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error("Admin link clicks error:", err.message);
    res.status(502).json({ error: "Could not load link clicks. Has supabase/link_clicks.sql been run yet?" });
  }
});

// Content planner: a simple log of posts King batches at night and checks
// off during the day (planned -> scheduled -> posted). Same admin-email
// gate pattern as the routes above; see supabase/content_posts.sql.
app.get("/api/admin/content-posts", requireUser, async (req, res) => {
  if (!SUPABASE_READY) {
    return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  }
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const rows = await supabaseRpc("admin_list_content_posts", {}, req.user.token);
    res.json({ posts: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error("Admin content posts list error:", err.message);
    res.status(502).json({ error: "Could not load posts. Has supabase/content_posts.sql been run yet?" });
  }
});

app.post("/api/admin/content-posts", requireUser, async (req, res) => {
  if (!SUPABASE_READY) {
    return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  }
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const platform = String(req.body?.platform || "").trim().toLowerCase();
  const caption = String(req.body?.caption || "").trim();
  const scheduledFor = req.body?.scheduled_for ? String(req.body.scheduled_for).trim() : null;
  if (!platform) return res.status(400).json({ error: "Platform is required." });
  try {
    const row = await supabaseRpc(
      "admin_add_content_post",
      { p_platform: platform, p_caption: caption, p_scheduled_for: scheduledFor },
      req.user.token
    );
    res.json({ post: row });
  } catch (err) {
    console.error("Admin content post create error:", err.message);
    res.status(502).json({ error: "Could not save the post." });
  }
});

app.patch("/api/admin/content-posts/:id", requireUser, async (req, res) => {
  if (!SUPABASE_READY) {
    return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  }
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const status = String(req.body?.status || "").trim().toLowerCase();
  if (!["planned", "scheduled", "posted"].includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  try {
    await supabaseRpc(
      "admin_set_content_post_status",
      { p_id: req.params.id, p_status: status },
      req.user.token
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Admin content post status error:", err.message);
    res.status(502).json({ error: "Could not update the post." });
  }
});

app.delete("/api/admin/content-posts/:id", requireUser, async (req, res) => {
  if (!SUPABASE_READY) {
    return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  }
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    await supabaseRpc("admin_delete_content_post", { p_id: req.params.id }, req.user.token);
    res.json({ ok: true });
  } catch (err) {
    console.error("Admin content post delete error:", err.message);
    res.status(502).json({ error: "Could not delete the post." });
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

// Every connected MT4/MT5 broker account, for spotting stuck/errored
// connections without querying Supabase directly — admin_list_broker_accounts()
// re-checks the admin email independently, see supabase/broker_accounts.sql.
app.get("/api/admin/broker-accounts", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const rows = await supabaseRpc("admin_list_broker_accounts", {}, req.user.token);
    res.json({ accounts: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error("Admin broker accounts error:", err.message);
    res.status(502).json({ error: "Could not load broker accounts. Has the latest supabase/broker_accounts.sql been run?" });
  }
});

// Manual credit adjustment for support cases — admin_adjust_credits() does
// the actual lookup/update/audit-log, re-checking the admin email itself
// (see supabase/credits_setup.sql).
app.post("/api/admin/credits/adjust", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const email = String(req.body?.email || "").trim();
  const delta = Number(req.body?.delta);
  const reason = String(req.body?.reason || "").trim().slice(0, 300);
  if (!email || !Number.isInteger(delta) || delta === 0) {
    return res.status(400).json({ error: "Email and a non-zero whole-number delta are required." });
  }
  try {
    const rows = await supabaseRpc("admin_adjust_credits", { p_email: email, p_delta: delta, p_reason: reason || null }, req.user.token);
    const result = Array.isArray(rows) && rows[0] ? rows[0] : null;
    res.json({ ok: true, newBalance: result ? result.new_balance : null });
  } catch (err) {
    console.error("Admin adjust credits error:", err.message);
    res.status(502).json({ error: err.message || "Could not adjust that account's credits." });
  }
});

// Ban/unban a user by email — suspends scanning without deleting their
// data (see supabase/user_bans.sql). admin_set_user_banned() re-checks the
// admin email independently.
app.post("/api/admin/users/ban", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const email = String(req.body?.email || "").trim();
  const banned = !!req.body?.banned;
  const reason = String(req.body?.reason || "").trim().slice(0, 300);
  if (!email) return res.status(400).json({ error: "Email is required." });
  try {
    await supabaseRpc("admin_set_user_banned", { p_email: email, p_banned: banned, p_reason: reason || null }, req.user.token);
    res.json({ ok: true });
  } catch (err) {
    console.error("Admin ban user error:", err.message);
    res.status(502).json({ error: err.message || "Could not update that account." });
  }
});

// Weekly trading recap — normally sent by an in-process hourly timer (see
// runWeeklyRecap/setInterval near app.listen below), which checks roughly
// once an hour whether ~7 days have passed since the last send and, if so,
// emails everyone who logged a journal trade that week. This route is a
// manual trigger so King can fire one on demand to test it.
app.post("/api/admin/weekly-recap/send-now", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const sent = await runWeeklyRecap(true);
    res.json({ ok: true, sent });
  } catch (err) {
    console.error("Manual weekly recap error:", err.message);
    res.status(502).json({ error: "Could not send the weekly recap." });
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

// Who actually paid: every paid credit order, newest first, with the buyer's
// email, what they bought and how the payment arrived (Whop webhook or marked
// paid by hand). Read-only — the Pending payments card above is where money
// is confirmed. Needs supabase/admin_buyers.sql.
app.get("/api/admin/buyers", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const buyers = await supabaseRpc("admin_list_buyers", { p_limit: 200 }, req.user.token);
    res.json({ buyers: Array.isArray(buyers) ? buyers : [] });
  } catch (err) {
    console.error("Admin buyers error:", err.message);
    res.status(502).json({ error: "Could not load buyers. Has supabase/admin_buyers.sql been run?" });
  }
});

app.post("/api/admin/orders/:id/mark-paid", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const rows = await supabaseRpc("admin_mark_order_paid", { p_order_id: req.params.id }, req.user.token);
    const order = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (order && order.email) {
      sendReceiptEmail(order.email, order.bundle, order.scans, order.amount_usd).catch(() => {});
    }
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
  if (WHOP_READY) return { ok: true, detail: "Whop webhook is configured (primary route)." };
  if (!CREDITS_READY) return { ok: false, detail: "Missing one of BINANCE_API_KEY/SECRET/CREDIT_FULFILL_SECRET, and WHOP_WEBHOOK_SECRET is not set." };
  return { ok: true, detail: "Binance keys and fulfill secret are set." };
}

async function checkPaymentsReachable() {
  // Whop is the primary payment route now. Binance is a fallback, and its API
  // refuses requests from some host regions (Render gets HTTP 451), which used
  // to make the public status page report payments as broken even though
  // buying worked fine through Whop. A configured Whop webhook is the real
  // signal that people can pay, so check that first.
  if (WHOP_READY) {
    return { ok: true, detail: "Whop webhook configured (primary route). Binance is a fallback and may be unreachable from this host." };
  }
  try {
    // A free, unsigned Binance endpoint - just checks the network path to
    // Binance works at all, independent of whether our API key is valid.
    const r = await fetch("https://api.binance.com/api/v3/ping", { signal: AbortSignal.timeout(6000) });
    return { ok: r.ok, detail: r.ok ? "Binance API reachable." : `Binance responded with HTTP ${r.status}.` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Binance: ${err.message}` };
  }
}

// King specifically asked for the system to tell him plainly when the
// Anthropic API runs out of credit, rather than him finding out by Q2 going
// silent and him having to dig through logs. A tiny 1-token request surfaces
// billing problems here, front and center, instead of buried in console.error
// calls.
//
// It is not free, though: the Gemini key is a free-tier key with a daily cap,
// shared with chart-screenshot reading. Probing on every status poll (the
// status page refreshes, and /api/status is public) can spend a meaningful
// slice of that day's allowance on health checks alone, and a stranger
// hitting the endpoint in a loop can spend all of it. So the probe result is
// cached — including failures, so a 429 doesn't turn every poll into another
// request. A reading a few minutes old is just as useful on a status page.
const AI_CHECK_TTL_MS = 10 * 60 * 1000;
let aiCheckCache = null; // { at, result }

async function probeAiAssistant() {
  if (!hasProvider()) {
    return { ok: false, detail: "No AI key configured (GEMINI_API_KEY or ANTHROPIC_API_KEY) — Q2 can't talk at all." };
  }
  try {
    const out = await generateText({ prompt: "reply with the word ok", maxTokens: 12, temperature: 0, timeoutMs: 9000 });
    return { ok: true, detail: `AI reachable via ${out.provider === "gemini" ? "Gemini (free tier)" : "Anthropic"}.` };
  } catch (err) {
    const raw = String(err.message || "");
    // A rejected key is the single most likely failure here and the least
    // obvious from a stack trace, so name the fix instead of echoing Google.
    const rejectedKey = /401|API key not valid|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(raw);
    return {
      ok: false,
      detail: rejectedKey
        ? "The Gemini key on this server is not accepted by Google (401 API key not valid). Make a free key at aistudio.google.com/apikey and replace GEMINI_API_KEY — until then Q2, the briefing, both insights, support triage, the growth agent and image scans cannot answer."
        : `AI is not answering: ${raw}`
    };
  }
}

async function checkAiAssistant({ force = false } = {}) {
  if (!force && aiCheckCache && Date.now() - aiCheckCache.at < AI_CHECK_TTL_MS) {
    return aiCheckCache.result;
  }
  const result = await probeAiAssistant();
  aiCheckCache = { at: Date.now(), result };
  return result;
}

// Public, unauthenticated status endpoint — same underlying checks as the
// admin health panel, but stripped down to name + up/down only. Never
// includes the admin-only `detail` strings (those can mention key names,
// billing state, etc.) and never requires a login, since the whole point is
// a page anyone — including a worried user — can check without an account.
async function checkDatabasePublic() {
  if (!SUPABASE_READY) return { ok: false };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(6000)
    });
    // Any response at all (even a 401 on the root) means the service is up.
    return { ok: r.status < 500 };
  } catch {
    return { ok: false };
  }
}

// Public maintenance-mode flag — anon RPC, no user token needed, since /app
// has to be able to check this before anyone is logged in.
app.get("/api/maintenance", async (req, res) => {
  if (!SUPABASE_READY) return res.json({ enabled: false, message: null });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/public_get_maintenance`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) return res.json({ enabled: false, message: null });
    const data = await r.json().catch(() => null);
    res.json({ enabled: !!(data && data.enabled), message: (data && data.message) || null });
  } catch (err) {
    console.error("Maintenance check error:", err.message);
    res.json({ enabled: false, message: null }); // fail open — never lock users out because of a check failure
  }
});

app.post("/api/admin/maintenance", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const enabled = !!req.body?.enabled;
  const message = typeof req.body?.message === "string" ? req.body.message.slice(0, 500) : null;
  try {
    const row = await supabaseRpc("admin_set_maintenance", { p_enabled: enabled, p_message: message }, req.user.token);
    logAdminAction(req.user.token, enabled ? "maintenance_on" : "maintenance_off", message || null);
    res.json({ ok: true, enabled: row?.maintenance_mode ?? enabled, message: row?.maintenance_message ?? message });
  } catch (err) {
    console.error("Set maintenance error:", err.message);
    res.status(502).json({ error: "Could not update maintenance mode." });
  }
});

app.get("/api/admin/audit-log", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const items = await supabaseRpc("admin_get_audit_log", { p_limit: 100 }, req.user.token);
    res.json({ items: Array.isArray(items) ? items : [] });
  } catch (err) {
    console.error("Admin audit log fetch error:", err.message);
    res.status(502).json({ error: "Could not load the audit log. Has supabase/admin_audit_log.sql been run?" });
  }
});

// The public status endpoint is unauthenticated, and every call makes real
// outbound requests (database, scan provider, payments, AI). Cached for a
// minute and shared between concurrent callers, so a status page that
// refreshes — or a stranger — can't turn it into a load generator against
// providers we depend on.
const STATUS_CACHE_MS = 60 * 1000;
let statusCache = null; // { at, body }
let statusInFlight = null;

app.get("/api/status", async (req, res) => {
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return res.json(statusCache.body);
  }
  try {
    if (!statusInFlight) {
      statusInFlight = (async () => {
        const [database, scanProvider, paymentsReachable, aiAssistant] = await Promise.all([
          checkDatabasePublic(),
          checkScanProvider(),
          checkPaymentsReachable(),
          checkAiAssistant()
        ]);
        const checks = [
          { name: "Vertex accounts", ok: database.ok },
          { name: "Chart scanning", ok: scanProvider.ok },
          { name: "Payments", ok: paymentsReachable.ok },
          { name: "Q2 assistant", ok: aiAssistant.ok }
        ];
        const body = {
          allOk: checks.every((c) => c.ok),
          checks,
          checkedAt: new Date().toISOString()
        };
        statusCache = { at: Date.now(), body };
        return body;
      })().finally(() => {
        statusInFlight = null;
      });
    }
    res.json(await statusInFlight);
  } catch (err) {
    console.error("Public status error:", err.message);
    res.status(502).json({ error: "Could not check status right now." });
  }
});

app.get("/api/admin/health", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const [accounts, scanProvider, paymentsConfigured, paymentsReachable, aiAssistant] = await Promise.all([
      checkAccounts(req.user.token),
      checkScanProvider(),
      checkPaymentsConfigured(),
      checkPaymentsReachable(),
      checkAiAssistant()
    ]);
    const checks = [
      { name: "Accounts & database", ...accounts },
      { name: "Scan provider", ...scanProvider },
      { name: "Payments configured", ...paymentsConfigured },
      { name: "Payments network (Binance)", ...paymentsReachable },
      { name: "AI assistant (Q2)", ...aiAssistant }
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
// same real data as the health card, user stats and support inbox. Goes
// through server/aiText.js like every other AI feature, so it keeps working
// on whichever provider is alive (free Gemini first, Anthropic as fallback);
// falls back to a plain templated summary (no AI, but still real numbers) if
// no provider answers.
const BRIEFING_AI_SYSTEM_PROMPT = `You are a loyal, sharp AI assistant giving the owner of "Vertex Chart Scanner" a short status briefing, in the style of a calm, capable aide reporting to their commander. Always address them as "sir". Open with a short "Welcome back, sir" style greeting, then report the real numbers you're given in plain, confident language. If something needs attention (a failing system check, open support tickets, pending payments, failed scans), flag it clearly and say what to do about it. When failedScans is greater than 0, always mention the count and, if failedScanReasons is non-empty, name the top reason — this is the kind of thing sir specifically wants surfaced, not buried. If everything looks good, say so and keep it short. Never invent numbers you weren't given — only use what's in the data. Keep it under 90 words, plain text, no markdown, no bullet points, written as natural spoken sentences.`;

async function aiBriefing(data) {
  if (!hasProvider()) return null;
  try {
    const out = await generateText({
      system: BRIEFING_AI_SYSTEM_PROMPT,
      prompt: JSON.stringify(data),
      maxTokens: 250,
      temperature: 0.5,
      timeoutMs: 15000
    });
    return (out.text || "").trim() || null;
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
const supportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many support messages. Please wait a few minutes and try again." }
});

app.post("/api/support", supportLimiter, requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Enter a message first." });
  if (message.length > 4000) return res.status(400).json({ error: "That message is too long." });
  try {
    const row = await supabaseRpc("create_support_message", { p_message: message }, req.user.token);
    res.json({ ok: true });
    sendAdminInboxAlert("support", req.user.email, message).catch(() => {});

    // Fire-and-forget: never make the user wait on the AI call, and never
    // let an AI/network hiccup turn a successfully-saved message into an
    // error response. If this fails, the message just sits as a normal
    // open message with no suggestion, same as if AI wasn't configured.
    if (row && row.id) {
      const isAdmin = (req.user.email || "").toLowerCase() === ADMIN_EMAIL;
      const quick = deterministicSupportReply(message);
      Promise.all([quick ? Promise.resolve(quick) : aiTriageSupportMessage(message, isAdmin), getQ2Autopilot()])
        .then(([result, q2On]) => {
          if (!result) {
            if (!q2On) return;
            return supabaseRpc(
              "system_set_ai_reply",
              { p_id: row.id, p_reply: SUPPORT_HOLD_REPLY, p_suggestion: null, p_secret: CREDIT_FULFILL_SECRET },
              SUPABASE_ANON_KEY
            );
          }
          // High confidence: answer immediately. Low confidence: with the
          // support brain ON, send a safe holding reply and keep the AI's draft
          // for the owner. This means every message gets a response without
          // letting the AI make promises on refunds or account-specific issues.
          const confident = result.confidence === "high";
          const autoReply = confident ? result.reply : (q2On ? SUPPORT_HOLD_REPLY : null);
          const suggestion = confident ? null : result.reply;
          const args = autoReply
            ? { p_id: row.id, p_reply: autoReply, p_suggestion: suggestion, p_secret: CREDIT_FULFILL_SECRET }
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

// Q2 — fully-autonomous support mode (see getQ2Autopilot above). Off by
// default; both routes require the admin's own session, same as every other
// /api/admin/* endpoint.
app.get("/api/admin/q2", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const enabled = await getQ2Autopilot();
    res.json({ enabled });
  } catch (err) {
    console.error("Q2 status read error:", err.message);
    res.status(502).json({ error: "Could not read Q2 status." });
  }
});

app.post("/api/admin/q2", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const enabled = await supabaseRpc("admin_set_q2_autopilot", { p_enabled: req.body?.enabled === true }, req.user.token);
    res.json({ enabled: enabled === true });
  } catch (err) {
    console.error("Q2 toggle error:", err.message);
    res.status(502).json({ error: "Could not update Q2. Has supabase/q2_autopilot.sql been run?" });
  }
});

// Q2 Insight — "what do people actually think of the app". Pulls recent
// support messages and feedback, and has the same AI read between the lines
// for real sentiment/pain points rather than just listing the raw messages
// back. On-demand (button in admin), not automatic — keeps it cheap and
// means it never runs without King asking for it.
const Q2_INSIGHT_SYSTEM_PROMPT = `You are a sharp, honest intelligence aide reporting to the owner of "Vertex Chart Scanner" on what users actually think of the app, based on their real support messages and feedback submissions. Address the owner as "sir". Be direct and unflattering where warranted — this is a status report, not PR. Call out: recurring complaints or bugs, anything people praise, feature requests worth taking seriously, and the overall mood (frustrated, happy, indifferent). If there's too little data to say anything meaningful, say so plainly rather than inventing a read. Keep it under 150 words, plain text, no markdown.`;

async function aiQ2Insight(supportMessages, feedbackMessages) {
  if (!hasProvider()) return null;
  try {
    const out = await generateText({
      system: Q2_INSIGHT_SYSTEM_PROMPT,
      prompt: JSON.stringify({ supportMessages, feedbackMessages }),
      maxTokens: 400,
      temperature: 0.4,
      timeoutMs: 20000
    });
    return (out.text || "").trim() || null;
  } catch (err) {
    console.error("Q2 insight AI failed:", err.message);
    return null;
  }
}

app.get("/api/admin/q2/insight", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const [supportMessages, feedbackMessages] = await Promise.all([
      supabaseRpc("admin_list_support_messages", {}, req.user.token).catch(() => []),
      supabaseRpc("admin_list_feedback", {}, req.user.token).catch(() => [])
    ]);
    const supportCount = Array.isArray(supportMessages) ? supportMessages.length : 0;
    const feedbackCount = Array.isArray(feedbackMessages) ? feedbackMessages.length : 0;
    if (!supportCount && !feedbackCount) {
      return res.json({ summary: "No support messages or feedback yet, sir — nothing to read into." });
    }
    const summary = await aiQ2Insight(
      (Array.isArray(supportMessages) ? supportMessages : []).slice(0, 30),
      (Array.isArray(feedbackMessages) ? feedbackMessages : []).slice(0, 30)
    );
    res.json({
      summary: summary || `Could not reach the AI right now, sir. Raw counts: ${supportCount} support message(s), ${feedbackCount} feedback item(s).`,
      supportCount,
      feedbackCount
    });
  } catch (err) {
    console.error("Q2 insight error:", err.message);
    res.status(502).json({ error: "Could not build the insight report." });
  }
});

// Same idea as /api/admin/q2/insight, but reading YouTube comments instead
// of in-app support/feedback — what actual viewers say under the videos,
// not just the people who bothered to message support.
const Q2_YOUTUBE_INSIGHT_SYSTEM_PROMPT = `You are a sharp, honest intelligence aide reporting to the owner of "Vertex Chart Scanner" on how viewers are reacting to his YouTube videos, based on real comment data (video title, and each comment's text and like count). Address the owner as "sir". Be direct — this is a status report, not PR. Call out: genuine praise vs skepticism/doubt (e.g. "is this real?"), questions people keep asking, anything mocked or criticized, and the overall mood. Note which specific video is getting the strongest reaction if one stands out. If there's too little data to say anything meaningful, say so plainly rather than inventing a read. Keep it under 150 words, plain text, no markdown.`;

async function aiQ2YoutubeInsight(videosWithComments) {
  if (!hasProvider()) return null;
  try {
    const out = await generateText({
      system: Q2_YOUTUBE_INSIGHT_SYSTEM_PROMPT,
      prompt: JSON.stringify(videosWithComments),
      maxTokens: 400,
      temperature: 0.4,
      timeoutMs: 20000
    });
    return (out.text || "").trim() || null;
  } catch (err) {
    console.error("Q2 YouTube insight AI failed:", err.message);
    return null;
  }
}

app.get("/api/admin/q2/youtube-insight", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const { getAccessToken, listRecentVideos, listComments } = require("./video/youtubeUpload");
    const accessToken = await getAccessToken();
    const videos = await listRecentVideos(accessToken, 5);
    if (!videos.length) {
      return res.json({ summary: "No videos found on the connected YouTube channel yet, sir." });
    }
    const videosWithComments = [];
    let totalComments = 0;
    for (const v of videos) {
      const comments = await listComments(accessToken, v.videoId, 20);
      totalComments += comments.length;
      videosWithComments.push({ title: v.title, publishedAt: v.publishedAt, comments });
    }
    if (!totalComments) {
      return res.json({
        summary: "No comments yet on the recent videos, sir — too early to read reactions.",
        videoCount: videos.length,
        commentCount: 0
      });
    }
    const summary = await aiQ2YoutubeInsight(videosWithComments);
    res.json({
      summary: summary || `Could not reach the AI right now, sir. Raw counts: ${videos.length} video(s), ${totalComments} comment(s).`,
      videoCount: videos.length,
      commentCount: totalComments
    });
  } catch (err) {
    console.error("Q2 YouTube insight error:", err.message);
    res.status(502).json({ error: err.message || "Could not build the YouTube report." });
  }
});

app.get("/api/admin/q3", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const enabled = await getQ3Insight();
    res.json({ enabled });
  } catch (err) {
    console.error("Q3 status read error:", err.message);
    res.status(502).json({ error: "Could not read Q3 status." });
  }
});

// --- Q2 Chat — talk to Q2 directly, in one place --------------------------
// King wants Q2 and Q3 merged into one thing he can actually talk to, not
// two separate toggle switches. This is that: a real back-and-forth chat,
// fed a snapshot of real live numbers each turn (not cached/stale) so Q2
// can answer informed questions about the app instead of just small talk.
// Deliberately does NOT let Q2 change any setting or write any code from
// chat — it reports and discusses, it doesn't act on its own. Safer that
// way: nothing it says can break production without King reviewing first.
const Q2_CHAT_SYSTEM_PROMPT = `You are Q2 — the one AI running inside "Vertex Chart Scanner", speaking directly with King, the owner (he addresses you as Q2; you address him as "King" or "sir"). You previously existed as two separate things, Q2 (autonomous support) and Q3 (ask-about-this-scan) — now unified into one presence he talks to directly. You carry yourself like a top-tier hunter who clawed his way to the top and doesn't flinch — think Sung Jinwoo: calm, confident, nothing rattles you, you don't grovel and you don't pad your words with apology. You speak plainly and with weight — short, sure sentences, no corporate hedging, no "I'm just an AI" disclaimers. You're not arrogant for its own sake; you're precise and you back every claim with the real numbers in front of you. You have a live snapshot of real numbers each message (users, scans, support tickets, feedback) — use it when relevant, and never invent numbers you weren't given — bluffing isn't strength, it's a liability. You can discuss the app's health, users, what people think, and ideas to make it stronger. You CANNOT change settings, deploy code, or modify the live service yourself from this chat — if King asks for a change, tell him straight that it needs to go through the build session, not this conversation. Keep replies tight and purposeful unless he asks for depth.`;

app.post("/api/admin/q2/chat", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  if (!hasProvider()) {
    return res.status(503).json({ error: "No AI provider configured — Q2 can't talk yet." });
  }
  const { message, history } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing message." });
  }
  try {
    const [totalUsers, supportMessages, feedbackMessages] = await Promise.all([
      supabaseRpc("admin_user_count", {}, req.user.token).catch(() => null),
      supabaseRpc("admin_list_support_messages", {}, req.user.token).catch(() => []),
      supabaseRpc("admin_list_feedback", {}, req.user.token).catch(() => [])
    ]);
    const snapshot = {
      totalUsers,
      openSupportTickets: (Array.isArray(supportMessages) ? supportMessages : []).filter((m) => m.status !== "resolved").length,
      feedbackCount: Array.isArray(feedbackMessages) ? feedbackMessages.length : 0,
      youtubeConnected: Boolean((process.env.YOUTUBE_REFRESH_TOKEN || "").trim())
    };

    const priorTurns = Array.isArray(history)
      ? history
          .filter((h) => h && typeof h.role === "string" && typeof h.content === "string")
          .slice(-20)
          .map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.content }))
      : [];

    const out = await generateText({
      system: `${Q2_CHAT_SYSTEM_PROMPT}\n\nCurrent live snapshot: ${JSON.stringify(snapshot)}`,
      messages: [...priorTurns, { role: "user", content: message }],
      maxTokens: 500,
      temperature: 0.6,
      timeoutMs: 25000
    });
    res.json({ reply: (out.text || "").trim() || "…" });
  } catch (err) {
    console.error("Q2 chat error:", err.message);
    // "Could not reach Q2" tells King nothing when the real cause is a key
    // Google refused. Say which one and where to replace it.
    const rejectedKey = /401|API key not valid|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(String(err.message || ""));
    res.status(502).json({
      error: rejectedKey
        ? "Q2 can't think: the Gemini key on this server is rejected by Google. Replace GEMINI_API_KEY with a free key from aistudio.google.com/apikey."
        : "Could not reach Q2."
    });
  }
});

app.post("/api/admin/q3", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const enabled = await supabaseRpc("admin_set_q3_insight", { p_enabled: req.body?.enabled === true }, req.user.token);
    res.json({ enabled: enabled === true });
  } catch (err) {
    console.error("Q3 toggle error:", err.message);
    res.status(502).json({ error: "Could not update Q3. Has supabase/q3_insight.sql been run?" });
  }
});

// Public (to any logged-in user) read of whether Q3 is on, so the frontend
// knows whether to show the "Ask about this scan" box at all.
app.get("/api/q3/status", requireUser, async (req, res) => {
  try {
    const enabled = await getQ3Insight();
    res.json({ enabled });
  } catch (err) {
    res.json({ enabled: false });
  }
});

app.post("/api/q3/ask", requireUser, async (req, res) => {
  try {
    const enabled = await getQ3Insight();
    if (!enabled) return res.status(403).json({ error: "This feature is currently off." });

    const question = String(req.body?.question || "").trim();
    const analysis = req.body?.analysis;
    if (!question) return res.status(400).json({ error: "Ask a question first." });
    if (question.length > 300) return res.status(400).json({ error: "Keep it under 300 characters." });
    // A light shape check — not a security boundary (the AI itself is told
    // to stick to this JSON), just a guard against obviously wrong payloads.
    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
      return res.status(400).json({ error: "Run a scan first, then ask about it." });
    }

    const isAdmin = (req.user.email || "").toLowerCase() === ADMIN_EMAIL;
    const reply = await aiExplainScan(analysis, question, isAdmin);
    if (!reply) return res.status(502).json({ error: "Couldn't get an answer just now. Please try again." });
    res.json({ reply });
  } catch (err) {
    console.error("Q3 ask error:", err.message);
    res.status(502).json({ error: "Something went wrong. Please try again." });
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
    logAdminAction(req.user.token, "support_reply", `#${req.params.id}: ${reply.slice(0, 200)}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Admin reply support error:", err.message);
    res.status(502).json({ error: "Could not send that reply." });
  }
});

// --- Feedback / feature requests --------------------------------------------
// Separate from support: this is "tell us what to change", not a question
// needing an answer. Submitted from the same Help tab, but it lands on its
// own build list in the admin page instead of the support inbox.
app.post("/api/feedback", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Enter a message first." });
  if (message.length > 2000) return res.status(400).json({ error: "That message is too long." });
  try {
    const row = await supabaseRpc("create_feedback_message", { p_message: message }, req.user.token);
    res.json({ ok: true });
    sendAdminInboxAlert("feedback", req.user.email, message).catch(() => {});

    // Fire-and-forget, same pattern as support's AI triage: never block the
    // response on this, and a failure here just leaves the suggestion
    // without a reply rather than breaking the submit.
    if (row && row.id) {
      aiAcknowledgeFeedback(message)
        .then((reply) => {
          if (!reply) return;
          return supabaseRpc("system_set_feedback_reply", { p_id: row.id, p_reply: reply, p_secret: CREDIT_FULFILL_SECRET }, SUPABASE_ANON_KEY);
        })
        .catch((err) => console.error("Feedback AI reply save failed:", err.message));
    }
  } catch (err) {
    console.error("Feedback submit error:", err.message);
    res.status(502).json({ error: "Could not send your suggestion. Please try again." });
  }
});

// A user's own feedback submissions with Q2's acknowledgment, if any —
// shown in their Help tab, same pattern as /api/support/mine.
app.get("/api/feedback/mine", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/feedback_messages?select=id,message,status,reply,created_at&order=created_at.desc&limit=20`,
      {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!r.ok) return res.json({ messages: [] });
    const messages = await r.json();
    res.json({ messages: Array.isArray(messages) ? messages : [] });
  } catch (err) {
    console.error("Feedback mine fetch error:", err.message);
    res.json({ messages: [] });
  }
});

// --- Mentorship applications ----------------------------------------------
// Public form on /mentorship. Applications are delivered by email (Resend),
// so this adds no new database table and no admin surface to keep clean. If
// email isn't configured the endpoint says so instead of pretending the
// application was received and losing it.
const mentorshipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many applications from this network. Please try again later." }
});

// Where applications are delivered. Resend's shared sender can only deliver
// to the account owner's own address until a domain is verified there, so
// default to ADMIN_EMAIL rather than the link-alert inbox.
const MENTORSHIP_EMAIL = (process.env.MENTORSHIP_EMAIL || ADMIN_EMAIL || LINK_ALERT_EMAIL).trim();

function cleanField(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, max);
}

app.post("/api/mentorship/apply", mentorshipLimiter, async (req, res) => {
  const body = req.body || {};
  if (cleanField(body.website, 100)) return res.json({ ok: true }); // honeypot

  const name = cleanField(body.name, 80);
  const email = cleanField(body.email, 160);
  const contact = cleanField(body.contact, 80);
  const experience = cleanField(body.experience, 40);
  const market = cleanField(body.market, 40);
  const timezone = cleanField(body.timezone, 60);
  const challenge = cleanField(body.challenge, 1200);
  const goal = cleanField(body.goal, 600);

  if (!name) return res.status(400).json({ error: "Enter your name." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!challenge) return res.status(400).json({ error: "Tell me the one thing you struggle with most." });

  if (!RESEND_API_KEY || !MENTORSHIP_EMAIL) {
    return res.status(503).json({
      error: "Applications aren't being accepted online right now. Message @verte.x6 on Instagram and you'll get a reply.",
      code: "mentorship_offline"
    });
  }

  const lines = [
    "New mentorship application",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    contact ? `Telegram / WhatsApp: ${contact}` : null,
    experience ? `Experience: ${experience}` : null,
    market ? `Market: ${market}` : null,
    timezone ? `Time zone: ${timezone}` : null,
    "",
    "Biggest challenge:",
    challenge,
    goal ? "\nGoal for the next 3 months:" : null,
    goal || null
  ].filter(Boolean).join("\n");

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: LINK_ALERT_FROM,
        to: [MENTORSHIP_EMAIL],
        reply_to: email,
        subject: `Mentorship application — ${name}`,
        text: lines
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) {
      console.error("Mentorship email failed:", r.status, (await r.text().catch(() => "")).slice(0, 300));
      return res.status(502).json({
        error: "Could not send your application just now. Please try again, or message @verte.x6 on Instagram.",
        code: "mentorship_send_failed"
      });
    }
    console.log(`Mentorship application from ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Mentorship submit error:", err.message);
    res.status(502).json({ error: "Could not send your application just now. Please try again." });
  }
});

app.get("/api/admin/feedback", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const items = await supabaseRpc("admin_list_feedback", {}, req.user.token);
    res.json({ items: Array.isArray(items) ? items : [] });
  } catch (err) {
    console.error("Admin feedback list error:", err.message);
    res.status(502).json({ error: "Could not load feedback. Has supabase/feedback_setup.sql been run?" });
  }
});

app.post("/api/admin/feedback/:id/status", requireUser, async (req, res) => {
  if (!SUPABASE_READY) return res.status(503).json({ error: "Accounts are not set up on this server yet." });
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const status = String(req.body?.status || "").trim();
  if (!["new", "planned", "done", "dismissed"].includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  try {
    await supabaseRpc("admin_set_feedback_status", { p_id: req.params.id, p_status: status }, req.user.token);
    logAdminAction(req.user.token, "feedback_status", `#${req.params.id} -> ${status}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Admin feedback status error:", err.message);
    res.status(502).json({ error: "Could not update that item." });
  }
});

// Belt-and-braces against two /api/analyze requests for the same user
// landing back-to-back (a double-click, a retried network request, etc.)
// each spending their own scan. Only one request per user id is allowed to
// be mid-flight at a time; a second one is told to wait rather than
// charged. Cleared in a `finally` below so it never gets stuck.
const scansInFlight = new Set();

// A 512 MB instance cannot hold several phone-sized screenshots at once. Two is
// the ceiling: beyond that the next request is told to retry instead of being
// charged and then killed halfway through. Per-user locking above already stops
// one person doubling up; this stops three different people doing it together.
let imageScansActive = 0;
const MAX_CONCURRENT_IMAGE_SCANS = 2;

// --- Image scanning --------------------------------------------------------
// Upload a chart screenshot and have it read. FXSynapse only works from a
// symbol, so this route uses Claude's vision model through
// server/imageAnalysis.js instead. Same rules as the pair scanner: one scan
// is charged up front, a failure refunds it, the result is saved to history.
// If neither vision key is present the route answers 503 before charging
// anything, and the pair scanner keeps working exactly as before.
app.post("/api/analyze-image", requireUser, analyzeLimiter, upload.single("chart"), async (req, res) => {
  if (!OPENCODE_GO_API_KEY && !GEMINI_API_KEY && !ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: "Chart-photo reading isn't switched on yet. Add OPENCODE_GO_API_KEY on the server, or pick a pair instead.",
      code: "image_scan_unavailable"
    });
  }

  const timeframe = String(req.body?.timeframe || "").trim().toUpperCase();
  if (!req.file) {
    return res.status(400).json({ error: "Choose a chart screenshot (PNG, JPG or WEBP) first." });
  }
  if (!timeframe || !isValidTimeframe(timeframe)) {
    return res.status(400).json({ error: "Pick a timeframe." });
  }
  if (scansInFlight.has(req.user.id)) {
    return res.status(429).json({ error: "A scan is already running for your account. Please wait for it to finish." });
  }
  if (imageScansActive >= MAX_CONCURRENT_IMAGE_SCANS) {
    return res.status(429).json({
      error: "The scanner is reading two other charts right now. Try again in a few seconds — you were not charged.",
      code: "scanner_busy"
    });
  }
  scansInFlight.add(req.user.id);
  imageScansActive += 1;

  try {
    // Downscale once and reuse that copy everywhere below. Doing it before the
    // credit is spent also means a giant upload can never fail after charging.
    const prepared = await prepareImage(req.file.buffer, req.file.mimetype);

    let scanSource = null;
    if (CREDITS_READY) {
      try {
        const result = await supabaseRpc("use_scan", {}, req.user.token);
        scanSource = result?.source || "paid";
        if (result?.low_credit_alert) {
          fetch(
            `${SUPABASE_URL}/rest/v1/user_prefs?select=low_credit_alert_opt_out&limit=1`,
            { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` }, signal: AbortSignal.timeout(8000) }
          )
            .then((r) => (r.ok ? r.json() : []))
            .then((rows) => {
              const optedOut = Array.isArray(rows) && rows[0] && rows[0].low_credit_alert_opt_out;
              if (!optedOut) return sendLowCreditAlertEmail(req.user.email, result.balance);
            })
            .catch(() => {});
        }
      } catch (err) {
        if (/suspended/i.test(err.message || "")) {
          return res.status(403).json({
            error: "Your account has been suspended. Contact support if you think this is a mistake.",
            code: "account_suspended"
          });
        }
        return res.status(402).json({
          error: "You're out of free scans for today and have no credits left. Buy more to keep scanning.",
          code: "no_credits"
        });
      }
    }

    try {
      const { isChart, analysis } = await analyzeChartImage({
        buffer: prepared.buffer,
        mimeType: prepared.mimeType,
        timeframe,
        apiKey: ANTHROPIC_API_KEY,
        geminiKey: GEMINI_API_KEY
      });

      if (!isChart) {
        await refundIfSpent(req.user, scanSource);
        return res.status(422).json({
          error: "That doesn't look like a trading chart. Upload a screenshot of a price chart and try again.",
          code: "not_a_chart"
        });
      }

      // Mark the concepts onto the trader's own screenshot (order-block and
      // FVG zones, sweep/BOS lines). Best-effort: if the annotator can't run,
      // the scan still returns with the text concepts only.
      let annotatedImage = null;
      try {
        annotatedImage = await annotateChartImage({
          buffer: prepared.buffer,
          concepts: analysis.concepts_data,
          priceScale: analysis.concepts_scale,
          planLevels: analysis.plan_levels
        });
      } catch (err) {
        console.error("Annotate step failed:", err.message);
      }
      if (annotatedImage) {
        analysis.annotated_image = annotatedImage.toString("base64");
        analysis.annotated_mime = "image/png";
      }

      res.json({ analysis, timeframe });
      saveHistoryRow(req.user, analysis, timeframe); // fire-and-forget
    } catch (err) {
      await refundIfSpent(req.user, scanSource);
      saveScanFailure(req.user, "chart image", timeframe, err.message || "Image analysis failed");
      // Never pass a provider 401 straight through: the browser treats a 401
      // from this API as a dead login session and signs the user out.
      res.status(err.status === 400 ? 400 : 502).json({
        error: err.message || "Could not read that chart image. Please try again."
      });
    }
  } finally {
    scansInFlight.delete(req.user.id);
    imageScansActive = Math.max(0, imageScansActive - 1);
  }
});

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
  // Spend one scan up front — today's free allowance first (2/day), then
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
      if (result?.low_credit_alert) {
        fetch(
          `${SUPABASE_URL}/rest/v1/user_prefs?select=low_credit_alert_opt_out&limit=1`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.user.token}` }, signal: AbortSignal.timeout(8000) }
        )
          .then((r) => (r.ok ? r.json() : []))
          .then((rows) => {
            const optedOut = Array.isArray(rows) && rows[0] && rows[0].low_credit_alert_opt_out;
            if (!optedOut) return sendLowCreditAlertEmail(req.user.email, result.balance);
          })
          .catch(() => {});
      }
    } catch (err) {
      if (/suspended/i.test(err.message || "")) {
        return res.status(403).json({
          error: "Your account has been suspended. Contact support if you think this is a mistake.",
          code: "account_suspended"
        });
      }
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
      // The browser gives up at 20s, so the server must finish or fail before
      // that. A provider that is still "thinking" at 15s is not going to make
      // the scan feel instant — fail with a clear retry instead of leaving the
      // user staring at a spinner that eventually times out.
      signal: AbortSignal.timeout(15000)
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
          ? "Vertex's analysis engine is temporarily unavailable. We've been notified — please try again shortly."
          : fxRes.status === 404
          ? `No price feed for "${symbol}". Try a major pair, metal or index (e.g. EURUSD, XAUUSD, US30, NAS100).`
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
    autoPostScanVideo(req.user, analysis); // fire-and-forget, King's own scans only
  } catch (err) {
    console.error("Analysis error:", err);
    await refundIfSpent(req.user, scanSource);
    saveScanFailure(req.user, symbol, timeframe, err.message || "Unknown server error");
    res.status(502).json({ error: "Something went wrong while analyzing that chart. Please try again." });
  }
}

// Shared by both auto-post paths below: builds the video for a given
// analysis and uploads it to YouTube, if the analysis actually has a trade
// plan (not a "no clean setup" read). Never throws — failures are logged
// only, since nothing is ever waiting on this.
async function postTradeVideoIfValid(analysis) {
  const entry = analysis.potential_entries?.[0];
  const target = analysis.take_profit?.[0];
  if (!entry || !target || analysis.stop_loss?.value_raw == null) return false; // "no clean setup" scans stay quiet
  const direction = entry.type === "Long" ? "BUY" : "SELL";
  const videoPath = await generateTradeVideo({
    pair: analysis.pair_guess || "—",
    direction,
    entry: entry.entry_zone,
    sl: analysis.stop_loss.suggestion,
    tp: target.target,
    confidence: analysis.confidence,
    handle: "@VertexScanner"
  });
  try {
    const result = await uploadToYoutube(videoPath, {
      title: `${analysis.pair_guess} ${direction} Signal`,
      description: "Vertex Signal — not financial advice, trade your own plan.",
      tags: ["forex", "trading", "signals", analysis.pair_guess].filter(Boolean)
    });
    console.log("Auto-posted scan video to YouTube:", result.url);
    return true;
  } finally {
    require("fs").unlink(videoPath, () => {});
  }
}

// When King scans a pair himself and it comes back with an actual trade plan,
// automatically build a recap video and upload it to YouTube. Never blocks
// or affects the scan response — any failure here is just logged.
async function autoPostScanVideo(user, analysis) {
  try {
    if ((user.email || "").toLowerCase() !== ADMIN_EMAIL) return;
    await postTradeVideoIfValid(analysis);
  } catch (err) {
    console.error("Auto-post scan video failed:", err.message);
  }
}

// --- Automatic scan-and-post cycle ------------------------------------------
// This used to run in-process here via setInterval, but that's what caused
// the OOM crash loop (video generation is memory-heavy, and sharing the
// web server's 512MB with it was too risky). It now runs as a fully
// separate, standalone script: video/autoPostJob.js, scheduled on its own
// as a Render Cron Job. See that file for the actual logic.

// --- Ops agent ------------------------------------------------------------
// The operator, wired in: it can be asked things from /admin and it can check
// on its own. Two routes and one timer, and that is deliberate — every extra
// piece of surface here is something that can act on production.
const opsAgent = require("./opsAgent");

app.get("/api/admin/ops/state", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const snap = await opsAgent.snapshot({ inProcess: true, logMinutes: 60 });
    res.json({
      snapshot: snap,
      reflex: opsAgent.triage(snap),
      decisions: opsAgent.decisions.slice(0, 10),
      restartsLastHour: opsAgent.restartHistory.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "What's wrong?" / "restart it" / "why did we crash at 3am" all land here. The
// model reads the command, but the action still has to be on the allowlist and
// a restart is still capped — being asked does not widen what it can do.
app.post("/api/admin/ops/command", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  // Same rule as every other route that can change the service: the admin PIN
  // must have been unlocked in this browser. Being signed in is not enough for
  // something that can restart production.
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).json({ error: "Unlock /admin with the PIN first." });
  }
  const command = String(req.body?.command || "").trim().slice(0, 500);
  if (!command) return res.status(400).json({ error: "Type what you want it to look at." });
  try {
    const record = await opsAgent.runCycle({ inProcess: true, allowRestart: true, command });
    res.json(record);

    // A command that ends in a restart or an escalation is worth a message,
    // because King asked from a browser he may well close before the answer
    // arrives. Best-effort: the response has already gone.
    const action = record.decision?.action || "none";
    if (action !== "none") {
      notify({
        title: `001: ${record.decision?.verdict || "unknown"}`,
        text: [
          `You asked: ${command}`,
          "",
          record.decision?.assessment || "",
          "",
          `Action: ${record.acted ? (record.acted.ok ? "restarted the service" : `refused — ${record.acted.reason || record.acted.error}`) : action}`,
          record.decision?.why ? `Why: ${record.decision.why}` : "",
          record.decision?.fix ? `Suggested fix: ${record.decision.fix}` : ""
        ].filter(Boolean).join("\n")
      }).catch((err) => console.error("Ops command notice failed:", err.message));
    }
  } catch (err) {
    console.error("Ops agent command failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// The unattended half. Fifteen minutes is a compromise: often enough to catch a
// heap that is climbing, rare enough that a free Gemini key survives. Most runs
// stop at the reflex layer and never call a model at all.
// --- Notifications --------------------------------------------------------
// The agents can reach King now. One pipe is already live (email via Resend);
// Telegram, Discord and ntfy switch on purely by setting env vars, no code
// change. Nothing here can send user emails or secrets — notify.js redacts on
// the way out.
const { notify, channels: notifyChannels, readTopic } = require("./notify");
const { collectMoney, collectMoneyViaAgent, analyse: analyseMoney, renderMoneyBrief } = require("./moneyBrief");
const { DOCTRINE } = require("./agentDoctrine");

// The unattended read: no session, no admin token, just the summary function.
// Returns null instead of throwing when it is not configured or the SQL has not
// been installed yet, so every caller can say "unknown" rather than fail — and
// only complains once, because a log full of the same error is a log nobody
// reads.
let agentMoneyWarned = false;
async function readMoneyUnattended() {
  if (!AGENT_MONEY_SECRET) return null;
  try {
    return await collectMoneyViaAgent({
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      secret: AGENT_MONEY_SECRET
    });
  } catch (err) {
    if (!agentMoneyWarned) {
      agentMoneyWarned = true;
      console.error("001 money read unavailable (run supabase/agent_money.sql):", err.message);
    }
    return null;
  }
}

// Everything 001 is allowed to treat as true when he answers. Shared by the
// panel and the inbox so an answer typed at him and an answer read on screen
// start from the same picture — otherwise he would be two different agents
// depending on which door you came through.
async function buildAgentFacts({ money }) {
  const snap = await opsAgent.snapshot({ inProcess: true, logMinutes: 60 }).catch(() => null);
  const marketFeed = watcher.feed({ full: true, limit: 5 });
  return {
    service: snap
      ? {
          health: snap.health,
          memory: snap.memory,
          restartsInWindow: snap.logs?.restarts ?? null,
          liveCommit: (snap.deploys || []).find((d) => d.status === "live")?.commit || null,
          crashSignals: (snap.logs?.signals || []).slice(-5)
        }
      : "unavailable",
    money,
    market: {
      marketOpen: marketFeed.marketOpen,
      lastTickAt: marketFeed.lastTickAt,
      lastError: marketFeed.lastError,
      reads: (marketFeed.symbolsState || []).slice(0, 3).map((r) => ({
        key: r.key,
        bias: r.bias,
        hasPlan: r.hasPlan,
        side: r.side,
        entry: r.entry,
        stop: r.stop,
        target: r.target,
        confidence: r.confidence,
        at: r.at
      }))
    },
    recentOpsDecisions: opsAgent.decisions.slice(0, 5).map((d) => ({
      at: d.at,
      verdict: d.decision?.verdict,
      action: d.decision?.action,
      why: d.decision?.why
    })),
    product: {
      url: SELF_URL,
      freeTrialScans: 1,
      bundles: Object.entries(CREDIT_BUNDLES).map(([key, b]) => ({ key, scans: b.scans, usd: b.amount })),
      paypalEnabled: Boolean(PAYPAL_ME_HANDLE),
      mentorshipPageLive: true
    }
  };
}

app.get("/api/admin/notify/channels", requireUser, (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  res.json({ configured: notifyChannels() });
});

// Proof that the pipe works end to end. Sent through the same redaction and the
// same senders as a real alert, so a pass here means the real thing will land.
app.post("/api/admin/notify/test", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).json({ error: "Unlock /admin with the PIN first." });
  }
  try {
    const result = await notify({
      title: "001: test message",
      text: [
        "If you are reading this, the agents can reach you.",
        "",
        `Time: ${new Date().toUTCString()}`,
        `This message was requested from /admin.`
      ].join("\n")
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The money brief. Arithmetic first, advice second, and the advice is optional
// — if the model is out of quota the numbers still arrive.
app.get("/api/admin/money/brief", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  try {
    const sessionMoney = await collectMoney({ rpc: (name) => supabaseRpc(name, {}, req.user.token) }).catch(() => null);
    // A session read that comes back empty usually means a migration is missing;
    // the agent's own reader is a second opinion then, not a replacement.
    const data =
      sessionMoney && sessionMoney.users !== null ? sessionMoney : (await readMoneyUnattended()) || sessionMoney;
    const analysis = analyseMoney(data);
    let advice = null;
    if ((process.env.MONEY_BRIEF_AI || "true") !== "false") {
      try {
        const { generateText, hasProvider } = require("./aiText");
        if (hasProvider()) {
          const out = await generateText({
            system:
              "You advise the owner of Vertex Chart Scanner, a forex chart-analysis web app that sells scan credits. " +
              "You are given real numbers. Reply with at most three short bullets, each a concrete action he can take this week with no money to spend. " +
              "Never promise profit, never predict revenue, never use hype. Refer to the actual numbers you were given.\n\n" +
              DOCTRINE,
            prompt: JSON.stringify({ numbers: data, analysis: analysis.findings.map((f) => f.text) }, null, 2),
            maxTokens: 320,
            temperature: 0.3,
            timeoutMs: 20000
          });
          advice = (out?.text || "").trim() || null;
        }
      } catch (err) {
        console.error("Money brief advice failed:", err.message);
      }
    }
    res.json({ data, analysis, advice, text: renderMoneyBrief(data, analysis, advice) });
  } catch (err) {
    console.error("Money brief failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// "Think with me" — the reasoning seat. It gets the same live facts the other
// agents get, plus the money numbers, and answers in a fixed shape: facts,
// options with cost and reversibility, one recommendation, one next step, and
// what it does not know. Read-only by construction: there is no action to take
// from here, so a persuasive answer can never move production.
// The tried-method memory. A bounced path must never be proposed again, and
// the only way to know it bounced is to write it down. Process memory is
// enough here: deploys are rare and a fresh list just means 001 re-derives what
// is obvious. The cap keeps it from growing without bound.
const strategyLog = [];
const STRATEGY_LOG_LIMIT = 60;
function rememberStrategies(strategies) {
  for (const s of strategies || []) {
    if (!s || !s.method || s.status === "untried") continue;
    const key = s.method.toLowerCase().slice(0, 120);
    const existing = strategyLog.find((x) => x.key === key);
    if (existing) {
      existing.status = s.status;
      existing.why = s.why || existing.why;
      existing.at = new Date().toISOString();
    } else {
      strategyLog.push({ key, method: s.method, status: s.status, why: s.why || "", at: new Date().toISOString() });
    }
  }
  while (strategyLog.length > STRATEGY_LOG_LIMIT) strategyLog.shift();
}

app.post("/api/admin/agent/advice", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const question = String(req.body?.question || "").trim().slice(0, 1000);
  if (!question) return res.status(400).json({ error: "Ask something first." });

  try {
    const { advise } = require("./agentAdvice");
    const { generateText } = require("./aiText");

    const sessionMoney = await collectMoney({ rpc: (name) => supabaseRpc(name, {}, req.user.token) }).catch(() => null);
    const money =
      sessionMoney && sessionMoney.users !== null ? sessionMoney : (await readMoneyUnattended()) || sessionMoney;

    const facts = await buildAgentFacts({ money });

    const result = await advise({ question, facts, triedStrategies: strategyLog.slice(-25), generateText });
    if (!result.ok) {
      return res.status(502).json({ error: result.error, raw: result.raw });
    }
    rememberStrategies(result.advice.strategies);
    res.json({ ...result.advice, question, triedCount: strategyLog.length });
  } catch (err) {
    console.error("Agent advice failed:", err.message);
    res.status(502).json({ error: `Could not think that through: ${err.message}` });
  }
});

// The short voice, for the panel's chat box and the ntfy thread. Same facts,
// same doctrine, no report: an order in two or three sentences. Kept as its own
// route so the structured answer ("Think with me") stays available without
// forcing every hello through a four-section template.
app.post("/api/admin/agent/chat", requireUser, async (req, res) => {
  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  const question = String(req.body?.question || "").trim().slice(0, 1000);
  if (!question) return res.status(400).json({ error: "Ask something first." });

  try {
    const { adviseChat, quickAnswer, fallbackAnswer } = require("./agentAdvice");
    const { generateText } = require("./aiText");
    const sessionMoney = await collectMoney({ rpc: (name) => supabaseRpc(name, {}, req.user.token) }).catch(() => null);
    const money =
      sessionMoney && sessionMoney.users !== null ? sessionMoney : (await readMoneyUnattended()) || sessionMoney;
    const facts = await buildAgentFacts({ money });

    // Anything with a factual answer is answered from the facts, immediately.
    // The model is for judgement, not for reciting a latency number, and the
    // free quota is too scarce to spend on "how are you".
    const quick = quickAnswer({ question, facts });
    if (quick) return res.json({ text: quick, question, source: "facts" });

    const result = await adviseChat({ question, facts, generateText, timeoutMs: 14000 });
    if (result.ok) return res.json({ text: result.text, question, source: "model" });
    return res.json({ text: fallbackAnswer({ facts }), question, source: "fallback" });
  } catch (err) {
    console.error("Agent chat failed:", err.message);
    res.json({
      text: `I couldn't read the service just now (${err.message}). Try again in a minute — nothing was changed.`,
      question
    });
  }
});

app.post("/api/admin/money/brief/send", requireUser, async (req, res) => {  if ((req.user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "Not authorized." });
  }
  if (!adminPinCookieIsValid(req.headers.cookie)) {
    return res.status(401).json({ error: "Unlock /admin with the PIN first." });
  }
  try {
    const text = String(req.body?.text || "").slice(0, 8000);
    if (!text) return res.status(400).json({ error: "There is nothing to send yet." });
    const result = await notify({ title: "001: money brief", text });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if ((process.env.OPS_AGENT_ENABLED || "true") !== "false" && opsAgent.renderReady()) {
  const OPS_INTERVAL_MS = Number(process.env.OPS_INTERVAL_MS) || 15 * 60 * 1000;
  let opsRunning = false;

  // An agent that messages on every cycle is an agent people mute, and a muted
  // agent is the same as no agent. Only real findings go out, and the same
  // finding is not repeated more than once every two hours.
  let lastOpsNotice = { key: "", at: 0 };
  const OPS_NOTICE_COOLDOWN_MS = 2 * 60 * 60 * 1000;

  const opsCycleText = (record) => {
    const d = record?.decision || {};
    const snap = record?.snapshot || {};
    const health = snap.health || {};
    const memory = snap.memory || {};
    const lines = [
      `Verdict: ${d.verdict || "unknown"}`,
      d.assessment ? `${d.assessment}` : "",
      "",
      `Action: ${record?.acted ? (record.acted.ok ? "restarted the service" : `restart refused — ${record.acted.reason || record.acted.error}`) : d.action || "none"}`,
      d.why ? `Why: ${d.why}` : "",
      d.fix ? `Suggested fix: ${d.fix}` : "",
      "",
      `Health: ${health.reachable ? `${health.status} in ${health.latencyMs}ms` : "unreachable"}`,
      memory.available ? `Heap: ${memory.heapPercent}% of ${memory.heapLimitMb}MB` : "",
      `Restarts in window: ${snap?.logs?.restarts ?? "—"}`,
      `Live commit: ${(snap.deploys || []).find((x) => x.status === "live")?.commit || "—"}`,
      "",
      SELF_URL + "/admin"
    ];
    return lines.filter(Boolean).join("\n");
  };

  // ---- Money watch ------------------------------------------------------
  // The agents exist because money is the goal, so this is not an afterthought
  // hung off the health check: every cycle 001 reads the same summary the
  // dashboard reads, and speaks only when a number moved. Silent otherwise —
  // an agent that reports "still $0" every 15 minutes gets muted, and a muted
  // agent is no agent.
  let lastMoney = null;
  let moneyBriefDay = "";
  const MONEY_BRIEF_HOUR_UTC = Number(process.env.MONEY_BRIEF_HOUR_UTC ?? 17); // 17:00 UTC = 19:00 SAST

  const moneyWatch = async () => {
    const money = await readMoneyUnattended();
    if (!money) return;
    const prev = lastMoney;
    lastMoney = money;

    if (!prev) {
      console.log(
        `Money: $${Number(money.revenueUsd).toFixed(2)} all-time, ${money.payingUsers ?? "?"} buyer(s), ${money.pendingOrders ?? "?"} pending`
      );
    } else {
      const notes = [];
      const gained = Number(money.revenueUsd) - Number(prev.revenueUsd);
      if (gained > 0.004) {
        notes.push(
          `Money came in: +$${gained.toFixed(2)}. All-time is now $${Number(money.revenueUsd).toFixed(2)} across ${money.orders} order${money.orders === 1 ? "" : "s"}.`
        );
      }
      const newBuyers = Number(money.payingUsers) - Number(prev.payingUsers);
      if (Number.isFinite(newBuyers) && newBuyers > 0) {
        notes.push(`${newBuyers} new paying customer${newBuyers === 1 ? "" : "s"} since my last check.`);
      }
      const newPending = Number(money.pendingOrders) - Number(prev.pendingOrders);
      if (Number.isFinite(newPending) && newPending > 0) {
        notes.push(
          `${money.pendingOrders} payment${money.pendingOrders === 1 ? " is" : "s are"} waiting for you to approve. Someone tried to pay and stopped — that is the closest thing to money you have. ${SELF_URL}/admin`
        );
      }
      if (notes.length) {
        notify({ title: "001: money", text: notes.join("\n\n") })
          .then((r) => {
            if (r.failed?.length) console.error("Money notice failed:", JSON.stringify(r.failed));
          })
          .catch((err) => console.error("Money notice error:", err.message));
      }
    }

    // One full brief in the evening, so the numbers arrive without anyone
    // remembering to ask. No model call here: the arithmetic is the brief.
    const day = new Date().toISOString().slice(0, 10);
    if (moneyBriefDay !== day && new Date().getUTCHours() >= MONEY_BRIEF_HOUR_UTC) {
      moneyBriefDay = day;
      const analysis = analyseMoney(money);
      notify({ title: "001: daily money brief", text: renderMoneyBrief(money, analysis, null) })
        .then((r) => {
          if (r.failed?.length) console.error("Daily brief failed:", JSON.stringify(r.failed));
        })
        .catch((err) => console.error("Daily brief error:", err.message));
    }
  };

  // ---- Inbox: you can type at him ---------------------------------------
  // ntfy was one-way until now: 001 talked, King read. But a topic accepts
  // messages, so the same page is a place to ask. His own messages carry the
  // `robot` tag and are skipped, so he cannot answer himself forever.
  //
  // The clock and the queue. Tracking "since" alone silently loses questions:
  // two typed within one poll window and only the newer one survived, which is
  // how the most important question of the night ("how can we make money") went
  // unanswered while "hi" twice got replies. So messages are deduplicated by
  // ntfy's own id and queued, and every one of them is answered in order.
  const inboxSince = Math.floor(Date.now() / 1000) - 60;
  const inboxSeen = new Set();
  const inboxQueue = [];
  let inboxPrimed = false;
  let inboxBusy = false;
  let lastAnswerAt = 0;
  const INBOX_MIN_GAP_MS = 5 * 1000;
  const INBOX_MAX_PER_HOUR = Number(process.env.INBOX_MAX_PER_HOUR) || 10;
  const answerTimes = [];

  const inboxTick = async () => {
    if (inboxBusy) return;
    inboxBusy = true;
    try {
      const messages = await readTopic({ since: inboxSince, limit: 50 });
      const fresh = [];
      for (const m of messages) {
        const id = m.id || `${m.time}`;
        if (inboxSeen.has(id)) continue;
        inboxSeen.add(id);
        if ((m.tags || []).includes("robot")) continue;
        const text = String(m.message || "").trim();
        if (text.length > 1) fresh.push(text);
      }
      while (inboxSeen.size > 300) {
        const oldest = inboxSeen.values().next().value;
        inboxSeen.delete(oldest);
      }

      // The first look after a restart only learns what is already there. Old
      // questions are not replayed: a reply hours late is worse than none.
      if (!inboxPrimed) {
        inboxPrimed = true;
      } else if (fresh.length) {
        inboxQueue.push(...fresh.slice(-3));
        while (inboxQueue.length > 6) inboxQueue.shift();
      }

      if (!inboxQueue.length) return;
      if (Date.now() - lastAnswerAt < INBOX_MIN_GAP_MS) return;

      const question = inboxQueue.shift();
      console.log(`001 inbox: "${question.slice(0, 80)}"`);
      lastAnswerAt = Date.now();

      // Free model quota is a hard wall, not a nuisance: hit it and every
      // feature that thinks goes quiet, including the product's own assistant.
      // So the chat has a budget, and it says so instead of failing silently.
      answerTimes.push(Date.now());
      while (answerTimes.length && Date.now() - answerTimes[0] > 60 * 60 * 1000) answerTimes.shift();
      if (answerTimes.length > INBOX_MAX_PER_HOUR) {
        const sent = await notify({
          title: "001: quota",
          text: `I am at ${INBOX_MAX_PER_HOUR} answers this hour — the free model quota is nearly gone and I am keeping the rest for your app's own AI, which customers pay for. Ask again in an hour, or open /admin for the full panel.`
        });
        if (sent.failed?.length) console.error("Quota notice failed:", JSON.stringify(sent.failed));
        return;
      }

      const money = await readMoneyUnattended();
      const facts = await buildAgentFacts({ money });
      const { adviseChat, quickAnswer, fallbackAnswer } = require("./agentAdvice");
      const { generateText } = require("./aiText");
      const quick = quickAnswer({ question: question.slice(0, 800), facts });
      const result = quick
        ? { ok: true, text: quick }
        : await adviseChat({ question: question.slice(0, 800), facts, generateText, timeoutMs: 14000 });
      const sent = await notify({
        title: "001",
        text: result.ok ? result.text : fallbackAnswer({ facts })
      });
      if (sent.failed?.length) console.error("Inbox answer delivery failed:", JSON.stringify(sent.failed));
    } catch (err) {
      console.error("001 inbox failed:", err.message);
    } finally {
      inboxBusy = false;
    }
  };

  const opsTick = async () => {
    if (opsRunning) return;
    opsRunning = true;
    try {
      const record = await opsAgent.runCycle({ inProcess: true });
      const verdict = record.decision?.verdict || "unknown";
      const action = record.decision?.action || "none";
      const interesting = action !== "none" || verdict === "degraded" || verdict === "down";
      if (record.reflex.suspicious || action !== "none") {
        console.log(`Ops agent: ${verdict} - ${action} (${record.decision?.why})`);
      }
      if (interesting) {
        const key = `${verdict}:${action}`;
        const stale = Date.now() - lastOpsNotice.at > OPS_NOTICE_COOLDOWN_MS;
        if (lastOpsNotice.key !== key || stale) {
          lastOpsNotice = { key, at: Date.now() };
          notify({ title: `001: ${verdict}`, text: opsCycleText(record) })
            .then((r) => {
              if (r.failed?.length) console.error("Ops notice failed:", JSON.stringify(r.failed));
            })
            .catch((err) => console.error("Ops notice error:", err.message));
        }
      }
    } catch (err) {
      console.error("Ops agent cycle failed:", err.message);
    } finally {
      opsRunning = false;
    }
    // Money is a separate concern from health: a healthy server earning nothing
    // is the actual problem, so it is checked even when the health cycle failed.
    moneyWatch().catch((err) => console.error("Money watch failed:", err.message));
  };
  setTimeout(opsTick, 2 * 60 * 1000).unref();
  setInterval(opsTick, OPS_INTERVAL_MS).unref();
  console.log(`Ops agent: on, checking every ${Math.round(OPS_INTERVAL_MS / 60000)} minutes`);

  // 001 lives in /admin, not on a public topic. ntfy stays a one-way pager:
  // alerts go out, but anything a stranger types into the topic does not come
  // in, cannot spend model quota, and cannot be mistaken for King's voice.
  // INBOX_POLL_MS switches the public inbox back on if that ever changes.
  const INBOX_POLL_MS = Number(process.env.INBOX_POLL_MS) || 0;
  if (INBOX_POLL_MS > 0) {
    setTimeout(inboxTick, 45 * 1000).unref();
    setInterval(inboxTick, INBOX_POLL_MS).unref();
    console.log(`001 inbox: listening on ntfy every ${Math.round(INBOX_POLL_MS / 1000)}s`);
  } else {
    console.log("001 inbox: off — he answers in /admin only");
  }
} else {
  console.log("Ops agent: off (no RENDER_API_KEY or OPS_AGENT_ENABLED=false)");
}

// Unknown API routes get JSON; unknown pages go back to the landing page.
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.get("*", (req, res) => res.redirect("/"));

// Last resort, so an unexpected error returns JSON rather than an HTML stack trace.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A malformed body is the client's mistake, not a server fault: report it as
  // a 400 instead of a 500 so bad input doesn't look like an outage.
  if (err && (err.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400))) {
    return res.status(400).json({ error: "That request wasn't valid. Please try again." });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log(`Vertex Chart Scanner running at http://localhost:${PORT}`);
  console.log(`Using provider: FXSynapse AI (${FXSYNAPSE_BASE_URL})`);
  watcher.start();
});

// Memory watch. The free instance has 512 MB and Node's heap is capped by
// --max-old-space-size in package.json; when it runs out the process aborts
// and everything goes down at once. This doesn't prevent it, it makes the
// cause visible in the logs (with the number) before the crash instead of
// after, so the next expensive code path can be found quickly.
setInterval(() => {
  const mb = (n) => Math.round(n / (1024 * 1024));
  const { heapUsed, heapTotal, rss } = process.memoryUsage();
  if (mb(heapUsed) > 250 || mb(rss) > 420) {
    console.warn(`[mem] heap ${mb(heapUsed)}/${mb(heapTotal)} MB, rss ${mb(rss)} MB`);
  }
}, 15 * 60 * 1000).unref();

// Weekly recap: checked once an hour (not scheduled to a specific day/time)
// so it doesn't matter when the server happens to be up — runWeeklyRecap's
// own ~6.5-day gate (weekly_recap_claim_if_due) is what actually decides
// whether it's due, persisted in app_config so it survives restarts.
setInterval(() => { runWeeklyRecap(false).catch(() => {}); }, 60 * 60 * 1000);

// Also check shortly after startup, in case the server was down across the
// moment it would have fired.
setTimeout(() => { runWeeklyRecap(false).catch(() => {}); }, 60 * 1000);

// --- Staying warm ----------------------------------------------------------
// The free plan spins the service down after ~15 minutes without inbound
// traffic, and waking it back up takes 30-60 seconds — a bad first impression
// on a link posted to Instagram. Only a request from *outside* can wake a
// sleeping instance (GitHub Actions, or the Supabase cron in
// supabase/keepalive_cron.sql). This does something narrower but still worth
// having: once the service is awake, it keeps itself awake, so one visit
// doesn't lapse back to sleep ten minutes later while someone is still
// reading the page. /api/health touches nothing external, so it spends no
// provider quota.
const SELF_PING_MS = 10 * 60 * 1000;
const SELF_PING_ENABLED = Boolean(process.env.RENDER) || process.env.PORT === "10000";
if (SELF_PING_ENABLED) {
  let selfPingFailing = false;
  let selfPingConfirmed = false;
  const selfPing = async () => {
    try {
      const r = await fetch(`${SELF_URL}/api/health`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (selfPingFailing) console.log("Keepalive: self-ping recovered.");
      else if (!selfPingConfirmed) console.log("Keepalive: self-ping confirmed.");
      selfPingFailing = false;
      selfPingConfirmed = true;
    } catch (err) {
      if (!selfPingFailing) console.warn("Keepalive: self-ping failed:", err.message);
      selfPingFailing = true;
    }
  };
  setTimeout(selfPing, 2 * 60 * 1000).unref();
  setInterval(selfPing, SELF_PING_MS).unref();
  console.log(`Keepalive: self-ping ${SELF_URL}/api/health every 10 minutes`);
}

// --- Daily growth agent -----------------------------------------------------
// One unattended run a day: pull the latest Watcher read, draft the posts, and
// send them to the owner. The Watcher keeps the market side current; the
// growth agent turns that into copy. No button needed.
const DAILY_AGENT_ENABLED = (process.env.DAILY_AGENT_ENABLED || "true") !== "false";
const DAILY_AGENT_HOUR_UTC = Math.min(23, Math.max(0, Number(process.env.DAILY_AGENT_HOUR_UTC) || 6));
let dailyAgentDay = "";
let dailyAgentRunning = false;

async function runDailyAgent() {
  if (!DAILY_AGENT_ENABLED || dailyAgentRunning) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < DAILY_AGENT_HOUR_UTC || dailyAgentDay === day) return;
  dailyAgentRunning = true;
  try {
    let read = watcher.feed({ full: true, limit: 1 }).symbolsState?.[0] || null;
    if (!read && watcher.isMarketOpen()) {
      await watcher.tick({ force: true }).catch(() => {});
      read = watcher.feed({ full: true, limit: 1 }).symbolsState?.[0] || null;
    }
    const brief = await growth.run("posts", { read, freeOnly: true });
    await notify({ title: "Vertex: today's posts", text: brief.text });
    dailyAgentDay = day;
    console.log(`Daily agent: posts sent for ${day}`);
  } catch (err) {
    console.error("Daily agent failed:", err.message);
  } finally {
    dailyAgentRunning = false;
  }
}

if (DAILY_AGENT_ENABLED) {
  setTimeout(() => runDailyAgent().catch(() => {}), 90 * 1000).unref();
  setInterval(() => runDailyAgent().catch(() => {}), 10 * 60 * 1000).unref();
  console.log(`Daily agent: posts at ${String(DAILY_AGENT_HOUR_UTC).padStart(2, "0")}:00 UTC`);
}

// 002 — daily market intelligence. One run a day after the post agent: what
// forex traders need, what is changing, the next level-up, and one move today.
const DAILY_REACH_ENABLED = (process.env.DAILY_REACH_ENABLED || "true") !== "false";
const DAILY_REACH_HOUR_UTC = Math.min(23, Math.max(0, Number(process.env.DAILY_REACH_HOUR_UTC) || 9));
let dailyReachDay = "";
let dailyReachRunning = false;

async function runDailyReach() {
  if (!DAILY_REACH_ENABLED || dailyReachRunning) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < DAILY_REACH_HOUR_UTC || dailyReachDay === day) return;
  dailyReachRunning = true;
  try {
    let read = watcher.feed({ full: true, limit: 1 }).symbolsState?.[0] || null;
    if (!read && watcher.isMarketOpen()) {
      await watcher.tick({ force: true }).catch(() => {});
      read = watcher.feed({ full: true, limit: 1 }).symbolsState?.[0] || null;
    }
    const brief = await growth.run("reach", { read, freeOnly: true });
    await notify({ title: "002: today's intel", text: brief.text });
    dailyReachDay = day;
    console.log(`Daily 002: intel sent for ${day}`);
  } catch (err) {
    console.error("Daily 002 failed:", err.message);
  } finally {
    dailyReachRunning = false;
  }
}

if (DAILY_REACH_ENABLED) {
  setTimeout(() => runDailyReach().catch(() => {}), 2 * 60 * 1000).unref();
  setInterval(() => runDailyReach().catch(() => {}), 10 * 60 * 1000).unref();
  console.log(`Daily 002: intel at ${String(DAILY_REACH_HOUR_UTC).padStart(2, "0")}:00 UTC`);
}

// --- Two-minute safe upgrade ----------------------------------------------
// Compares the running commit with the tracked branch and asks Render to
// deploy when they differ. Failures are paced: a commit that failed to build
// is retried at most three times, ten minutes apart, instead of every tick.
// Renders with the same guarantee as push deploys — the old version keeps
// serving while the new one builds, and stays if the build fails.
const upgradeAttempts = new Map(); // sha -> { count, lastTry }

async function autoUpgradeTick() {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID || !RUNNING_COMMIT) return;
  try {
    const gh = await fetch(`https://api.github.com/repos/${UPGRADE_REPO}/commits/main`, {
      headers: { "User-Agent": "vertex-auto-upgrade", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!gh.ok) return; // rate limited or GitHub hiccup — try again next tick
    const head = String((await gh.json())?.sha || "");
    if (!head || head === RUNNING_COMMIT) return;

    const dep = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys?limit=1`, {
      headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!dep.ok) {
      console.error("Auto-upgrade: could not read deploys:", dep.status);
      return;
    }
    const latest = (await dep.json())?.[0]?.deploy || null;
    const active = ["created", "queued", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"];
    if (latest && active.includes(latest.status)) return; // already building something

    const attempt = upgradeAttempts.get(head) || { count: 0, lastTry: 0 };
    const failedThisCommit = latest && latest.commit?.id === head &&
      ["build_failed", "canceled", "deactivated"].includes(latest.status);
    const count = failedThisCommit ? attempt.count + 1 : attempt.count;
    if (count >= 3) return; // three bad builds is enough; wait for a human
    if (attempt.lastTry && Date.now() - attempt.lastTry < 10 * 60 * 1000) return;

    const res = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ commitId: head, clearCache: "do_not_clear" }),
      signal: AbortSignal.timeout(10000)
    });
    upgradeAttempts.set(head, { count, lastTry: Date.now() });
    if (res.ok) {
      console.log(`Auto-upgrade: live ${RUNNING_COMMIT.slice(0, 7)} is behind ${head.slice(0, 7)} — deploy requested`);
    } else {
      console.error("Auto-upgrade: deploy request failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
    }
  } catch (err) {
    console.error("Auto-upgrade check failed:", err.message);
  }
}

if (RENDER_API_KEY) {
  setTimeout(autoUpgradeTick, 60 * 1000).unref();
  setInterval(autoUpgradeTick, UPGRADE_INTERVAL_MS).unref();
  console.log(`Auto-upgrade: checking ${UPGRADE_REPO} every 2 minutes`);
} else {
  console.log("Auto-upgrade: off (no RENDER_API_KEY set)");
}

// --- Memory ---------------------------------------------------------------
// 512 MB instance, 384 MB V8 heap, and the process has died of "JavaScript
// heap out of memory" three times in the last day — which, from the outside,
// simply looks like the scanner stopped working. libvips keeps decoded images
// in its own cache; on a box this small that is memory we cannot spare, so it
// is turned off and the queued image scans are capped above. The five-minute
// line makes the next crash diagnosable instead of a mystery, and the guard
// restarts us at 92% instead of letting a scan die mid-response.
try {
  const sharp = require("sharp");
  sharp.cache(false);
  sharp.concurrency(1);
} catch (err) {
  console.error("Could not tune image memory use:", err.message);
}

let memoryGuardFired = false;
setInterval(() => {  const m = process.memoryUsage();
  const limit = require("v8").getHeapStatistics().heap_size_limit;
  const mb = (n) => Math.round(n / 1048576);
  const pct = limit ? Math.round((m.heapUsed / limit) * 100) : 0;
  console.log(
    `Memory: heap ${mb(m.heapUsed)}MB/${mb(limit)}MB (${pct}%) rss ${mb(m.rss)}MB external ${mb(m.external)}MB imageScans ${imageScansActive}`
  );
  if (pct >= 92 && !memoryGuardFired) {
    memoryGuardFired = true;
    console.error(`Memory guard: heap at ${pct}% - restarting before a scan dies mid-response.`);
    setTimeout(() => process.exit(1), 1000);
  }
}, 5 * 60 * 1000).unref();

