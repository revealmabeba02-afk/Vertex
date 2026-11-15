// Vertex growth agent — the part of the brain that looks outward.
//
// The watcher looks at markets; this looks at the internet. When King runs a
// brief it sends Gemini a research mission with the Google Search grounding
// tool enabled, so the model can pull live pages — trends, competitor moves,
// where forex traders are congregating — instead of answering from stale
// training data. On the free Gemini tier grounding costs nothing extra, which
// is the only way an agent with a marketing budget of zero can still do
// online research.
//
// Learning loop: every brief is kept, and the most recent ones are fed into
// the next mission as "what you already know". That is deliberate memory —
// the agent should build on Tuesday's research on Thursday, not start over.
//
// Storage is in-memory (no service-role key on this server, disk is
// ephemeral); the admin page mirrors briefs into localStorage so King keeps
// his history across restarts.

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();

const GROWTH_MODEL = (
  process.env.GROWTH_MODEL ||
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash"
).trim();

const GROWTH_MODELS = [
  ...new Set(
    GROWTH_MODEL.split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .concat(["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash"])
  )
];

const MAX_RUNS_PER_DAY = Number(process.env.GROWTH_MAX_RUNS_PER_DAY) || 10;
const BRIEF_LIMIT = 40;

// What the agent always knows about the company, so briefs are about Vertex
// and not a generic marketing lecture.
const COMPANY_CONTEXT = `
Company: Vertex Chart Scanner (vertex-9s4c.onrender.com).
What it does: scans a forex pair/metal/index and returns bias, market structure, key levels,
entries, stop, targets and invalidation in seconds. Users can also upload a chart screenshot
and get the same read. Free tier: 2 scans/day; paid credit packs, no subscription.
Owner runs everything alone, markets through short-form video (TikTok, Instagram, YouTube)
under the handle @verxter6 / @verte.x6 / @Vertex06.
Audience: beginner-to-intermediate forex traders who want fast, clear reads without paying
for expensive signal groups or year-long courses.
Rules: advice must be executable by one person with no ad budget. Prefer specific tactics
(hooks, formats, posting cadence, communities, keywords) over abstract strategy. Never
suggest anything that requires spending money first.
`.trim();

