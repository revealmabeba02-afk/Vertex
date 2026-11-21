// Vertex notifications — one call, whichever pipe is configured.
//
// The agents need a way to reach King without him opening the dashboard. Four
// pipes, in order of how easy they are to turn on:
//
//   • Email    — already live (Resend). Works today, zero new accounts.
//   • ntfy     — no account at all: pick a topic name, subscribe in a browser
//                or the ntfy app, done. Best option when there is no phone.
//   • Discord  — one webhook URL from a server's channel settings.
//   • Telegram — needs a bot token from @BotFather, which needs a Telegram
//                account, which needs a phone number to register.
//
// Nothing here decides *what* to say. It takes text and delivers it. That
// separation is deliberate: the agents can be wrong, and a delivery layer that
// only carries messages can't make things worse.
//
// Every message is redacted before it leaves: API keys, bearer tokens, PINs
// and anything that looks like a secret are stripped, because a chat channel is
// less private than the server that sent it.

const TELEGRAM_MAX = 4000;
const DISCORD_MAX = 1900;
const NTFY_MAX = 3900;

function env(name) {
  return (process.env[name] || "").trim();
}

function channels() {
  const list = [];
  if (env("TELEGRAM_BOT_TOKEN") && env("TELEGRAM_CHAT_ID")) list.push("telegram");
  if (env("DISCORD_WEBHOOK_URL")) list.push("discord");
  if (env("NTFY_TOPIC")) list.push("ntfy");
  if (env("RESEND_API_KEY")) list.push("email");
  return list;
}

// Secrets that must never appear in a chat log, a screenshot, or a notification
// history. Patterns are deliberately broad — a false redaction costs nothing,
// a leaked key costs the account.
const SECRET_PATTERNS = [
  /\b(sk|pk|rk|rnd|re|whsec|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
  /\b(pass(word)?|pin|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi
];

function redact(text) {
  let out = String(text == null ? "" : text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

function clamp(text, max) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 20) + "\n… (truncated)";
}

async function post(url, body, headers = {}, timeoutMs = 12000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
}

async function sendTelegram(text, title) {
  const token = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  const message = clamp(title ? `${title}\n\n${text}` : text, TELEGRAM_MAX);
  const r = await post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true
  });
  if (r.ok) return r;
  throw new Error(`Telegram ${r.status}: ${r.body}`);
}

async function sendDiscord(text, title) {
  const url = env("DISCORD_WEBHOOK_URL");
  const content = clamp(title ? `**${title}**\n${text}` : text, DISCORD_MAX);
  const r = await post(url, { content, allowed_mentions: { parse: [] } });
  if (r.ok) return r;
  throw new Error(`Discord ${r.status}: ${r.body}`);
}

async function sendNtfy(text, title) {
  const base = env("NTFY_URL") || "https://ntfy.sh";
  const topic = env("NTFY_TOPIC");
  const r = await fetch(`${base.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: (title || "Vertex").slice(0, 120)
    },
    body: clamp(text, NTFY_MAX),
    signal: AbortSignal.timeout(12000)
  });
  const body = await res2text(r);
  if (r.ok) return { ok: true, status: r.status, body };
  throw new Error(`ntfy ${r.status}: ${body}`);
}

async function res2text(r) {
  return (await r.text().catch(() => "")).slice(0, 300);
}

async function sendEmail(text, title) {
  const apiKey = env("RESEND_API_KEY");
  // onboarding@resend.dev is the only sender this account can use until a
  // domain is verified, and with it Resend only delivers to the address the
  // account itself is registered under. So the owner's own inbox is the
  // default target — an alert that bounces is worse than no alert, because it
  // looks like the system is working.
  const to = env("ALERT_EMAIL") || env("ADMIN_EMAIL") || "revealmabeba02@gmail.com";
  const from = env("LINK_ALERT_FROM") || "Vertex <onboarding@resend.dev>";
  const r = await post(
    "https://api.resend.com/emails",
    {
      from,
      to: [to],
      subject: (title || "Vertex update").slice(0, 120),
      text
    },
    { Authorization: `Bearer ${apiKey}` }
  );
  if (r.ok) return r;
  throw new Error(`Email ${r.status}: ${r.body}`);
}

const SENDERS = {
  telegram: sendTelegram,
  discord: sendDiscord,
  ntfy: sendNtfy,
  email: sendEmail
};

// Deliver to every configured pipe. One broken pipe must not stop the others —
// if Telegram's API is down, the email still goes.
async function notify({ title = "Vertex", text = "", only = null } = {}) {
  const configured = channels().filter((c) => !only || only.includes(c));
  const body = redact(text);
  const safeTitle = redact(title);

  if (!configured.length) {
    return {
      delivered: [],
      failed: [],
      skipped: "No channel is configured. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, DISCORD_WEBHOOK_URL, NTFY_TOPIC, or RESEND_API_KEY."
    };
  }

  const results = await Promise.allSettled(
    configured.map(async (name) => {
      await SENDERS[name](body, safeTitle);
      return name;
    })
  );

  const delivered = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") delivered.push(configured[i]);
    else failed.push({ channel: configured[i], error: String(r.reason?.message || r.reason).slice(0, 300) });
  });

  return { delivered, failed, available: configured };
}

module.exports = { notify, channels, redact };
