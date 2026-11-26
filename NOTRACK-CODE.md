# Vertex — code shared with NoTrack AI

Stack: vanilla HTML/CSS/JS front end, Node.js + Express server, Supabase (Postgres + auth),
Render hosting, FXSynapse for live chart data, Gemini / OpenCode Go for vision.
All API keys come from environment variables — none are in the code.

---

## 1. Frontend file upload

### Markup (`pages/app.html`)

```html
<input type="file" id="chart-file" accept="image/png,image/jpeg,image/webp" hidden />
<label class="dropzone" id="chart-dropzone" for="chart-file">
  <span class="dropzone__text">Drop your chart screenshot here</span>
  <img id="chart-preview" alt="Selected chart screenshot" />
</label>
```

### Handler (`public/app.js`)

```js
const chartInput = document.getElementById("chart-file");
const chartDropzone = document.getElementById("chart-dropzone");
let chartFile = null;

function setChartFile(file) {
  if (!file) {
    chartFile = null;
    if (chartPreviewUrl) { URL.revokeObjectURL(chartPreviewUrl); chartPreviewUrl = null; }
    if (chartInput) chartInput.value = "";
    if (chartPreviewWrap) chartPreviewWrap.hidden = true;
    updateScanBtnState();
    return;
  }
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    showFormError("Please choose a PNG, JPG or WEBP screenshot.");
    return;
  }
  if (file.size > 7 * 1024 * 1024) {
    showFormError("That image is over 7 MB. Please choose a smaller screenshot.");
    return;
  }

  chartFile = file;
  if (chartPreviewUrl) URL.revokeObjectURL(chartPreviewUrl);
  chartPreviewUrl = URL.createObjectURL(file);
  if (chartPreview) chartPreview.src = chartPreviewUrl;
  if (chartPreviewWrap) chartPreviewWrap.hidden = false;
  clearFormError();
  updateScanBtnState();
}

chartInput.addEventListener("change", () => {
  setChartFile(chartInput.files && chartInput.files[0]);
});

// drag & drop
["dragenter", "dragover"].forEach((name) => {
  chartDropzone.addEventListener(name, (e) => {
    e.preventDefault();
    chartDropzone.classList.add("is-dragover");
  });
});
chartDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  chartDropzone.classList.remove("is-dragover");
  const dropped = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (dropped) setChartFile(dropped);
});
```

### Sending it (`public/app.js`)

