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
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const ANTHROPIC_MODEL = (
  process.env.GROWTH_ANTHROPIC_MODEL ||
  process.env.SUPPORT_AI_MODEL ||
  "claude-haiku-4-5-20251001"
).trim();
const OPENCODE_GO_API_KEY = (process.env.OPENCODE_GO_API_KEY || "").trim();
const OPENCODE_GO_MODEL = (process.env.OPENCODE_GO_MODEL || "deepseek-v4.1-flash").trim();

const GROWTH_MODEL = (
  process.env.GROWTH_MODEL ||
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash"
).trim();

const GROWTH_MODELS = [
  ...new Set(
    GROWTH_MODEL.split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .concat(["gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest"])
  )
];

const MAX_RUNS_PER_DAY = Number(process.env.GROWTH_MAX_RUNS_PER_DAY) || 15;
const BRIEF_LIMIT = 40;

// What the agent always knows about the company, so briefs are about Vertex
// and not a generic marketing lecture.
const COMPANY_CONTEXT = `
Company: Vertex Chart Scanner (vertex-9s4c.onrender.com).
What it does: scans a forex pair/metal/index and returns bias, market structure, key levels,
entries, stop, targets and invalidation in seconds. Users can also upload a chart screenshot
and get the same read. Free tier: 2 scans/day; paid credit packs, no subscription.
Owner runs everything alone, markets through short-form video.
Handles: TikTok @vertex378, Instagram @verte.x6.
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
  wealth: {
    label: "Wealth niche play",
    // The three biggest money niches are health, wealth and relationships.
    // Vertex lives in wealth, so this mission is about reaching the much
    // larger money-making audience without becoming the thing that audience
    // is right to distrust (gurus, fake screenshots, "get rich" promises).
    prompt: `
Mission: research the WEALTH / money-making niche as it is performing right now (use Google
Search — check what wealth, side-income and financial-freedom creators are posting this week
and what is actually getting views).

Our product is Vertex: a chart scanner for forex traders (2 free scans a day, pay-per-scan,
no subscription, no signal group). It is a tool, not a promise.

Deliver, in plain text with clear section headers:
1. THE AUDIENCE — who consumes wealth content right now: what they want, what they fear, and
   what makes them instantly distrust a finance account. Be specific, with sources.
2. THE HONEST BRIDGE — how a chart-reading tool earns a place in a wealth audience WITHOUT
   looking like a guru pitch. Name the exact positioning sentence to use.
3. 8 HOOKS — hooks performing in wealth content this week, rewritten for Vertex. No profit
   promises, no "I made $10k", no fake screenshots.
4. CONTENT LADDER — a 3-stage funnel: (a) broad wealth hook, (b) the free scan as the proof,
   (c) the paid pack. Give the specific video/post type at each stage and what the CTA is.
