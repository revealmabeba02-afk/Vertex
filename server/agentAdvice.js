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

module.exports = { advise, renderAdvice };

module.exports = { advise, renderAdvice };
