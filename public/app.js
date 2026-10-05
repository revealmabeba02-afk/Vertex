(() => {
  "use strict";

  // --------------------------------------------------------------
  // Account. Logged out visitors go to /login and come back here after.
  // This is only for convenience: the server rejects scans without a valid
  // Supabase token regardless of what this page does.
  // --------------------------------------------------------------
  const Auth = window.Auth;
  const root = document.documentElement;

  // True while a scan request is in flight, so a spurious SIGNED_OUT auth
  // event (see onAuthStateChange below) cannot yank the user away from a
  // scan that is actually still running.
  let scanInFlight = false;

  // app.html hides the page (class "auth-check") until the session has been
  // checked, so a logged out visitor never sees the scanner flash up before
  // the redirect. It is revealed here, or by a timeout in app.html.
  const revealPage = () => root.classList.remove("auth-check");
  const toLogin = () => location.replace("/login?next=" + encodeURIComponent("/app" + location.hash));

  if (!Auth.ready) {
    const notice = document.getElementById("setup-notice");
    const message = Auth.problemMessage();
    if (message) notice.textContent = message;
    notice.hidden = false;
    revealPage();
  } else {
    const checkSession = () =>
      Auth.getSession()
        .then((session) => {
          if (!session) return toLogin();
          document.getElementById("account-email").textContent = session.user.email || "";
          document.getElementById("account").hidden = false;
          // Cosmetic only — the real gate is server-side (requireUser +
          // ADMIN_EMAIL check on every /api/admin/* route). This just saves
          // you typing /admin by hand.
          const adminLink = document.getElementById("admin-link");
          if (adminLink && (session.user.email || "").toLowerCase() === "revealmabeba02@gmail.com") {
            adminLink.hidden = false;
          }
          revealPage();
        })
        .catch(toLogin);

    checkSession();

    // Back button after logging out can restore this page from the browser's
    // cache without running any code. Check the session again when it does.
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      root.classList.add("auth-check");
      checkSession();
    });

    // Signed out in another tab, or the session could not be refreshed.
    // Supabase can also fire this itself during a long-running request (its
    // token refresh timer overlapping the scan) — that is not a real sign
    // out, so it must not interrupt a scan that is already in flight. The
    // scan's own 401 handling (in runScan below) is what actually decides
    // whether the session was rejected.
    Auth.client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" && !Auth.isSigningOut() && !scanInFlight) {
        location.replace("/login?next=/app");
      }
    });
  }

  document.getElementById("logout-btn").addEventListener("click", () => Auth.signOut());

  const form = document.getElementById("scan-form");
  const symbolInput = document.getElementById("symbol-input");
  const timeframeSelect = document.getElementById("timeframe-select");
  const scanBtn = document.getElementById("scan-btn");
  const formError = document.getElementById("form-error");
  const scanHudBg = document.getElementById("scan-hud-bg");

  const stateEmpty = document.getElementById("state-empty");
  const stateLoading = document.getElementById("state-loading");
  const stateResult = document.getElementById("state-result");
  const stateError = document.getElementById("state-error");
  const errorText = document.getElementById("error-text");
  const retryBtn = document.getElementById("retry-btn");
  const scanAgainBtn = document.getElementById("scan-again-btn");

  const scanHudStatus = document.getElementById("scan-hud-status");
  const scanHudProgressText = document.getElementById("scan-hud-progress-text");
  const scanHudProgressPct = document.getElementById("scan-hud-progress-pct");
  const scanHudProgressFill = document.getElementById("scan-hud-progress-fill");

  const outputPanel = document.getElementById("output");
  const tfRadios = document.querySelectorAll('input[name="tf"]');
  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("status-text");

  // --------------------------------------------------------------
  // Timeframe chips drive the (visually hidden) select, which is what the
  // submit and retry code reads.
  // --------------------------------------------------------------
  tfRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        timeframeSelect.value = radio.value;
        clearFormError();
        updateScanBtnState();
      }
    });
  });

  function clearTimeframe() {
    timeframeSelect.value = "";
    tfRadios.forEach((r) => { r.checked = false; });
  }

  // --------------------------------------------------------------
  // Tabs. Driven by the URL hash so the back button, refresh and shared
  // links all land on the right view.
  // --------------------------------------------------------------
  const views = {
    scan: document.getElementById("view-scan"),
    credits: document.getElementById("view-credits"),
    news: document.getElementById("view-news"),
    how: document.getElementById("view-how"),
    history: document.getElementById("view-history"),
    help: document.getElementById("view-help"),
    settings: document.getElementById("view-settings")
  };
  const tabs = document.querySelectorAll(".navpill[data-view]");
  const HASH_TO_VIEW = { "#credits": "credits", "#news": "news", "#how": "how", "#history": "history", "#help": "help", "#settings": "settings" };

  function applyView() {
    const name = HASH_TO_VIEW[location.hash] || "scan";
    Object.entries(views).forEach(([key, el]) => { el.hidden = key !== name; });
    tabs.forEach((tab) => {
      const active = tab.dataset.view === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    window.scrollTo({ top: 0, behavior: "auto" });
    if (name === "history") loadHistory();
    if (name === "credits") refreshBalance();
    if (name === "help") loadHelpHistory();
    if (name === "news") { loadNewsCalendar(); startNewsClock(); }
    if (name === "settings") loadReferral();
  }

  window.addEventListener("hashchange", applyView);
  applyView();

  // --------------------------------------------------------------
  // Theme: light/dark. The actual theme is applied before paint by an
  // inline script in app.html (reads localStorage directly) so the page
  // never flashes the wrong mode; this just keeps the switch and storage
  // in sync with it.
  // --------------------------------------------------------------
  const THEME_KEY = "vertex-theme";
  const themeToggle = document.getElementById("theme-toggle");

  function setTheme(mode) {
    if (mode === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    themeToggle.setAttribute("aria-checked", String(mode === "light"));
    try { localStorage.setItem(THEME_KEY, mode); } catch {}
  }

  setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");

  themeToggle.addEventListener("click", () => {
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    setTheme(isLight ? "dark" : "light");
  });

  // --------------------------------------------------------------
  // Accent color: same before-paint pattern as theme (set in app.html's
  // inline script), this just keeps the swatches and storage in sync.
  // --------------------------------------------------------------
  const ACCENT_KEY = "vertex-accent";
  const accentSwatches = document.getElementById("accent-swatches");

  function setAccent(accent) {
    if (accent) {
      document.documentElement.setAttribute("data-accent", accent);
    } else {
      document.documentElement.removeAttribute("data-accent");
    }
    if (accentSwatches) {
      accentSwatches.querySelectorAll(".swatch").forEach((btn) => {
        const match = btn.dataset.accent === accent;
        btn.classList.toggle("is-active", match);
        btn.setAttribute("aria-checked", String(match));
      });
    }
    try { localStorage.setItem(ACCENT_KEY, accent || ""); } catch {}
  }

  if (accentSwatches) {
    setAccent(document.documentElement.getAttribute("data-accent") || "");
    accentSwatches.addEventListener("click", (e) => {
      const btn = e.target.closest(".swatch");
      if (!btn) return;
      setAccent(btn.dataset.accent || "");
    });
  }

  // --------------------------------------------------------------
  // Sidebar collapse: "kick it" open/closed, remembered across visits.
  // --------------------------------------------------------------
  const SIDEBAR_KEY = "vertex-sidebar";
  const sidebarOpenBtn = document.getElementById("sidebar-open-btn");
  const sidebarCloseBtn = document.getElementById("sidebar-close-btn");

  function setSidebar(collapsed) {
    if (collapsed) {
      document.documentElement.setAttribute("data-sidebar", "collapsed");
    } else {
      document.documentElement.removeAttribute("data-sidebar");
    }
    if (sidebarOpenBtn) sidebarOpenBtn.hidden = !collapsed;
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "open"); } catch {}
  }

  if (sidebarOpenBtn) {
    sidebarOpenBtn.hidden = document.documentElement.getAttribute("data-sidebar") !== "collapsed";
    sidebarOpenBtn.addEventListener("click", () => setSidebar(false));
  }
  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener("click", () => setSidebar(true));
  }

  // --------------------------------------------------------------
  // Header status: a real check against the server, not decoration.
  // --------------------------------------------------------------
  fetch("/api/health")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then(() => { statusEl.dataset.state = "online"; statusText.textContent = "Online"; })
    .catch(() => { statusEl.dataset.state = "offline"; statusText.textContent = "Offline"; });

  // --------------------------------------------------------------
  // Symbol input + timeframe chips together decide whether the scan button
  // is enabled — both are required by FXSynapse's API.
  // --------------------------------------------------------------
  function updateScanBtnState() {
    scanBtn.disabled = !(symbolInput.value.trim() && timeframeSelect.value);
  }

  symbolInput.addEventListener("input", () => {
    clearFormError();
    updateScanBtnState();
  });

  function clearForm() {
    symbolInput.value = "";
    clearTimeframe();
    updateScanBtnState();
  }

  function showFormError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
  }

  function clearFormError() {
    formError.hidden = true;
    formError.textContent = "";
  }

  // --------------------------------------------------------------
  // Submit
  // --------------------------------------------------------------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Guards against a double-submit (Enter key + a click landing in the
    // same tick, or a fast double-click before the button visually
    // disables) sending two /api/analyze requests — and so spending two
    // scans — for what the person did once.
    if (scanInFlight) return;
    clearFormError();

    const symbol = symbolInput.value.trim().toUpperCase();
    if (!symbol) {
      showFormError("Enter a pair or symbol first.");
      return;
    }
    if (!timeframeSelect.value) {
      showFormError("Pick a timeframe.");
      return;
    }

    await runScan(symbol, timeframeSelect.value);
  });

  retryBtn.addEventListener("click", () => {
    if (scanInFlight) return;
    const symbol = symbolInput.value.trim().toUpperCase();
    if (symbol && timeframeSelect.value) {
      runScan(symbol, timeframeSelect.value);
    } else {
      showState("empty");
    }
  });

  scanAgainBtn.addEventListener("click", () => {
    clearForm();
    showState("empty");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // Stages the loading HUD cycles through while a scan is running. There is
  // no real progress signal from the server (a single API call, not a
  // stream), so this is a paced simulation: it eases up to ~92% and holds
  // there, then the caller jumps it to 100% the moment a real response
  // lands. Text and percentage change together so the bar never looks
  // stuck on a stale label.
  const HUD_STAGES = [
    { until: 30, status: "Reading price structure…", label: "Mapping market structure" },
    { until: 58, status: "Mapping structure & liquidity…", label: "Scanning liquidity & key levels" },
    { until: 80, status: "Weighing bias and momentum…", label: "Checking bias & momentum" },
    { until: 92, status: "Locating entries and targets…", label: "Building trade zones" }
  ];
  let hudTimer = null;

  function startScanHud() {
    let pct = 0;
    const render = () => {
      const stage = HUD_STAGES.find((s) => pct < s.until) || HUD_STAGES[HUD_STAGES.length - 1];
      scanHudStatus.textContent = stage.status;
      scanHudProgressText.textContent = stage.label;
      scanHudProgressPct.textContent = Math.round(pct) + "%";
      scanHudProgressFill.style.width = pct + "%";
    };
    render();
    hudTimer = setInterval(() => {
      const cap = 92;
      if (pct >= cap) return;
      // Slows down as it approaches the cap so it never visibly stalls.
      pct = Math.min(cap, pct + Math.max(0.6, (cap - pct) * 0.06));
      render();
    }, 110);
  }

  function finishScanHud(success) {
    if (hudTimer) {
      clearInterval(hudTimer);
      hudTimer = null;
    }
    if (success) {
      scanHudProgressPct.textContent = "100%";
      scanHudProgressFill.style.width = "100%";
    }
  }

  async function runScan(symbol, timeframe) {
    scanInFlight = true;
    setLoadingUI(true);
    if (scanHudBg) scanHudBg.hidden = true;
    showState("loading");
    startScanHud();

    try {
      // Ask for the session at scan time rather than caching it: supabase-js
      // refreshes the access token when it is close to expiring.
      const session = await Auth.getSession();
      const headers = { "Content-Type": "application/json" };
      if (session) headers.Authorization = `Bearer ${session.access_token}`;

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers,
        body: JSON.stringify({ symbol, timeframe })
      });

      if (res.status === 401) {
        // The server did not accept the token. Drop it here too, otherwise the
        // log in page would see a stored session and send the user straight back.
        finishScanHud(false);
        await Auth.clearSession();
        location.replace("/login?next=/app");
        return;
      }

      // The server always replies with JSON, but a slow host (waking up from
      // idle, or timing out at the network layer) can hand back a plain-text
      // or HTML error page instead. Read the body as text first so that case
      // produces a readable message instead of a silent parse crash.
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          res.ok
            ? "The server sent back something unexpected. Please try again."
            : `Server error (${res.status}). If the site was just idle, it may still be waking up — please try again in a moment.`
        );
      }

      if (!res.ok) {
        const err = new Error(data.error || "Something went wrong while analyzing the chart.");
        err.code = data.code || null;
        throw err;
      }

      finishScanHud(true);
      historyLoaded = false; // the server just saved this scan; refetch next time History is opened
      renderResult(data.analysis, data.timeframe);
      showState("result");
      if (typeof window.__vertexRefreshCredits === "function") window.__vertexRefreshCredits();
    } catch (err) {
      finishScanHud(false);
      if (err.code === "no_credits") {
        errorText.innerHTML = "";
        errorText.appendChild(document.createTextNode("You're out of free scans for today and have no credits left. "));
        const link = document.createElement("a");
        link.href = "#credits";
        link.className = "error-link";
        link.textContent = "Buy more credits →";
        errorText.appendChild(link);
      } else {
        errorText.textContent = err.message || "Something went wrong. Please try again.";
      }
      showState("error");
    } finally {
      scanInFlight = false;
      setLoadingUI(false);
    }
  }

  function setLoadingUI(isLoading) {
    scanBtn.disabled = isLoading;
    scanBtn.classList.toggle("is-loading", isLoading);
  }

  // The output card sits below the upload form and is not drawn until a scan
  // starts, so bring it into view whenever it changes or it lands off screen.
  function showState(name) {
    stateEmpty.hidden = name !== "empty";
    stateLoading.hidden = name !== "loading";
    stateResult.hidden = name !== "result";
    stateError.hidden = name !== "error";

    outputPanel.classList.toggle("is-idle", name === "empty");
    // Full-screen takeover while a scan is in flight (see .scanning in
    // style.css); dropped the moment it resolves to result or error.
    document.body.classList.toggle("scanning", name === "loading");
    if (name !== "empty" && name !== "loading") {
      outputPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // --------------------------------------------------------------
  // Render
  // --------------------------------------------------------------
  const TF_LABELS = {
    M1: "1 minute", M5: "5 minutes", M15: "15 minutes", M30: "30 minutes",
    H1: "1 hour", H4: "4 hours",
    D1: "1 day", W1: "1 week", MN1: "1 month"
  };

  function renderResult(a, timeframe) {
    document.getElementById("res-pair").textContent = a.pair_guess || "Symbol unclear";
    document.getElementById("res-tf").textContent = timeframe ? (TF_LABELS[timeframe] || timeframe) : "Timeframe not set";

    const biasEl = document.getElementById("res-bias");
    biasEl.textContent = a.market_bias || "Neutral / Ranging";
    biasEl.className = "bias-tag " + biasClass(a.market_bias);

    // The headline call: always a clear verdict, never blank. BUY/SELL when
    // there's an actual directional entry, otherwise an explicit "No trade"
    // badge — so the user is never left guessing why nothing showed up.
    const signalEl = document.getElementById("res-signal");
    const firstEntry = Array.isArray(a.potential_entries) ? a.potential_entries[0] : null;
    const side = (firstEntry?.type || "").toLowerCase();
    if (side === "long" || side === "short") {
      signalEl.textContent = side === "long" ? "Buy" : "Sell";
      signalEl.className = "signal-tag " + (side === "long" ? "signal-tag--buy" : "signal-tag--sell");
    } else {
      signalEl.textContent = "No trade";
      signalEl.className = "signal-tag signal-tag--wait";
    }
    signalEl.hidden = false;

    document.getElementById("res-confidence").textContent = a.bars ? String(a.bars) : "—";

    renderConfidence(typeof a.confidence === "number" ? a.confidence : null);

    const structure = a.market_structure || {};
    document.getElementById("res-trend").textContent = structure.trend || "Not enough data to describe trend.";

    const patternWrap = document.getElementById("res-pattern-wrap");
    if (structure.chart_pattern) {
      document.getElementById("res-pattern").textContent = structure.chart_pattern;
      patternWrap.hidden = false;
    } else {
      patternWrap.hidden = true;
    }

    const levelsEl = document.getElementById("res-levels");
    levelsEl.innerHTML = "";
    const keyLevels = Array.isArray(structure.key_levels) ? structure.key_levels : [];
    keyLevels.forEach((lvl) => {
      const li = document.createElement("li");
      li.textContent = lvl;
      levelsEl.appendChild(li);
    });

    const entriesEl = document.getElementById("res-entries");
    entriesEl.innerHTML = "";
    const entries = Array.isArray(a.potential_entries) ? a.potential_entries : [];
    if (entries.length === 0) {
      entriesEl.innerHTML = '<p class="result-section__body">No clear entry setup identified on this chart.</p>';
    } else {
      entries.forEach((entry) => {
        entriesEl.appendChild(buildEntryCard(entry));
      });
    }

    const sl = a.stop_loss || {};
    const targets = Array.isArray(a.take_profit) ? a.take_profit : [];

    document.getElementById("res-sl-value").textContent = sl.suggestion || "—";
    document.getElementById("res-tp-value").textContent =
      targets.length > 0 ? targets.map((t) => t.target).join("  ·  ") : "No clear target yet";
    document.getElementById("res-rr").textContent = a.risk_reward_estimate || "Not enough information to estimate reliably.";
    document.getElementById("res-invalidation").textContent = a.invalidation || "";

    buildTradeLadder(firstEntry, sl, targets, side);

    const notesWrap = document.getElementById("res-notes-wrap");
    if (a.notes) {
      document.getElementById("res-notes").textContent = a.notes;
      notesWrap.hidden = false;
    } else {
      notesWrap.hidden = true;
    }

    document.getElementById("res-disclaimer").textContent =
      a.disclaimer || "This is a rule-based technical read of live price data, not financial advice. Always confirm with your own analysis and risk management.";

    const topdownWrap = document.getElementById("res-topdown-wrap");
    const topdownEl = document.getElementById("res-topdown");
    topdownEl.innerHTML = "";
    const topdown = Array.isArray(a.top_down) ? a.top_down : [];
    if (topdown.length === 0) {
      topdownWrap.hidden = true;
    } else {
      topdown.forEach((td) => {
        const row = document.createElement("div");
        row.className = "topdown-row";

        const tf = document.createElement("span");
        tf.className = "topdown-row__tf";
        tf.textContent = td.timeframe || "—";

        const bias = document.createElement("span");
        const biasLower = (td.bias || "").toLowerCase();
        bias.className = "topdown-row__bias" +
          (biasLower.includes("bull") ? " topdown-row__bias--bullish"
            : biasLower.includes("bear") ? " topdown-row__bias--bearish" : "");
        bias.textContent = td.bias || "—";

        const zone = document.createElement("span");
        zone.className = "topdown-row__zone";
        zone.textContent = td.zone || "";

        row.appendChild(tf);
        row.appendChild(bias);
        row.appendChild(zone);
        topdownEl.appendChild(row);
      });
      topdownWrap.hidden = false;
    }
  }

  function buildEntryCard(entry) {
    const card = document.createElement("div");
    card.className = "entry-card";

    const head = document.createElement("div");
    head.className = "entry-card__head";

    const type = document.createElement("span");
    const isLong = (entry.type || "").toLowerCase() === "long";
    type.className = "entry-card__type " + (isLong ? "entry-card__type--long" : "entry-card__type--short");
    // Match the Buy/Sell wording used in the headline signal tag, instead of
    // the Long/Short wording FXSynapse's "side" maps to internally.
    type.textContent = isLong ? "BUY" : "SELL";

    const zone = document.createElement("span");
    zone.className = "entry-card__zone";
    zone.textContent = entry.entry_zone || "";

    head.appendChild(type);
    head.appendChild(zone);
    card.appendChild(head);

    // Kept deliberately short: just the signal and the price. The full
    // explanation used to run under here (trigger + rationale paragraphs) —
    // cut per King's call, since the stop loss / take profit / invalidation
    // cards below already carry the detail people actually act on.

    return card;
  }

  // ----------------------------------------------------------------
  // Trade ladder: a horizontal price line plotting stop, entry and
  // target(s) in their real proportions, so the risk and the reward
  // are something you can see, not just read as three separate numbers.
  // ----------------------------------------------------------------
  function buildTradeLadder(entry, sl, targets, side) {
    const wrap = document.getElementById("res-ladder-wrap");
    const track = document.getElementById("res-ladder-track");
    track.innerHTML = "";

    const entryVal = entry && typeof entry.entry_raw === "number" ? entry.entry_raw : null;
    const slVal = sl && typeof sl.value_raw === "number" ? sl.value_raw : null;
    const targetVals = targets
      .map((t) => t.target_raw)
      .filter((v) => typeof v === "number");

    if (entryVal === null || slVal === null) {
      wrap.hidden = true;
      return;
    }

    const isLong = side === "long";
    const values = [slVal, entryVal, ...targetVals];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pct = (v) => ((v - min) / span) * 100;

    // Risk zone: entry back to stop. Reward zone: entry out to the nearest
    // target, when there is one.
    const riskFrom = Math.min(pct(entryVal), pct(slVal));
    const riskTo = Math.max(pct(entryVal), pct(slVal));
    const riskFill = document.createElement("div");
    riskFill.className = "trade-ladder__fill trade-ladder__fill--risk";
    riskFill.style.left = riskFrom + "%";
    riskFill.style.width = (riskTo - riskFrom) + "%";
    track.appendChild(riskFill);

    if (targetVals.length > 0) {
      const nearest = isLong ? Math.min(...targetVals) : Math.max(...targetVals);
      const rewardFrom = Math.min(pct(entryVal), pct(nearest));
      const rewardTo = Math.max(pct(entryVal), pct(nearest));
      const rewardFill = document.createElement("div");
      rewardFill.className = "trade-ladder__fill trade-ladder__fill--reward";
      rewardFill.style.left = rewardFrom + "%";
      rewardFill.style.width = (rewardTo - rewardFrom) + "%";
      track.appendChild(rewardFill);
    }

    function addPoint(value, label, text, modifier) {
      const point = document.createElement("div");
      point.className = "trade-ladder__point trade-ladder__point--" + modifier;
      point.style.left = pct(value) + "%";
      const dot = document.createElement("span");
      dot.className = "trade-ladder__dot";
      const tag = document.createElement("span");
      tag.className = "trade-ladder__tag";
      tag.innerHTML = `<strong>${label}</strong> ${text}`;
      point.appendChild(dot);
      point.appendChild(tag);
      track.appendChild(point);
    }

    addPoint(slVal, "SL", sl.suggestion || fmtRaw(slVal), "sl");
    targetVals.forEach((v, i) => {
      addPoint(v, targets.length > 1 ? `TP${i + 1}` : "TP", targets[i].target || fmtRaw(v), "tp");
    });
    addPoint(entryVal, isLong ? "BUY" : "SELL", entry.entry_zone || fmtRaw(entryVal), "entry");

    wrap.hidden = false;
  }

  function fmtRaw(n) {
    return typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: 5 }) : "—";
  }

  function biasClass(bias) {
    const b = (bias || "").toLowerCase();
    if (b.includes("bull")) return "bias-tag--bullish";
    if (b.includes("bear")) return "bias-tag--bearish";
    return "bias-tag--neutral";
  }

  // --------------------------------------------------------------
  // History. The server saves a row after every successful scan (see
  // runScan's /api/analyze call); this just reads them back.
  // --------------------------------------------------------------
  const historyEmpty = document.getElementById("history-empty");
  const historyList = document.getElementById("history-list");
  let historyLoaded = false;

  async function loadHistory() {
    if (historyLoaded) return;
    try {
      const session = await Auth.getSession();
      if (!session) return;
      const res = await fetch("/api/history", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      renderHistory(Array.isArray(data.items) ? data.items : []);
      historyLoaded = true;
    } catch {
      // History is a nice-to-have; a failed fetch just leaves the empty state.
    }
  }

  function renderHistory(items) {
    historyList.innerHTML = "";
    if (items.length === 0) {
      historyEmpty.hidden = false;
      historyList.hidden = true;
      return;
    }
    historyEmpty.hidden = true;
    historyList.hidden = false;

    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "history-item";

      const main = document.createElement("div");
      main.className = "history-item__main";

      const pair = document.createElement("span");
      pair.className = "history-item__pair";
      pair.textContent = item.pair || "Chart scan";
      main.appendChild(pair);

      if (item.timeframe) {
        const tf = document.createElement("span");
        tf.className = "history-item__tf";
        tf.textContent = TF_LABELS[item.timeframe] || item.timeframe;
        main.appendChild(tf);
      }

      const date = document.createElement("span");
      date.className = "history-item__date";
      try {
        date.textContent = new Date(item.created_at).toLocaleString();
      } catch {
        date.textContent = "";
      }
      main.appendChild(date);

      const right = document.createElement("div");
      right.className = "history-item__right";

      if (item.signal === "buy" || item.signal === "sell") {
        const sig = document.createElement("span");
        sig.className = "signal-tag " + (item.signal === "buy" ? "signal-tag--buy" : "signal-tag--sell");
        sig.textContent = item.signal === "buy" ? "Buy" : "Sell";
        right.appendChild(sig);
      }

      const bias = document.createElement("span");
      bias.className = "bias-tag " + biasClass(item.bias);
      bias.textContent = item.bias || "Neutral";
      right.appendChild(bias);

      row.appendChild(main);
      row.appendChild(right);
      historyList.appendChild(row);
    });
  }

  // --------------------------------------------------------------
  // Credits: balance display, buying a bundle, and the Binance Pay panel
  // that polls until the server's background job detects the payment.
  // --------------------------------------------------------------
  const creditPillText = document.getElementById("credit-pill-text");
  const creditBalanceValue = document.getElementById("credit-balance-value");
  const freeScansValue = document.getElementById("free-scans-value");
  const creditsStatus = document.getElementById("credits-status");
  const bundleGrid = document.getElementById("bundle-grid");
  const payPanel = document.getElementById("pay-panel");
  const payAmount = document.getElementById("pay-amount");
  const payBinanceId = document.getElementById("pay-binance-id");
  const payCopyBtn = document.getElementById("pay-copy-btn");
  const payCancelBtn = document.getElementById("pay-cancel-btn");
  const payWaiting = document.getElementById("pay-waiting");
  const payWaitingText = document.getElementById("pay-waiting-text");
  const payDone = document.getElementById("pay-done");

  let currentBalance = null;
  let orderPollTimer = null;
  let activeOrderId = null;

  function setCreditPill(balance, freeRemaining) {
    if (!creditPillText) return;
    if (balance === null) {
      creditPillText.textContent = "— credits";
    } else if (balance === 0 && freeRemaining > 0) {
      creditPillText.textContent = `${freeRemaining} free scan${freeRemaining === 1 ? "" : "s"} today`;
    } else if (balance === 0) {
      creditPillText.textContent = "0 credits — buy more";
    } else {
      creditPillText.textContent = `${balance} credit${balance === 1 ? "" : "s"}`;
    }
  }

  async function refreshBalance() {
    try {
      const session = await Auth.getSession();
      if (!session) return;
      const res = await fetch("/api/credits/balance", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      currentBalance = typeof data.balance === "number" ? data.balance : null;
      const freeRemaining = typeof data.freeRemaining === "number" ? data.freeRemaining : null;
      setCreditPill(currentBalance, freeRemaining);
      if (creditBalanceValue) creditBalanceValue.textContent = currentBalance === null ? "—" : String(currentBalance);
      if (freeScansValue) freeScansValue.textContent = freeRemaining === null ? "—" : `${freeRemaining} / 4`;
    } catch {
      // Best-effort — leave whatever was last shown.
    }
  }

  // Balance shows up as soon as the page is ready to scan, not just when
  // the Credits tab is opened, so the sidebar pill is accurate right away.
  if (Auth.ready) {
    Auth.getSession().then((session) => {
      if (session) { refreshBalance(); claimStoredReferral(session); }
    });
  }

  // If the person arrived via someone's referral link, signup.html/landing
  // stashed the code in localStorage (claiming needs a session, which
  // didn't exist on those pages yet). Claim it once here, then forget it.
  async function claimStoredReferral(session) {
    let code = null;
    try { code = localStorage.getItem("vertex_ref"); } catch (_) { return; }
    if (!code) return;
    try {
      const res = await fetch("/api/referral/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ code })
      });
      const data = await res.json().catch(() => ({}));
      try { localStorage.removeItem("vertex_ref"); } catch (_) {}
      if (res.ok && data.claimed) refreshBalance();
    } catch (_) {
      // Best-effort — not worth bothering the person about.
    }
  }

  function showCreditsStatus(msg, isError) {
    if (!creditsStatus) return;
    creditsStatus.textContent = msg;
    creditsStatus.hidden = !msg;
    creditsStatus.classList.toggle("credits-status--error", Boolean(isError));
  }

  // Checkout now happens on Whop instead of the old Binance Pay flow below
  // (kept in place but unused — Binance's API blocks Render's server
  // region). Clicking a bundle opens its Whop checkout in a new tab; once
  // paid, Whop's webhook credits the account automatically within about a
  // minute, so we just poll the balance for a bit and tell the user when it
  // lands.
  const WHOP_CHECKOUT_LINKS = {
    quick: "https://whop.com/shadowfx-1eca/quick-5e/",
    starter: "https://whop.com/shadowfx-1eca/starter-20-scans",
    trader: "https://whop.com/shadowfx-1eca/trader-60-scans",
    pro: "https://whop.com/shadowfx-1eca/pro-150-scans"
  };

  if (bundleGrid) {
    bundleGrid.addEventListener("click", (e) => {
      const btn = e.target.closest(".bundle-card__btn");
      if (!btn) return;
      const bundle = btn.dataset.bundle;
      const link = WHOP_CHECKOUT_LINKS[bundle];
      if (!link) return;
      window.open(link, "_blank", "noopener");
      showCreditsStatus(
        "Checkout opened in a new tab. Important: use the same email there as your Vertex login — your credits land here automatically, usually within a minute of paying.",
        false
      );
      startBalanceWatch();
    });
  }

  // "Name your price" — unlike the fixed bundles, this price is only known
  // once typed in, so the server creates a one-off Whop checkout for that
  // exact amount and hands back the link to open.
  const customAmountInput = document.getElementById("custom-amount-input");
  const customAmountBtn = document.getElementById("custom-amount-btn");
  const customAmountHint = document.getElementById("custom-amount-hint");

  if (customAmountBtn) {
    customAmountBtn.addEventListener("click", async () => {
      const amount = Number(customAmountInput?.value);
      if (!Number.isFinite(amount) || amount < 5) {
        if (customAmountHint) customAmountHint.textContent = "Enter at least $5.";
        return;
      }
      customAmountBtn.disabled = true;
      customAmountBtn.textContent = "Starting…";
      if (customAmountHint) customAmountHint.textContent = "";
      try {
        const session = await Auth.getSession();
        if (!session) throw new Error("Please log in first.");
        const res = await fetch("/api/credits/custom-checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`
          },
          body: JSON.stringify({ amount })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Could not start checkout.");
        window.open(data.checkoutUrl, "_blank", "noopener");
        showCreditsStatus(
          `Checkout opened in a new tab for ${data.scans} scans. Use the same email there as your Vertex login — your credits land here automatically, usually within a minute of paying.`,
          false
        );
        startBalanceWatch();
      } catch (err) {
        if (customAmountHint) customAmountHint.textContent = err.message || "Something went wrong. Please try again.";
      } finally {
        customAmountBtn.disabled = false;
        customAmountBtn.textContent = "Get scans";
      }
    });
  }

  // --------------------------------------------------------------
  // News: today's economic calendar, free small/medium events shown in
  // full, big events (NFP/CPI/FOMC) locked until unlocked (2 free/month).
  // --------------------------------------------------------------
  const newsList = document.getElementById("news-list");
  const newsEmpty = document.getElementById("news-empty");
  const newsRemainingValue = document.getElementById("news-remaining-value");
  const newsStatus = document.getElementById("news-status");
  const newsClock = document.getElementById("news-clock");
  let newsLoaded = false;
  let newsClockTimer = null;
  function startNewsClock() {
    if (!newsClock || newsClockTimer) return;
    const tick = () => { newsClock.textContent = new Date().toLocaleTimeString(); };
    tick();
    newsClockTimer = setInterval(tick, 1000);
  }

  function showNewsStatus(msg, isError) {
    if (!newsStatus) return;
    newsStatus.textContent = msg;
    newsStatus.hidden = !msg;
    newsStatus.classList.toggle("credits-status--error", Boolean(isError));
  }

  // Shows the scan's confidence read in two places at once: the small ring
  // badge up by the pair name, and the bigger animated bar down in the
  // trade stats. Both start at 0 and fill in on a frame delay so the CSS
  // transition actually plays instead of snapping straight to the value.
  function renderConfidence(pct) {
    const badge = document.getElementById("res-confidence-badge");
    const ring = document.getElementById("res-confidence-ring");
    const pctLabel = document.getElementById("res-confidence-pct");
    const stat = document.getElementById("res-confidence-stat");
    const value2 = document.getElementById("res-confidence-value2");
    const fill = document.getElementById("res-confidence-fill");
    if (typeof pct !== "number") {
      if (badge) badge.hidden = true;
      if (stat) stat.hidden = true;
      return;
    }
    const clamped = Math.max(0, Math.min(100, pct));
    const circumference = 97.4; // 2 * pi * r(15.5), matches the SVG ring
    if (badge && ring && pctLabel) {
      badge.hidden = false;
      pctLabel.textContent = `${clamped}%`;
      ring.style.strokeDashoffset = String(circumference);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          ring.style.strokeDashoffset = String(circumference - (clamped / 100) * circumference);
        });
      });
    }
    if (stat && value2 && fill) {
      stat.hidden = false;
      value2.textContent = `${clamped}%`;
      fill.style.width = "0%";
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fill.style.width = `${clamped}%`;
        });
      });
    }
  }

  function newsSignalTag(ev) {
    if (!ev.bias || ev.bias === "neutral" || ev.bias === "unclear") return null;
    const tag = document.createElement("span");
    const dir = ev.bias === "bullish" ? "buy" : "sell";
    tag.className = "signal-tag signal-tag--" + dir;
    const ccy = ev.currency ? ev.currency + " " : "";
    tag.textContent = `${ccy}${dir === "buy" ? "BUY" : "SELL"}`;
    return tag;
  }

  function newsEventCard(ev) {
    const card = document.createElement("div");
    card.className = "news-card" + (ev.big ? " news-card--big" : "");
    card.dataset.eventKey = ev.event_key;

    const head = document.createElement("div");
    head.className = "news-card__head";
    const name = document.createElement("p");
    name.className = "news-card__name";
    name.textContent = ev.event_name;
    head.appendChild(name);
    const badge = document.createElement("span");
    badge.className = "news-card__badge news-card__badge--" + String(ev.importance || "").toLowerCase();
    badge.textContent = ev.importance || "—";
    head.appendChild(badge);

    const signalTag = newsSignalTag(ev);
    if (signalTag) head.appendChild(signalTag);

    card.appendChild(head);

    const meta = document.createElement("p");
    meta.className = "news-card__meta";
    const time = ev.date ? new Date(ev.date).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }) : "";
    meta.textContent = [ev.currency, ev.country, time].filter(Boolean).join(" · ");
    card.appendChild(meta);

    const stats = document.createElement("div");
    stats.className = "news-card__stats";
    stats.innerHTML = `
      <div><span>Forecast</span><strong>${ev.forecast ?? "—"}</strong></div>
      <div><span>Previous</span><strong>${ev.previous ?? "—"}</strong></div>
      <div class="news-card__actual"><span>Actual</span><strong>${ev.locked ? "🔒" : ev.actual ?? (ev.released ? "—" : "Not out yet")}</strong></div>
    `;
    card.appendChild(stats);

    if (ev.locked) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scan-btn news-card__unlock";
      btn.textContent = "Unlock signal";
      btn.onclick = () => unlockNewsEvent(ev.event_key, card, btn, false);
      card.appendChild(btn);
    } else if (ev.big && ev.released) {
      const bias = document.createElement("p");
      bias.className = "news-card__bias";
      bias.textContent = ev.note || "";
      card.appendChild(bias);
    }

    return card;
  }

  async function unlockNewsEvent(eventKey, card, btn, pay) {
    btn.disabled = true;
    btn.textContent = pay ? "Paying…" : "Unlocking…";
    try {
      const session = await Auth.getSession();
      if (!session) throw new Error("Please log in first.");
      const res = await fetch("/api/news/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ event_key: eventKey, pay: Boolean(pay) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.code === "no_news_unlocks" && data?.canPay) {
          showNewsStatus(data.error, true);
          btn.disabled = false;
          btn.textContent = `Pay ${data.creditsRequired} credits to unlock`;
          btn.onclick = () => unlockNewsEvent(eventKey, card, btn, true);
          return;
        }
        throw Object.assign(new Error(data?.error || "Could not unlock that signal."), { code: data?.code });
      }
      const fresh = newsEventCard({ ...data.event, note: data.note, bias: data.bias });
      card.replaceWith(fresh);
      if (typeof data.remaining === "number" && newsRemainingValue) newsRemainingValue.textContent = String(data.remaining);
      if (data.paid) {
        showNewsStatus(`Unlocked for ${NEWS_PAID_UNLOCK_CREDITS_LABEL} credits.`, false);
        refreshBalance();
      } else {
        showNewsStatus("", false);
      }
    } catch (err) {
      showNewsStatus(err.message || "Could not unlock that signal.", true);
      btn.disabled = false;
      btn.textContent = "Unlock signal";
    }
  }
  const NEWS_PAID_UNLOCK_CREDITS_LABEL = 2;

  async function loadNewsCalendar(force) {
    if (newsLoaded && !force) return;
    if (!newsList) return;
    try {
      const session = await Auth.getSession();
      if (!session) return;
      const res = await fetch("/api/news/calendar", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Could not load today's news.");
      newsLoaded = true;
      if (newsRemainingValue) newsRemainingValue.textContent = typeof data.freeRemaining === "number" ? String(data.freeRemaining) : "—";
      newsList.querySelectorAll(".news-card").forEach((el) => el.remove());
      const events = Array.isArray(data.events) ? data.events : [];
      if (newsEmpty) newsEmpty.hidden = events.length > 0;
      // Big events first, then by scheduled time.
      events
        .sort((a, b) => (b.big - a.big) || new Date(a.date) - new Date(b.date))
        .forEach((ev) => newsList.appendChild(newsEventCard(ev)));
    } catch (err) {
      showNewsStatus(err.message || "Could not load today's news.", true);
    }
  }

  const referralLinkInput = document.getElementById("referral-link-input");
  const referralCopyBtn = document.getElementById("referral-copy-btn");
  const referralStats = document.getElementById("referral-stats");
  const referralCopyStatus = document.getElementById("referral-copy-status");
  let referralLoaded = false;

  async function loadReferral(force) {
    if (!referralLinkInput) return;
    if (referralLoaded && !force) return;
    try {
      const session = await Auth.getSession();
      if (!session) return;
      const res = await fetch("/api/referral/mine", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Could not load your referral link.");
      referralLoaded = true;
      referralLinkInput.value = data.link;
      if (referralStats) {
        referralStats.textContent = `${data.referredCount || 0} friend${data.referredCount === 1 ? "" : "s"} joined · ${data.paidCount || 0} bought credits · ${data.creditsEarned || 0} credits earned`;
      }
    } catch (err) {
      referralLinkInput.value = "Could not load your link.";
    }
  }

  if (referralCopyBtn) {
    referralCopyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(referralLinkInput.value);
        if (referralCopyStatus) {
          referralCopyStatus.textContent = "Copied!";
          referralCopyStatus.hidden = false;
          setTimeout(() => { referralCopyStatus.hidden = true; }, 2000);
        }
      } catch (_) {
        referralLinkInput.select();
      }
    });
  }

  let balanceWatchTimer = null;
  function startBalanceWatch() {
    const startingBalance = currentBalance;
    if (balanceWatchTimer) clearInterval(balanceWatchTimer);
    let ticks = 0;
    balanceWatchTimer = setInterval(async () => {
      ticks += 1;
      await refreshBalance();
      if (startingBalance !== null && currentBalance !== null && currentBalance > startingBalance) {
        showCreditsStatus(`Credits added! You now have ${currentBalance}.`, false);
        clearInterval(balanceWatchTimer);
        balanceWatchTimer = null;
      } else if (ticks >= 24) {
        // ~2 minutes at 5s intervals — stop polling quietly, balance still
        // refreshes normally elsewhere.
        clearInterval(balanceWatchTimer);
        balanceWatchTimer = null;
      }
    }, 5000);
  }

  function openPayPanel(data) {
    activeOrderId = data.order.id;
    payAmount.textContent = `$${Number(data.order.amount_usd).toFixed(2)}`;
    payBinanceId.textContent = data.payTo.binancePayId;
    payDone.hidden = true;
    payWaiting.hidden = false;
    payWaitingText.textContent = "Waiting for payment — this updates automatically once it's detected.";
    payPanel.hidden = false;
    payPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    startOrderPoll();
  }

  function closePayPanel() {
    payPanel.hidden = true;
    activeOrderId = null;
    stopOrderPoll();
  }

  if (payCancelBtn) payCancelBtn.addEventListener("click", closePayPanel);

  if (payCopyBtn) {
    payCopyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(payBinanceId.textContent || "");
        payCopyBtn.textContent = "Copied!";
        setTimeout(() => { payCopyBtn.textContent = "Copy ID"; }, 1500);
      } catch {
        // Clipboard permission denied or unavailable — the ID is still
        // visible on screen for the user to select manually.
      }
    });
  }

  function startOrderPoll() {
    stopOrderPoll();
    orderPollTimer = setInterval(checkOrderStatus, 5000);
    checkOrderStatus();
  }

  function stopOrderPoll() {
    if (orderPollTimer) {
      clearInterval(orderPollTimer);
      orderPollTimer = null;
    }
  }

  async function checkOrderStatus() {
    if (!activeOrderId) return;
    try {
      const session = await Auth.getSession();
      if (!session) return;
      const res = await fetch("/api/credits/orders", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      const order = (data.orders || []).find((o) => o.id === activeOrderId);
      if (order && order.status === "paid") {
        stopOrderPoll();
        payWaiting.hidden = true;
        payDone.hidden = false;
        refreshBalance();
        setTimeout(closePayPanel, 3000);
      }
    } catch {
      // Keep polling — a single failed check is not worth surfacing.
    }
  }

  window.__vertexRefreshCredits = refreshBalance;

  // --------------------------------------------------------------
  // Help / support form.
  // --------------------------------------------------------------
  const helpForm = document.getElementById("help-form");
  const helpMessage = document.getElementById("help-message");
  const helpStatus = document.getElementById("help-status");
  const helpSubmitBtn = document.getElementById("help-submit-btn");

  if (helpForm) {
    helpForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = helpMessage.value.trim();
      if (!text) return;

      helpSubmitBtn.disabled = true;
      helpSubmitBtn.classList.add("is-loading");
      helpStatus.hidden = true;

      try {
        const session = await Auth.getSession();
        if (!session) return toLogin();
        const res = await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ message: text })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          helpStatus.textContent = (data && data.error) || "Could not send your message. Please try again.";
          helpStatus.classList.add("credits-status--error");
          helpStatus.hidden = false;
          return;
        }
        helpMessage.value = "";
        helpStatus.textContent = "Sent — thanks, we'll get back to you.";
        helpStatus.classList.remove("credits-status--error");
        helpStatus.hidden = false;
        // A fast confident AI reply can land within a couple seconds, so
        // check back shortly, then again a bit later in case it takes longer.
        setTimeout(loadHelpHistory, 2500);
        setTimeout(loadHelpHistory, 8000);
      } catch {
        helpStatus.textContent = "Could not reach the server. Please try again.";
        helpStatus.classList.add("credits-status--error");
        helpStatus.hidden = false;
      } finally {
        helpSubmitBtn.disabled = false;
        helpSubmitBtn.classList.remove("is-loading");
      }
    });
  }

  const helpHistoryWrap = document.getElementById("help-history");
  const helpHistoryList = document.getElementById("help-history-list");

  async function loadHelpHistory() {
    if (!helpHistoryWrap) return;
    try {
      const session = await Auth.getSession();
      if (!session) return;
      const res = await fetch("/api/support/mine", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      if (messages.length === 0) {
        helpHistoryWrap.hidden = true;
        return;
      }
      helpHistoryWrap.hidden = false;
      helpHistoryList.innerHTML = "";
      messages.forEach((m) => {
        const item = document.createElement("div");
        item.className = "help-item";
        let when = "";
        try { when = new Date(m.created_at).toLocaleString(); } catch {}
        const tagClass = m.status === "resolved" ? "help-item__tag--resolved" : "help-item__tag--open";
        const tagText = m.status === "resolved" ? "Answered" : "Open";
        item.innerHTML = `
          <div class="help-item__meta">
            <span class="help-item__tag ${tagClass}">${tagText}</span>
            <span>${when}</span>
          </div>
          <div class="help-item__text"></div>
        `;
        item.querySelector(".help-item__text").textContent = m.message;
        if (m.reply) {
          const replyEl = document.createElement("div");
          replyEl.className = "help-item__reply";
          replyEl.innerHTML = '<span class="help-item__reply-label">Reply</span>';
          const replyText = document.createElement("span");
          replyText.textContent = m.reply;
          replyEl.appendChild(replyText);
          item.appendChild(replyEl);
        }
        helpHistoryList.appendChild(item);
      });
    } catch {
      // Best-effort — leave whatever was last shown.
    }
  }
})();