5. PLATFORM ANGLES — one concrete play each for TikTok, Instagram and YouTube Shorts.
6. ONE MOVE — the single thing to do this week, first step written out.
      `.trim(),
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
   Lead every post with a result or a number in the first line. Use the LIVE READ block exactly
   as given — never invent a price, confidence or R:R. Keep captions short and spoken.
3. BEST POSTING TIMES — for a South African audience on those platforms.
4. ONE EXPERIMENT — a single thing to try this week that costs nothing.`,
  },
  reach: {
    label: "002 · Daily intel",
    prompt: `
Mission: act as 002, the daily intelligence agent for Vertex Chart Scanner. Your job is to make the owner's idea stronger every day. Use Google Search for current information.

Deliver, in plain text with clear section headers:
1. WHAT FOREX TRADERS NEED TODAY — 3 specific pain points, questions or complaints from retail forex traders this week, with sources. Not generic "they want profits" answers.
2. WHAT IS CHANGING — 3 things changing in trading tools, content or trader behaviour right now, with sources.
3. THE LEVEL-UP — one concrete product/UX improvement Vertex should make next, ranked by impact versus build effort for one developer. Say exactly what to change and why.
4. ONE CONTENT ANGLE — one post or short-video idea that would make a trader stop scrolling, tied to a real Vertex feature.
5. ONE MOVE TODAY — the single highest-leverage action for the owner today, first step written out.

Rules: zero budget, one founder, no fake promises, no financial advice, no feature that needs a new paid vendor. Be direct and useful.`,
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

function fallbackPostsBrief(reason, read) {
  const key = String(read?.key || "XAUUSD:H1");
  const pair = key.split(":")[0] || "XAUUSD";
  const tf = key.split(":")[1] || "H1";
  const bias = read?.bias || "neutral";
  const conf = Number.isFinite(read?.confidence) ? read.confidence : "—";
  const fmt = (v) => Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(5)) : "—";
  const entry = fmt(read?.entry);
  const stop = fmt(read?.stop);
  const target = fmt(read?.target);
  const hasPlan = Number.isFinite(read?.entry) && Number.isFinite(read?.stop) && Number.isFinite(read?.target);
  const levels = hasPlan
    ? `Entry ${entry} · Stop ${stop} · Target ${target}`
    : "No clean entry, stop and target lined up right now.";
  const hook = hasPlan
    ? `${pair} just gave a clean ${String(bias).toLowerCase()} read.`
    : `No clean trade on ${pair} right now.`;
  return {
    id: Date.now(),
    at: new Date().toISOString(),
    kind: "posts",
    label: "Starter posts (AI unavailable)",
    text:
      `AI research is unavailable right now (${reason}). These are ready to post using the latest Watcher read.\n\n` +
      `1. TikTok — “${hook}”\n` +
      `${pair} ${tf} — ${bias}${conf !== "—" ? ` (${conf}% confidence)` : ""}.\n${levels}\nThat's the plan, not a prediction. Two free scans a day.\n\n` +
      `2. TikTok — “The 3-second check before you enter ${pair}.”\n` +
      `1. Bias: ${bias}\n2. Entry: ${entry}\n3. Wrong at: ${stop}\nIf they don't line up, don't click. Two free scans a day.\n\n` +
      `3. Instagram\n` +
      `${hook}\n\n${pair} ${tf} — ${bias}${conf !== "—" ? ` (${conf}% confidence)` : ""}.\n${levels}\n\nTwo free scans a day. No card needed.\n#forex #${pair.toLowerCase()} #trading #priceaction #chartanalysis\n\n` +
      `4. Instagram\n` +
      `One chart. Five numbers. No indicator soup.\n\nBias: ${bias}\n${hasPlan ? `Entry: ${entry}\nStop: ${stop}\nTarget: ${target}` : "No clean setup right now."}\n\nVertex gives you the read in seconds. 2 free scans a day.\n#forex #trading #chartanalysis\n\n` +
      `5. YouTube Shorts\n` +
      `“I scanned ${pair} so you don't have to.”\n${pair} ${tf}: ${bias}${conf !== "—" ? `, ${conf}% confidence` : ""}.\n${levels}\nTwo free scans a day. Link in bio.\n\n` +
      `6. X\n` +
      `${pair} ${tf}: ${bias}${conf !== "—" ? ` (${conf}% confidence)` : ""}\n${levels}\nTool output, not advice. 2 free scans a day.\n\n` +
      `Handles: TikTok @vertex378 · Instagram @verte.x6.\n` +
      `Next: post one, then run the same read again after the session changes.`,
    sources: [],
    searchQueries: [],
    ungrounded: true,
    fallback: true
  };
}

