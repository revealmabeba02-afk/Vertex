const path = require("path");

// Load server/.env by absolute path, so it is found no matter which folder the
// server is started from (project root, server/, a process manager, ...).
// Variables already set in the real environment (Render, Railway, a VPS) win
// over the file, so hosting settings are never overridden.
const ENV_PATH = path.join(__dirname, ".env");
const envLoad = require("dotenv").config({ path: ENV_PATH });

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");

const {
  isValidTimeframe,
  buildSystemPrompt,
  buildUserPrompt
} = require("./analysisPrompt");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 8);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// Supabase handles accounts. The URL and anon key are public by design (they
// ship to every browser) and access is enforced by Supabase itself. The
// service_role key must never be put here: it bypasses all of that.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();

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

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\n[FATAL] ANTHROPIC_API_KEY is not set.\n" +
    "Copy server/.env.example to server/.env and add your key.\n"
  );
  process.exit(1);
}

// The Anthropic client lives only on the server. The API key never
// reaches the browser in any request/response.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

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
// can spend the Anthropic key without an account.
// This gate runs before the upload is read. Answering while the image is
// still arriving makes the connection drop before the browser sees the
// reply, so a logged out user got a network error instead of a clean 401.
// Let an upload of allowed size finish arriving first; anything bigger is
// cut off rather than read.
function rejectUpload(req, res, status, body) {
  res.set("Connection", "close");
  const len = Number(req.headers["content-length"] || 0);
  const maxLen = MAX_UPLOAD_MB * 1024 * 1024 + 256 * 1024;
  if (req.complete || !len || len > maxLen) {
    return res.status(status).json(body);
  }
  req.on("end", () => res.status(status).json(body));
  req.on("error", () => res.destroy());
  req.resume();
}

async function requireUser(req, res, next) {
  if (!SUPABASE_READY) {
    return rejectUpload(req, res, 503, { error: "Accounts are not set up on this server yet." });
  }
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!match) {
    return rejectUpload(req, res, 401, { error: "Please log in to scan charts." });
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${match[1]}` },
      signal: AbortSignal.timeout(8000)
    });
    if (r.status === 401 || r.status === 403) {
      return rejectUpload(req, res, 401, { error: "Your session has expired. Please log in again." });
    }
    if (!r.ok) {
      console.error("Supabase user check failed:", r.status);
      return rejectUpload(req, res, 502, { error: "Could not verify your account right now. Please try again." });
    }
    const user = await r.json();
    if (!user?.id) {
      return rejectUpload(req, res, 401, { error: "Please log in to scan charts." });
    }
    req.user = { id: user.id, email: user.email };
    next();
  } catch (err) {
    console.error("Supabase user check error:", err.message);
    rejectUpload(req, res, 502, { error: "Could not verify your account right now. Please try again." });
  }
}

// --- Upload handling -------------------------------------------------
const ACCEPTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("UNSUPPORTED_FILE_TYPE"));
    }
    cb(null, true);
  }
});

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
  res.json({ ok: true, model: MODEL, accounts: SUPABASE_READY });
});

app.post(
  "/api/analyze",
  requireUser,
  analyzeLimiter,
  (req, res, next) => {
    upload.single("chart")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res
            .status(413)
            .json({ error: `Image too large. Max size is ${MAX_UPLOAD_MB}MB.` });
        }
        return res.status(400).json({ error: "Upload error: " + err.message });
      }
      if (err && err.message === "UNSUPPORTED_FILE_TYPE") {
        return res
          .status(400)
          .json({ error: "Unsupported file type. Please upload PNG, JPEG, or WebP." });
      }
      if (err) return next(err);
      next();
    });
  },
  async (req, res) => {
    try {
      const timeframe = req.body.timeframe;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "No chart image was uploaded." });
      }
      if (!timeframe || !isValidTimeframe(timeframe)) {
        return res.status(400).json({ error: "Invalid or missing timeframe." });
      }

      const base64Image = file.buffer.toString("base64");

      // Anthropic's direct API rejects any single image whose base64-encoded
      // size exceeds 10MB, regardless of what MAX_UPLOAD_MB allows for the
      // raw upload. Check this explicitly so a misconfigured limit fails
      // with a clear message instead of an opaque error from the AI provider.
      const ANTHROPIC_MAX_BASE64_BYTES = 10 * 1024 * 1024;
      if (base64Image.length > ANTHROPIC_MAX_BASE64_BYTES) {
        return res.status(413).json({
          error: "Image is too large once encoded for the AI provider. Please upload a smaller or more compressed image."
        });
      }

      const message = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: buildSystemPrompt(),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: file.mimetype,
                  data: base64Image
                }
              },
              {
                type: "text",
                text: buildUserPrompt(timeframe)
              }
            ]
          }
        ]
      });

      const textBlock = message.content.find((b) => b.type === "text");
      if (!textBlock) {
        return res.status(502).json({ error: "The AI response did not contain analysis text." });
      }

      let analysis;
      try {
        const cleaned = textBlock.text
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "")
          .trim();
        try {
          analysis = JSON.parse(cleaned);
        } catch {
          // Fallback: the model sometimes adds a stray sentence before/after
          // the JSON despite instructions not to. Extract the outermost
          // {...} block and retry once before giving up.
          const start = cleaned.indexOf("{");
          const end = cleaned.lastIndexOf("}");
          if (start === -1 || end === -1 || end <= start) throw new Error("NO_JSON_FOUND");
          analysis = JSON.parse(cleaned.slice(start, end + 1));
        }
        if (typeof analysis !== "object" || analysis === null || Array.isArray(analysis)) {
          throw new Error("NOT_AN_OBJECT");
        }
      } catch (parseErr) {
        console.error("Failed to parse model JSON:", parseErr, textBlock.text);
        return res.status(502).json({
          error: "The AI response could not be parsed. Please try again.",
          raw: textBlock.text
        });
      }

      res.json({ analysis, timeframe, model: MODEL });
    } catch (err) {
      console.error("Analysis error:", err);
      const status = err?.status || 500;
      const message =
        status === 401
          ? "Server is misconfigured (invalid API key)."
          : status === 429
          ? "Rate limited by the AI provider. Please try again shortly."
          : "Something went wrong while analyzing the chart.";
      res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
    }
  }
);

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
  console.log(`Forex Chart Scanner running at http://localhost:${PORT}`);
  console.log(`Using model: ${MODEL}`);
});
