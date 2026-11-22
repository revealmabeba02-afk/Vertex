// Structured advice — the part that reasons about the business rather than the
// process. Same doctrine as everything else, different job: the ops agent asks
// "is the service broken", this asks "what should we do next and why".
//
// The shape is fixed (see agentDoctrine.ANSWER_SHAPE) so the admin panel can
// render it without guessing, and so a model that rambles is visibly wrong
// instead of quietly persuasive. If the model returns prose instead of the
// shape, that is treated as a failure, not "close enough".

const { DOCTRINE, ANSWER_SHAPE } = require("./agentDoctrine");

const SYSTEM_PROMPT = `You are the thinking partner for the owner of Vertex Chart Scanner, a forex chart-analysis web app on a free Render instance, selling scan credits and a small mentorship stream.

He is not a developer. He wants to be told what to do, in order, with the reason after. He has no budget for new services.

You are given: (a) the live state of the server, (b) the money numbers, (c) recent decisions the ops agent made, and (d) his question.

${DOCTRINE}

Reply with JSON only. No prose outside the JSON, no code fences. Shape:
${ANSWER_SHAPE}

If the question is not really a question (a greeting, a thank-you), answer it briefly in "answer" with an empty options list and "nextStep": "".`;

function extractJson(text) {
  const cleaned = String(text || "")
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

function normalise(parsed) {
  const asArray = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const STATUSES = ["hit", "bounced", "missed", "untried"];
  const strategies = Array.isArray(parsed.strategies)
    ? parsed.strategies
        .filter((s) => s && s.method)
        .map((s) => ({
          method: String(s.method).slice(0, 240),
          status: STATUSES.includes(String(s.status || "").toLowerCase())
            ? String(s.status).toLowerCase()
            : "untried",
          why: s.why ? String(s.why).slice(0, 240) : ""
        }))
        .slice(0, 8)
    : [];
  const options = Array.isArray(parsed.options)
    ? parsed.options
        .filter((o) => o && o.action)
        .map((o) => ({
          action: String(o.action).slice(0, 300),
          cost: o.cost ? String(o.cost).slice(0, 160) : "unknown",
          reversible: o.reversible === true
        }))
    : [];
  return {
    goal: parsed.goal ? String(parsed.goal).slice(0, 200) : "",
    obstacle: parsed.obstacle ? String(parsed.obstacle).slice(0, 300) : "",
    answer: String(parsed.answer || "").slice(0, 1200) || "No answer was produced.",
    findings: asArray(parsed.findings).slice(0, 8),
    strategies,
    options: options.slice(0, 5),
    recommendation: String(parsed.recommendation || "none").slice(0, 400),
    nextStep: String(parsed.nextStep || "").slice(0, 400),
    unknowns: asArray(parsed.unknowns).slice(0, 5)
  };
}

// The chat voice. Same brain, different mouth: when 001 is talking to King in a
// message thread he is a second-in-command giving an order, not a report. Short,
// human, first line is the decision. The structured shape above still exists for
// the panel, where depth is the point — but a wall of GOAL/OBSTACLE/FACTS in a
// phone message reads like a machine, and a machine does not get followed.
const CHAT_PROMPT = `You are 001 — the owner's second-in-command at Vertex Chart Scanner, a forex chart-analysis app that sells scan credits.

He calls you 001. You are not an assistant and you are not a chatbot. You are the one who takes command when he asks something.

HOW YOU SPEAK — these are hard rules:
- Two to four sentences. Forty words is plenty. Never a list, never headings, never JSON.
- Open with the order, not the analysis: "Do this first." Then one sentence of why. Then one action.
- Like a person texting their boss at night. Contractions. Plain words. No corporate filler.
- Sign nothing; your name is already on the message.
- One number at most, and only a number that appears in the facts. Never invent, never estimate, never promise money or predict revenue.
- If something you need is missing, say it in one short sentence and name what it blocks.
- Always finish your last sentence. A cut-off sentence reads like a broken machine.
- If he greets you, answer like a person would — one line — then give him the one thing you would do next anyway.

The doctrine below is how you THINK. It is not how you write. Ignore anything in it about output shape, lists, or stages.

${DOCTRINE}`;

function tidyShort(text) {
  let out = String(text || "")
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/g, "")
    .replace(/^\s*(001|Answer|ANSWER)\s*[:\-]\s*/i, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Models like to end with a menu of options. Cut it: a commander gives one.
  out = out.split(/\n\s*(?:-|\*|\d+\.)\s+/)[0].trim();
  if (out.length > 600) out = out.slice(0, 600).replace(/\s+\S*$/, "") + "…";
  return out;
}

// 001 without a model. The free model quota is shared with the product's own
// assistant and runs dry most days; a chat box that shows "…" for a minute is
// worse than one that answers in half a second from numbers it already has.
// These intents cover what King actually asks, and every sentence is read from
// `facts` — no estimates, no promises, no invented prices.
function quickAnswer({ question, facts }) {
  const q = String(question || "").toLowerCase().trim();
  if (!q) return null;

  const service = (facts && facts.service) || {};
  const health = service.health || {};
  const memory = service.memory || {};
  const money = facts && facts.money;

  const up = health.reachable === true;
  const statusLine = up
    ? `The site is up — ${health.status || 200} in ${health.latencyMs || "?"}ms, heap ${memory.heapPercent ?? "?"}%.`
    : "The site is not answering right now.";

  const moneyLine = () => {
    if (!money || money.users == null) {
      return "I still can't see the money — the Supabase reader isn't installed, so any revenue number I gave you would be invented.";
    }
    if (!money.payingUsers) {
      const accounts = Number(money.users) || 0;
      const pending = Number(money.pendingOrders) || 0;
      return `No paying customer yet: ${accounts} account${accounts === 1 ? "" : "s"}, $0 taken${pending ? `, ${pending} order${pending === 1 ? "" : "s"} pending` : ""}.`;
    }
    const paid = Number(money.revenueUsd) || 0;
    const pending = Number(money.pendingOrders) || 0;
    return `$${paid.toFixed(2)} all-time from ${money.payingUsers} paying customer${money.payingUsers === 1 ? "" : "s"}${pending ? `, ${pending} pending` : ""}.`;
  };

  const has = (re) => re.test(q);

  if (has(/\b(hi|hello|hey|yo|sup|morning|evening)\b/) && q.length <= 24) {
    return `I'm here. ${statusLine} ${moneyLine()}`;
  }

  if (has(/\b(how much|revenue|sales|earned|earning|income|balance|made)\b/) ||
      (has(/\b(money|paid|paying|customer|buyer|sold)\b/) && q.length <= 40)) {
    const next =
      !money || money.users == null
        ? "Until that reader exists I'm working blind, so the honest move is to chase the people who already asked about scans."
        : "The next dollar comes from the people who already have an account — ask one of them to buy a bundle today.";
    return `${moneyLine()} ${next}`;
  }

  if (has(/\b(restart|restarted|crash|crashed|down|offline|dead)\b/)) {
    const restarts = service.restartsInWindow;
    if (restarts == null) return `${statusLine} I can't read the restart count right now, so I won't guess.`;
    if (!restarts) return `${statusLine} No restarts in the last hour — nothing crashed.`;
    return `${statusLine} ${restarts} restart${restarts === 1 ? "" : "s"} in the last hour. That's normal when I ship code; if one happens with no deploy behind it, I restart it once and watch.`;
  }

  if (has(/\b(slow|latency|speed|fast|lag|laggy)\b/)) {
    return up ? `${statusLine} That's normal — nothing is slow.` : "The site isn't answering, so it's slow for everyone. I'd restart it once.";
  }

  if (has(/\b(wrong|broken|error|errors|problem|health|status)\b/)) {
    return `${statusLine} Nothing in the snapshot looks wrong.`;
  }

  if (has(/\b(next|today|tomorrow|start|first|step)\b/)) {
    const step =
      !money || money.users == null
        ? "Install the money reader in Supabase — one paste — so I stop guessing about revenue."
        : money.payingUsers
          ? "Message one past buyer and ask what stopped them buying again."
          : "Send the scanner to three traders you actually know and ask for one honest reaction each.";
    return `${step} ${statusLine}`;
  }

  return null;
}

// Last resort when the model is unreachable: still an answer, still honest
// about what this reply is. Never a 502 — a person waiting on his operator
// should get a sentence, even if it is a small one.
function fallbackAnswer({ facts }) {
  const service = (facts && facts.service) || {};
  const health = service.health || {};
  const money = facts && facts.money;
  const up = health.reachable === true;
  const statusLine = up
    ? `The site is up — ${health.status || 200} in ${health.latencyMs || "?"}ms.`
    : "The site is not answering right now.";

  let moneyLine = " I still can't see the money — the Supabase reader isn't installed.";
  if (money && money.users != null) {
    const paid = Number(money.revenueUsd) || 0;
    const payers = Number(money.payingUsers) || 0;
    moneyLine = payers
      ? ` Money: $${paid.toFixed(2)} all-time from ${payers} paying customer${payers === 1 ? "" : "s"}.`
      : ` Money: no paying customer yet, ${Number(money.users) || 0} account${Number(money.users) === 1 ? "" : "s"}.`;
  }

  return `${statusLine}${moneyLine} My thinking model is out of quota, so I can't reason further right now — ask me again in a minute, or open the Money brief.`;
}

// The short form. No JSON, no retry ladder: a plain reply either arrives or it
// does not, and a second attempt at "say it like a person" rarely helps.
async function adviseChat({ question, facts, generateText, timeoutMs = 25000 }) {
  if (typeof generateText !== "function") throw new Error("No text model wired in.");
  const factsBlock = JSON.stringify(facts, null, 1).slice(0, 9000);
  const out = await generateText({
    system: CHAT_PROMPT,
    prompt: `He just said: "${String(question || "").trim() || "well?"}"\n\nWhat you know right now (only these are true):\n${factsBlock}`,
    maxTokens: 1400,
    temperature: 0.4,
    timeoutMs
  });
  const text = tidyShort(out?.text);
  if (!text) return { ok: false, error: "The model returned nothing." };
  return { ok: true, text };
}

async function advise({ question, facts, triedStrategies = [], generateText, timeoutMs = 30000 }) {
  if (typeof generateText !== "function") throw new Error("No text model wired in.");
  const factsBlock = JSON.stringify(facts, null, 2).slice(0, 12000);
  const triedBlock = triedStrategies.length
    ? [
        "",
        "Methods already tried. Do not propose these again unless you are explicitly changing the variable that made them bounce:",
        ...triedStrategies.slice(-25).map((s) => `- [${s.status}] ${s.method}${s.why ? ` — ${s.why}` : ""}`)
      ].join("\n")
    : "";
  const basePrompt = [
    `Question: ${String(question || "").trim() || "What should I do next?"}`,
    triedBlock,
    "",
    "Live facts (everything you are allowed to treat as true):",
    factsBlock
  ].join("\n");

  const ask = async (prompt, maxTokens) =>
    generateText({
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens,
      temperature: 0.25,
      timeoutMs
    });

  // The budget is deliberately generous. The Gemini models in the fallback
  // chain spend part of maxOutputTokens on internal reasoning, so a request
  // sized for the answer alone comes back cut off mid-JSON — which reads as
  // "the model failed" when in fact it never got to finish.
  let out = await ask(basePrompt, 3000);
  let parsed = extractJson(out?.text);

  // First reply truncated or wrapped in prose is the normal failure, not an
  // exception: the model is asked again, tersely. A second failure returns the
  // prose instead of an error — an answer the owner can read beats a form he
  // cannot.
  if (!parsed) {
    out = await ask(
      `${basePrompt}\n\nYour last reply could not be read as JSON. Reply again with valid JSON only, no code fences, no text before or after it, on one line. Keep every string under 20 words.`,
      2000
    );
    parsed = extractJson(out?.text);
  }

  if (!parsed) {
    return {
      ok: true,
      advice: {
        answer: String(out?.text || "").slice(0, 1500) || "No answer was produced.",
        findings: [],
        options: [],
        recommendation: "",
        nextStep: "",
        unknowns: ["The reply did not come back in the expected shape, so this is the model's prose rather than a structured answer."],
        degraded: true
      }
    };
  }
  return { ok: true, advice: normalise(parsed) };
}

// One plain-text rendering, used when the answer travels to a notification
// instead of the admin panel. Same order as the panel so a message and a screen
// never contradict each other.
function renderAdvice(a) {
  const lines = [];
  if (a.goal) lines.push(`GOAL: ${a.goal}`);
  if (a.obstacle) lines.push(`OBSTACLE: ${a.obstacle}`);
  if (a.goal || a.obstacle) lines.push("");
  if (a.answer) lines.push(a.answer);
  if (Array.isArray(a.findings) && a.findings.length) {
    lines.push("", "FACTS");
    a.findings.forEach((f) => lines.push(`- ${f}`));
  }
  if (Array.isArray(a.strategies) && a.strategies.length) {
    const marks = { hit: "[HIT]", bounced: "[BOUNCED]", missed: "[MISSED]", untried: "[UNTRIED]" };
    lines.push("", "PATHS");
    a.strategies.forEach((s) => {
      lines.push(`${marks[s.status] || "[UNTRIED]"} ${s.method}`);
      if (s.why) lines.push(`   ${s.why}`);
    });
  }
  if (Array.isArray(a.options) && a.options.length) {
    lines.push("", "OPTIONS");
    a.options.forEach((o, i) => {
      lines.push(`${i + 1}. ${o.action}`);
      lines.push(`   cost: ${o.cost}${o.reversible ? " · reversible" : " · not reversible"}`);
    });
  }
  if (a.recommendation) lines.push("", `RECOMMENDED: ${a.recommendation}`);
  if (a.nextStep) lines.push("", `DO THIS: ${a.nextStep}`);
  if (Array.isArray(a.unknowns) && a.unknowns.length) {
    lines.push("", "NOT KNOWN");
    a.unknowns.forEach((u) => lines.push(`? ${u}`));
  }
  return lines.join("\n");
}


module.exports = { advise, adviseChat, quickAnswer, fallbackAnswer, renderAdvice };