function fallbackReachBrief(reason, read) {
  const key = String(read?.key || "XAUUSD:H1");
  const pair = key.split(":")[0] || "XAUUSD";
  const tf = key.split(":")[1] || "H1";
  const bias = read?.bias || "unclear";
  const live = Number.isFinite(read?.entry)
    ? `${pair} ${tf}: ${bias}. Entry ${read.entry} · Stop ${read.stop ?? "—"} · Target ${read.target ?? "—"}.`
    : `No clean ${pair} ${tf} read right now.`;
  return {
    id: Date.now(),
    at: new Date().toISOString(),
    kind: "reach",
    label: "002 · Daily intel (AI unavailable)",
    text:
      `002 daily intel — AI research is unavailable right now (${reason}). This is the baseline read.\n\n` +
      `1. WHAT FOREX TRADERS NEED TODAY\n` +
      `- A clear verdict, not ten indicators.\n` +
      `- Entry, stop and target they can act on in seconds.\n` +
      `- Honesty when there is no clean trade.\n\n` +
      `2. WHAT IS CHANGING\n` +
      `- Traders are tired of signal groups and fake screenshots.\n` +
      `- Short-form video is still the cheapest discovery channel.\n` +
      `- Tools that show the plan, not just a bias, stand out.\n\n` +
      `3. THE LEVEL-UP\n` +
      `Put the verdict, entry, stop and target above the fold on every result, and keep the deep concepts collapsed. That is the trust gap most tools lose.\n\n` +
      `4. ONE CONTENT ANGLE\n` +
      `"I scanned ${pair} so you don't have to." ${live} Two free scans a day. Not financial advice.\n\n` +
      `5. ONE MOVE TODAY\n` +
      `Post the 15s scanner video with that live read, pin a comment with the free-scan link, and reply to every comment for the first hour.`,
    sources: [],
    searchQueries: [],
    ungrounded: true,
    fallback: true
  };
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
    return callBrain(prompt, { search: false });
  }

  const GROWTH_SYSTEM =
    "You are the growth brain of Vertex Chart Scanner. You research online before answering " +
    "and always ground claims in what you found. You write for one busy founder: concrete, " +
    "short, zero-budget. Plain text only, no markdown tables, no emoji.\n\n" +
    COMPANY_CONTEXT;

  async function callOpenCodeGo(missionPrompt) {
    if (!OPENCODE_GO_API_KEY) throw new Error("No OpenCode Go key configured.");
    const r = await fetch("https://opencode.ai/inference/go/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENCODE_GO_API_KEY,
        "Content-Type": "application/json",
        "x-opencode-session": "vertex-002-" + Date.now()
      },
      body: JSON.stringify({
        model: OPENCODE_GO_MODEL,
        messages: [
          { role: "system", content: GROWTH_SYSTEM },
          { role: "user", content: missionPrompt }
        ],
        max_tokens: 3072,
        temperature: 0.55
      }),
      signal: AbortSignal.timeout(90000)
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      throw new Error(data?.error?.message || `OpenCode Go ${r.status}`);
    }
    const text = data?.choices?.[0]?.message?.content || "";
    if (!text.trim()) throw new Error("OpenCode Go returned an empty brief.");
    return { text: text.trim(), sources: [], searchQueries: [], ungrounded: true, via: "opencode-go" };
  }

  async function callAnthropic(missionPrompt, opts = {}) {
    if (!ANTHROPIC_API_KEY) throw new Error("No Anthropic fallback configured.");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 3072,
        temperature: opts.search === false ? 0.45 : 0.55,
        system: GROWTH_SYSTEM,
        messages: [{ role: "user", content: missionPrompt }]
      }),
      signal: AbortSignal.timeout(90000)
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      throw new Error(data?.error?.message || `Anthropic ${r.status}`);
    }
    const text = Array.isArray(data?.content)
      ? data.content.map((p) => p?.text || "").join("").trim()
      : "";
    if (!text) throw new Error("Anthropic returned an empty brief.");
    return { text, sources: [], searchQueries: [], ungrounded: true, via: "anthropic" };
  }

  async function callGemini(missionPrompt, opts = {}) {
    const body = JSON.stringify({
      systemInstruction: {
        parts: [{ text: GROWTH_SYSTEM }]
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

  async function callBrain(prompt, opts = {}) {
    let lastError = null;
    if (OPENCODE_GO_API_KEY) {
      try {
        return await callOpenCodeGo(prompt);
      } catch (err) {
        lastError = err;
      }
    }
    try {
      return await callGemini(prompt, opts);
    } catch (err) {
      lastError = lastError ? new Error(lastError.message + " · " + err.message) : err;
    }
    if (ANTHROPIC_API_KEY) {
      try {
        return await callAnthropic(prompt, opts);
      } catch (err) {
        lastError = lastError ? new Error(lastError.message + " · " + err.message) : err;
      }
    }
    throw lastError || new Error("No AI brain answered the mission.");
  }

  async function run(kind, payload = {}) {
    if (!OPENCODE_GO_API_KEY && !GEMINI_API_KEY && !ANTHROPIC_API_KEY) throw new Error("No AI key is set on this server.");
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
      try {
        const out = await callGeminiRaw(prompt);
        runtime.lastError = null;
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
      } catch (err) {
        runtime.lastError = err.message || String(err);
        runtime.runsToday = Math.max(0, runtime.runsToday - 1);
        const brief = {
          id: Date.now(),
          at: new Date().toISOString(),
          kind,
          label: "Draft kept · AI unavailable",
          text: draft + "\n\n(AI polish is unavailable right now — your draft was kept as written.)",
          sources: [],
          searchQueries: [],
          ungrounded: true,
          fallback: true
        };
        briefs.unshift(brief);
        if (briefs.length > BRIEF_LIMIT) briefs.length = BRIEF_LIMIT;
        return brief;
      }
    }

    try {
      const liveRead = payload && payload.read && typeof payload.read === "object" ? payload.read : null;
      const liveBlock = liveRead
        ? "\n\nLIVE READ FROM THE WATCHER (use these exact numbers, never invent prices):\n" +
          `Pair: ${liveRead.key || "—"}\nBias: ${liveRead.bias || "—"}\n` +
          `Entry: ${liveRead.entry ?? "—"}\nStop: ${liveRead.stop ?? "—"}\nTarget: ${liveRead.target ?? "—"}\n` +
          `Confidence: ${liveRead.confidence ?? "—"}\nR:R: ${liveRead.rr ?? "—"}`
        : "";
      const out = await callBrain(mission.prompt + liveBlock);
      runtime.lastError = null;
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
    } catch (err) {
      runtime.lastError = err.message || String(err);
      if (kind === "posts") {
        runtime.runsToday = Math.max(0, runtime.runsToday - 1);
        const brief = fallbackPostsBrief(runtime.lastError || "model unavailable", payload && payload.read);
        briefs.unshift(brief);
        if (briefs.length > BRIEF_LIMIT) briefs.length = BRIEF_LIMIT;
        return brief;
      }
      if (kind === "reach") {
        runtime.runsToday = Math.max(0, runtime.runsToday - 1);
        const brief = fallbackReachBrief(runtime.lastError || "model unavailable", payload && payload.read);
        briefs.unshift(brief);
        if (briefs.length > BRIEF_LIMIT) briefs.length = BRIEF_LIMIT;
        return brief;
      }
      throw err;
    }
  }

  function feed(limit = 10) {
    return {
      ready: !!(OPENCODE_GO_API_KEY || GEMINI_API_KEY || ANTHROPIC_API_KEY),
      runsToday: runtime.runsToday,
      maxRunsPerDay: MAX_RUNS_PER_DAY,
      lastError: runtime.lastError,
      briefs: briefs.slice(0, Math.max(1, Math.min(limit, BRIEF_LIMIT)))
    };
  }

  return { run, feed, briefs };
}

module.exports = { createGrowthAgent, MISSIONS };
