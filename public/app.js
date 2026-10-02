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
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const dropzoneEmpty = document.getElementById("dropzone-empty");
  const dropzonePreview = document.getElementById("dropzone-preview");
  const previewImg = document.getElementById("preview-img");
  const removeFileBtn = document.getElementById("remove-file");
  const timeframeSelect = document.getElementById("timeframe-select");
  const scanBtn = document.getElementById("scan-btn");
  const formError = document.getElementById("form-error");
  const scanHudBg = document.getElementById("scan-hud-bg");

  const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const MAX_BYTES = 7 * 1024 * 1024;
  let currentFile = null;
  let currentPreviewUrl = null;

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
    how: document.getElementById("view-how"),
    settings: document.getElementById("view-settings")
  };
  const tabs = document.querySelectorAll(".navpill[data-view]");

  function applyView() {
    const name = location.hash === "#how" ? "how" : location.hash === "#settings" ? "settings" : "scan";
    Object.entries(views).forEach(([key, el]) => { el.hidden = key !== name; });
    tabs.forEach((tab) => {
      const active = tab.dataset.view === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    window.scrollTo({ top: 0, behavior: "auto" });
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
  // Header status: a real check against the server, not decoration.
  // --------------------------------------------------------------
  fetch("/api/health")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then(() => { statusEl.dataset.state = "online"; statusText.textContent = "Online"; })
    .catch(() => { statusEl.dataset.state = "offline"; statusText.textContent = "Offline"; });

  // --------------------------------------------------------------
  // Dropzone: click to choose, drag & drop, preview, remove.
  // --------------------------------------------------------------
  function setFile(file) {
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      showFormError("Please use a PNG, JPG or WEBP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      showFormError("That image is too large. Keep it under 7MB.");
      return;
    }
    clearFormError();
    currentFile = file;

    if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = URL.createObjectURL(file);
    previewImg.src = currentPreviewUrl;

    dropzoneEmpty.hidden = true;
    dropzonePreview.hidden = false;
    scanBtn.disabled = false;
  }

  function clearFile() {
    currentFile = null;
    if (currentPreviewUrl) {
      URL.revokeObjectURL(currentPreviewUrl);
      currentPreviewUrl = null;
    }
    previewImg.src = "";
    fileInput.value = "";
    dropzoneEmpty.hidden = false;
    dropzonePreview.hidden = true;
    scanBtn.disabled = true;
  }

  dropzone.addEventListener("click", () => {
    if (!currentFile) fileInput.click();
  });
  dropzone.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !currentFile) {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) setFile(fileInput.files[0]);
  });
  removeFileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearFile();
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "dragend"].forEach((evt) => {
    dropzone.addEventListener(evt, () => dropzone.classList.remove("is-dragover"));
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-dragover");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) setFile(file);
  });

  function clearForm() {
    clearFile();
    clearTimeframe();
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
    clearFormError();

    if (!currentFile) {
      showFormError("Upload a chart screenshot first.");
      return;
    }

    await runScan(currentFile, timeframeSelect.value);
  });

  retryBtn.addEventListener("click", () => {
    if (currentFile) {
      runScan(currentFile, timeframeSelect.value);
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

  async function runScan(file, timeframe) {
    scanInFlight = true;
    setLoadingUI(true);
    if (scanHudBg) scanHudBg.src = currentPreviewUrl || "";
    showState("loading");
    startScanHud();

    try {
      // Ask for the session at scan time rather than caching it: supabase-js
      // refreshes the access token when it is close to expiring.
      const session = await Auth.getSession();
      const headers = {};
      if (session) headers.Authorization = `Bearer ${session.access_token}`;

      const body = new FormData();
      body.append("image", file);
      if (timeframe) body.append("timeframe", timeframe);

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers,
        body
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
        throw new Error(data.error || "Something went wrong while analyzing the chart.");
      }

      finishScanHud(true);
      renderResult(data.analysis, data.timeframe);
      showState("result");
    } catch (err) {
      finishScanHud(false);
      errorText.textContent = err.message || "Something went wrong. Please try again.";
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
    if (name !== "empty") {
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

    document.getElementById("res-confidence").textContent = a.bars ? String(a.bars) : "—";

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
    document.getElementById("res-sl-value").textContent = sl.suggestion || "Not specified";
    document.getElementById("res-sl-rationale").textContent = sl.rationale || "";

    const tpListEl = document.getElementById("res-tp-list");
    tpListEl.innerHTML = "";
    const targets = Array.isArray(a.take_profit) ? a.take_profit : [];
    if (targets.length === 0) {
      tpListEl.innerHTML = '<p class="result-section__body">No clear target identified.</p>';
    } else {
      targets.forEach((tp) => {
        const div = document.createElement("div");
        div.className = "tp-item";
        const line = document.createElement("p");
        line.className = "levelline levelline--tp";
        line.textContent = tp.target || "—";
        const rationale = document.createElement("p");
        rationale.className = "result-section__body";
        rationale.textContent = tp.rationale || "";
        div.appendChild(line);
        div.appendChild(rationale);
        tpListEl.appendChild(div);
      });
    }

    document.getElementById("res-rr").textContent = a.risk_reward_estimate || "Not enough information to estimate reliably.";
    document.getElementById("res-invalidation").textContent = a.invalidation || "—";

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
    type.textContent = entry.type || "—";

    const zone = document.createElement("span");
    zone.className = "entry-card__zone";
    zone.textContent = entry.entry_zone || "";

    head.appendChild(type);
    head.appendChild(zone);
    card.appendChild(head);

    if (entry.trigger) {
      const trigLabel = document.createElement("div");
      trigLabel.className = "entry-card__label";
      trigLabel.textContent = "TRIGGER";
      const trig = document.createElement("p");
      trig.className = "entry-card__trigger";
      trig.textContent = entry.trigger;
      card.appendChild(trigLabel);
      card.appendChild(trig);
    }

    if (entry.rationale) {
      const rationale = document.createElement("p");
      rationale.className = "entry-card__rationale";
      rationale.textContent = entry.rationale;
      card.appendChild(rationale);
    }

    return card;
  }

  function biasClass(bias) {
    const b = (bias || "").toLowerCase();
    if (b.includes("bull")) return "bias-tag--bullish";
    if (b.includes("bear")) return "bias-tag--bearish";
    return "bias-tag--neutral";
  }
})();