const MISSIONS = {
  polish: {
    label: "Polish a post",
    // Not a research mission: the draft is already written and filled with
    // real market numbers by the admin page. The job is voice and punch.
    prompt: `
Mission: rewrite the post below so it stops thumbs mid-scroll on its platform. Keep every
number exactly as given — they come from live market data and must not change. Rules:
- Hook must be the first line, under 12 words.
- Short lines, spoken rhythm, no hashtags unless the platform block asks for them.
- No financial advice, no promises of profit, no emoji spam (max one).
- Return only the finished post, nothing else.

PLATFORM: {{platform}}
DRAFT:
{{draft}}`,
  },
  posts: {
    label: "Draft social posts",
    prompt: `
Mission: write this week's short-form social posts for Vertex, grounded in what is actually
trending right now in the forex/trading-content space (use Google Search to check current
trends, sounds, and what competitors are posting).

Deliver, in plain text with clear section headers:
1. WHAT'S WORKING NOW — 3-5 bullet facts you found online this week, each with the source site.
2. POSTS — 6 ready-to-post items: 2 TikTok scripts (hook line first, 20-30s), 2 Instagram
   captions with hashtag sets, 1 YouTube Shorts script, 1 X/Twitter post. Each must be about
   a specific Vertex capability (bias read, screenshot scan, the Watcher), not generic motivation.
3. BEST POSTING TIMES — for a South African audience on those platforms.
4. ONE EXPERIMENT — a single thing to try this week that costs nothing.`,
  },
  research: {
    label: "Find new growth",
    prompt: `
Mission: research how apps like Vertex (fast chart analysis for retail forex traders) are
actually growing right now, and where the open lanes are. Use Google Search for recent info.

Deliver, in plain text:
1. WHERE TRADERS ARE — the 3-5 places (communities, subreddits, Discords, hashtags, search
   terms) where our exact audience gathers this month, with sources.
2. WHAT COMPETITORS DO — what the closest competitors are advertising and where they are weak.
3. OPEN LANES — 3 angles Vertex can own that competitors are not taking.
4. THIS WEEK'S MOVE — the single highest-leverage, zero-cost action, with the first step.`,
  },
  ideas: {
    label: "Level-up ideas",
    prompt: `
Mission: find what product improvements would make Vertex grow fastest. Use Google Search to
check what traders complain about with current tools and what features are trending in
trading apps right now.

Deliver, in plain text:
1. PAIN POINTS — what traders publicly complain about with chart analysis tools this month, sourced.
2. FEATURE IDEAS — 5 concrete features ranked by (growth impact ÷ build effort for one dev).
3. QUICK WINS — 2 things shippable in a weekend.
4. WHAT NOT TO BUILD — 2 tempting features that would waste time and why.`,
  },
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function extractGroundedText(data) {
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("").trim() : "";
  const chunks = cand?.groundingMetadata?.groundingChunks;
  const sources = Array.isArray(chunks)
    ? chunks
        .map((c) => ({ title: c?.web?.title || "", uri: c?.web?.uri || "" }))
        .filter((s) => s.uri)
        .slice(0, 12)
    : [];
  return { text, sources, searchQueries: cand?.groundingMetadata?.webSearchQueries || [] };
}

function createGrowthAgent() {
  const briefs = [];
  const runtime = { runsToday: 0, runDay: todayKey(), lastError: null };

  function rollDay() {
    const today = todayKey();
    if (today !== runtime.runDay) {
      runtime.runDay = today;
      runtime.runsToday = 0;
    }
  }

  // The memory: recent briefs, compressed to their openings, become part of
  // the next mission so the agent compounds instead of repeating itself.
  function memoryBlock() {
    const recent = briefs.slice(0, 2).map((b) => `--- ${b.kind} (${b.at}) ---\n${b.text.slice(0, 1400)}`);
    return recent.length
      ? `\nWHAT YOU ALREADY FOUND (build on this, don't repeat it):\n${recent.join("\n")}\n`
      : "";
  }

  // The raw path skips the search tool: used for voice rewrites where the
  // facts are already in the draft and grounding would only slow it down.
  async function callGeminiRaw(prompt) {
    return callGemini(prompt, { search: false });
  }

  async function callGemini(missionPrompt, opts = {}) {
    const body = JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text:
              "You are the growth brain of Vertex Chart Scanner. You research online before answering " +
              "and always ground claims in what you found. You write for one busy founder: concrete, " +
              "short, zero-budget. Plain text only, no markdown tables, no emoji.\n\n" +
              COMPANY_CONTEXT
          }
        ]
      },
      contents: [{ role: "user", parts: [{ text: missionPrompt + (opts.search === false ? "" : memoryBlock()) }] }],
      tools: opts.search === false ? undefined : [{ google_search: {} }],
      generationConfig: { temperature: 0.55, maxOutputTokens: 3072 }
    });

    let lastFailure = null;
    for (const model of GROWTH_MODELS) {
      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) +
        ":generateContent";
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(90000)
        });
      } catch (err) {
        lastFailure = err;
        continue;
      }
      const data = await response.json().catch(() => null);
      if (response.ok) {
        const out = extractGroundedText(data);
        if (out.text) return out;
        lastFailure = new Error("Gemini returned an empty brief.");
        continue;
      }
      console.error("Growth agent error (gemini/" + model + "):", response.status, data);
      // Some model versions reject the search tool outright; retry the list
      // without it rather than failing the whole run — offline knowledge is
      // still worth more than no brief.
      if (response.status === 400 && data?.error?.message && /tool|search/i.test(data.error.message)) {
        const fallback = await fetch(url, {
          method: "POST",
          headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ ...JSON.parse(body), tools: undefined }),
          signal: AbortSignal.timeout(90000)
        });
        const fbData = await fallback.json().catch(() => null);
        if (fallback.ok) {
          const out = extractGroundedText(fbData);
          if (out.text) return { ...out, ungrounded: true };
        }
        lastFailure = new Error((fbData?.error?.message || "Gemini refused the mission."));
        continue;
      }
      if (response.status === 404 || response.status === 503 || response.status === 429) {
        lastFailure = new Error("Gemini " + response.status + " on " + model);
        continue;
      }
      throw new Error(data?.error?.message || "Gemini rejected the mission (" + response.status + ").");
    }
    throw lastFailure || new Error("No Gemini model answered the mission.");
  }

  async function run(kind, payload = {}) {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set on this server.");
    const mission = MISSIONS[kind];
    if (!mission) throw new Error("Unknown growth mission.");
    rollDay();
    if (runtime.runsToday >= MAX_RUNS_PER_DAY) {
      throw new Error("Growth agent is capped at " + MAX_RUNS_PER_DAY + " research runs a day. Try again tomorrow.");
    }
    runtime.runsToday += 1;

    let prompt = mission.prompt;
    if (kind === "polish") {
      const platform = String(payload.platform || "").slice(0, 60);
      const draft = String(payload.draft || "").slice(0, 2000);
      if (!draft.trim()) throw new Error("There is no draft to polish.");
      prompt = prompt.replace("{{platform}}", platform).replace("{{draft}}", draft);
      // Voice work, not research: skip the memory block so the rewrite uses
      // only the draft in front of it.
      const out = await callGeminiRaw(prompt);
      const brief = {
        id: Date.now(),
        at: new Date().toISOString(),
        kind,
        label: "Polished post · " + (platform || "post"),
        text: out.text,
        sources: [],
        searchQueries: [],
        ungrounded: false
      };
      briefs.unshift(brief);
      if (briefs.length > BRIEF_LIMIT) briefs.length = BRIEF_LIMIT;
      return brief;
    }

    const out = await callGemini(mission.prompt);
    const brief = {
      id: Date.now(),
      at: new Date().toISOString(),
      kind,
      label: mission.label,
      text: out.text,
      sources: out.sources,
      searchQueries: out.searchQueries,
      ungrounded: !!out.ungrounded
    };
    briefs.unshift(brief);
    if (briefs.length > BRIEF_LIMIT) briefs.length = BRIEF_LIMIT;
    return brief;
  }

  function feed(limit = 10) {
    return {
      ready: !!GEMINI_API_KEY,
      runsToday: runtime.runsToday,
      maxRunsPerDay: MAX_RUNS_PER_DAY,
      lastError: runtime.lastError,
      briefs: briefs.slice(0, Math.max(1, Math.min(limit, BRIEF_LIMIT)))
    };
  }

  return { run, feed, briefs };
}

module.exports = { createGrowthAgent, MISSIONS };
