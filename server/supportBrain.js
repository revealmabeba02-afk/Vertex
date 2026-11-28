// 001's built-in support brain: the questions that never need a model.
//
// Every answer here is a fixed product fact, which is why support keeps working
// when every AI provider is rate-limited or out of credit. Kept in its own
// module so scripts/agent-eval.js can test it directly — the answers are
// customer-facing money facts (prices, refunds, where to pay), and they had
// already drifted once: the credits answer kept mentioning Whop for days after
// Whop was removed. An eval that runs in one second is how that stops
// happening again.

const SUPPORT_HOLD_REPLY = "Thanks — I've passed this to the team. We'll check it and get back to you here.";

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
        "You get 2 free scans every day. Bundles: Quick $4.99 for 10 scans, Starter $8.99 for 20, Trader $12.99 for 60, Pro $19.99 for 150. Credits never expire. Card, PayPal and bank payments are all credited by hand, usually the same day."
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

module.exports = { deterministicSupportReply, SUPPORT_HOLD_REPLY };