```js
async function runScan(symbol, timeframe, imageFile = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

  const session = await Auth.getSession();
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session.access_token}`;

  let res;
  if (imageFile) {
    const body = new FormData();
    body.append("chart", imageFile);
    body.append("timeframe", timeframe);
    res = await fetch("/api/analyze-image", {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
  } else {
    headers["Content-Type"] = "application/json";
    res = await fetch("/api/analyze", {
      method: "POST",
      headers,
      body: JSON.stringify({ symbol, timeframe }),
      signal: controller.signal
    });
  }

  const data = JSON.parse(await res.text());
  if (!res.ok) throw new Error(data.error || "Something went wrong while analyzing the chart.");
  renderResult(data.analysis, data.timeframe);
}
```

---

## 2. Server route + the call to the vision model

### Route (`server/server.js`)

```js
app.post("/api/analyze-image", requireUser, analyzeLimiter, upload.single("chart"), async (req, res) => {
  if (!OPENCODE_GO_API_KEY && !GEMINI_API_KEY && !ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: "Chart-photo reading isn't switched on yet. Add OPENCODE_GO_API_KEY on the server, or pick a pair instead.",
      code: "image_scan_unavailable"
    });
  }

  const timeframe = String(req.body?.timeframe || "").trim().toUpperCase();
  if (!req.file) return res.status(400).json({ error: "Choose a chart screenshot (PNG, JPG or WEBP) first." });
  if (!timeframe || !isValidTimeframe(timeframe)) return res.status(400).json({ error: "Pick a timeframe." });

  // downscale once, before spending a credit
  const prepared = await prepareImage(req.file.buffer, req.file.mimetype);

  // ... credit check via supabaseRpc("use_scan") ...

  const { isChart, analysis } = await analyzeChartImage({
    buffer: prepared.buffer,
    mimeType: prepared.mimeType,
    timeframe,
    apiKey: ANTHROPIC_API_KEY,
    geminiKey: GEMINI_API_KEY
  });

  if (!isChart) {
    await refundIfSpent(req.user, scanSource);
    return res.status(422).json({ error: "That doesn't look like a trading chart.", code: "not_a_chart" });
  }

  res.json({ analysis, timeframe });
});
```

### Provider call (`server/imageAnalysis.js`)

```js
async function analyzeChartImage({ buffer, mimeType, timeframe, apiKey, geminiKey }) {
  const goKey = (process.env.OPENCODE_GO_API_KEY || "").trim();
  const googleKey = String(geminiKey || "").trim();

  if (!goKey && !googleKey && !String(apiKey || "").trim()) {
    const err = new Error("Image analysis is not configured on this server.");
    err.status = 503;
    throw err;
  }

  const shrunk = await shrinkForModel(buffer, mimeType); // max 1400px wide

  let text = null;
  if (goKey) {
    try {
      text = await callOpenCodeGoVision({ buffer: shrunk.buffer, mimeType: shrunk.mimeType, timeframe, apiKey: goKey });
    } catch (err) {
      console.error("OpenCode Go vision failed, falling back:", err.message);
    }
  }
  if (!text && googleKey) {
    text = await callGeminiVision({ buffer: shrunk.buffer, mimeType: shrunk.mimeType, timeframe, apiKey: googleKey });
  }

  const payload = parseJsonObject(text);
  return { isChart: payload.is_chart !== false, analysis: mapImageAnalysis(payload, timeframe) };
}
```

```js
async function callGeminiVision({ buffer, mimeType, timeframe, apiKey }) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: mimeType || "image/png", data: buffer.toString("base64") } },
        { text: buildUserPrompt(String(timeframe || "").toLowerCase()) }
      ]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1600,
      responseMimeType: "application/json"
    }
  });

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000)
    }
  );

  const data = await response.json();
  if (!response.ok) throw visionError("gemini", response.status, data);

  return data.candidates[0].content.parts.map((p) => p.text || "").join("");
}
```

```js
async function callOpenCodeGoVision({ buffer, mimeType, timeframe, apiKey }) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: mimeType || "image/png", data: buffer.toString("base64") } },
        { text: buildUserPrompt(String(timeframe || "").toLowerCase()) }
      ]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1600, responseMimeType: "application/json" }
  });

  const response = await fetch(
    "https://opencode.ai/inference/go/google/v1beta/models/" +
      encodeURIComponent("gemini-4-argon") + ":generateContent",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "x-opencode-session": "vertex-vision-" + Date.now()
      },
      body,
      signal: AbortSignal.timeout(12000)
    }
  );

  const data = await response.json();
  if (!response.ok) throw visionError("opencode-go", response.status, data);
  return data.candidates[0].content.parts.map((p) => p.text || "").join("");
}
```

---

## 3. The prompt (`server/analysisPrompt.js`)

```js
function buildSystemPrompt() {
  return `You are an experienced technical analyst specializing in Forex price action and market structure. You analyze chart screenshots and produce a concise, structured trading analysis.

Rules you must follow:
- Base your analysis ONLY on what is visible in the chart image (candles/bars, price levels, any visible indicators or drawings). Do not assume information that isn't visible.
- Never fabricate exact numeric prices if the chart has no visible price axis or the numbers are unreadable — instead describe levels relatively (e.g. "recent swing high") and say price precision is limited.
- Be explicit about your confidence level and the limitations of analyzing a static screenshot (no live order flow, no confirmation of the current live price, possible lower-timeframe noise, etc.).
- This is technical/educational analysis, NOT financial advice. You must include that disclaimer.
- Respond with ONLY a single valid JSON object, no markdown code fences, no commentary before or after it. The JSON must match this exact shape:

{
  "is_chart": boolean,
  "pair_guess": string | null,
  "timeframe_analyzed": string,
  "market_bias": "Bullish" | "Bearish" | "Neutral / Ranging",
  "confidence": "Low" | "Medium" | "High",
  "market_structure": {
    "trend": string,
    "key_levels": string[],
    "chart_pattern": string | null
  },
  "potential_entries": [
    { "type": "Long" | "Short", "trigger": string, "entry_zone": string, "rationale": string }
  ],
  "stop_loss": { "suggestion": string, "rationale": string },
  "take_profit": [ { "target": string, "rationale": string } ],
  "risk_reward_estimate": string | null,
  "invalidation": string,
  "concepts_detected": {
    "order_blocks": [ { "bias": "bullish" | "bearish", "top_price": number, "bottom_price": number, "note": string } ],
    "liquidity_sweeps": [ { "side": "buy-side" | "sell-side", "price": number, "note": string } ],
    "fvgs": [ { "top_price": number, "bottom_price": number, "filled": boolean, "note": string } ],
    "breaks": [ { "kind": "BOS" | "CHoCH", "direction": "bullish" | "bearish", "price": number, "note": string } ]
  },
  "price_scale": {
    "labels": [ { "price": number, "pct": number } ]
  },
  "notes": string,
  "disclaimer": string
}

If the image is not actually a Forex/trading chart, set "market_bias" to "Neutral / Ranging", leave arrays empty, and explain in "notes" that no valid chart was detected.`;
}

function buildUserPrompt(timeframe) {
  const label = TIMEFRAME_LABELS[timeframe] || timeframe;
  return `The attached screenshot is a Forex chart on the ${label} (${timeframe}) timeframe. Analyze market structure and bias for this timeframe, then propose potential entries, a stop loss, and take profit levels appropriate for trading on this timeframe. Return only the JSON object described in your instructions.`;
}
```

### Notes for the reviewer

- `concepts_detected` is the smart-money layer (order blocks, liquidity sweeps, FVGs, BOS/CHoCH).
- `price_scale` is calibration so the app can draw the levels back onto the user's own screenshot at the right height.
- If the model returns anything that is not valid JSON, the route fails soft and sends the user to the pair scanner instead of showing an error screen.
- Image is downscaled to 1400px before sending; whole vision step has a 12s budget.
