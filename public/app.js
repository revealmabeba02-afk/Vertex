(() => {
  "use strict";

  // --------------------------------------------------------------
  // Account. Logged out visitors go to /login and come back here after.
  // This is only for convenience: the server rejects scans without a valid
  // Supabase token regardless of what this page does.
  // --------------------------------------------------------------
  const Auth = window.Auth;
  const root = document.documentElement;

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
    Auth.client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" && !Auth.isSigningOut()) location.replace("/login?next=/app");
    });
  }

  document.getElementById("logout-btn").addEventListener("click", () => Auth.signOut());

  const form = document.getElementById("scan-form");
  const fileInput = document.getElementById("file-input");
  const dropzone = document.getElementById("dropzone");
  const dropzoneEmpty = document.getElementById("dropzone-empty");
  const dropzonePreview = document.getElementById("dropzone-preview");
  const previewImg = document.getElementById("preview-img");
  const removeFileBtn = document.getElementById("remove-file");
  const timeframeSelect = document.getElementById("timeframe-select");
  const scanBtn = document.getElementById("scan-btn");
  const formError = document.getElementById("form-error");

  const stateEmpty = document.getElementById("state-empty");
  const stateLoading = document.getElementById("state-loading");
  const stateResult = document.getElementById("state-result");
  const stateError = document.getElementById("state-error");
  const errorText = document.getElementById("error-text");
  const retryBtn = document.getElementById("retry-btn");
  const scanAgainBtn = document.getElementById("scan-again-btn");

  const outputPanel = document.getElementById("output");
  const tfRadios = document.querySelectorAll('input[name="tf"]');
  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("status-text");

  const MAX_BYTES = 7 * 1024 * 1024;

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
    how: document.getElementById("view-how")
  };
  const tabs = document.querySelectorAll(".navpill[data-view]");

  function applyView() {
    const name = location.hash === "#how" ? "how" : "scan";
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
  // Header status: a real check against the server, not decoration.
  // --------------------------------------------------------------
  fetch("/api/health")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then(() => { statusEl.dataset.state = "online"; statusText.textContent = "Online"; })
    .catch(() => { statusEl.dataset.state = "offline"; statusText.textContent = "Offline"; });
  let selectedFile = null;

  // --------------------------------------------------------------
  // File selection (click, drag/drop)
  // --------------------------------------------------------------
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) {
      setFile(fileInput.files[0]);
    }
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) setFile(file);
  });

  removeFileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearFile();
    fileInput.click();
  });

  function setFile(file) {
    clearFormError();

    const acceptedTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!acceptedTypes.includes(file.type)) {
      showFormError("Please upload a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      showFormError("Image is too large. Max size is 7MB.");
      return;
    }

    selectedFile = file;
    const url = URL.createObjectURL(file);
    previewImg.src = url;
    dropzoneEmpty.hidden = true;
    dropzonePreview.hidden = false;
  }

  function clearFile() {
    selectedFile = null;
    fileInput.value = "";
    previewImg.src = "";
    dropzoneEmpty.hidden = false;
    dropzonePreview.hidden = true;
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

    if (!selectedFile) {
      showFormError("Please upload a chart screenshot first.");
      return;
    }
    if (!timeframeSelect.value) {
      showFormError("Please select the chart's timeframe.");
      return;
    }

    await runScan(selectedFile, timeframeSelect.value);
  });

  retryBtn.addEventListener("click", () => {
    if (selectedFile && timeframeSelect.value) {
      runScan(selectedFile, timeframeSelect.value);
    } else {
      showState("empty");
    }
  });

  scanAgainBtn.addEventListener("click", () => {
    clearFile();
    clearTimeframe();
    showState("empty");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  async function runScan(file, timeframe) {
    setLoadingUI(true);
    showState("loading");

    const formData = new FormData();
    formData.append("chart", file);
    formData.append("timeframe", timeframe);

    try {
      // Ask for the session at scan time rather than caching it: supabase-js
      // refreshes the access token when it is close to expiring.
      const session = await Auth.getSession();
      const headers = session ? { Authorization: `Bearer ${session.access_token}` } : {};

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers,
        body: formData
      });

      if (res.status === 401) {
        // The server did not accept the token. Drop it here too, otherwise the
        // log in page would see a stored session and send the user straight back.
        await Auth.clearSession();
        location.replace("/login?next=/app");
        return;
      }

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong while analyzing the chart.");
      }

      renderResult(data.analysis, data.timeframe);
      showState("result");
    } catch (err) {
      errorText.textContent = err.message || "Something went wrong. Please try again.";
      showState("error");
    } finally {
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
    "1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "30m": "30 minutes",
    "1H": "1 hour", "4H": "4 hours",
    "1D": "1 day", "1W": "1 week", "1M": "1 month"
  };

  function renderResult(a, timeframe) {
    document.getElementById("res-pair").textContent = a.pair_guess || "Pair unclear";
    document.getElementById("res-tf").textContent = TF_LABELS[timeframe] || timeframe;

    const biasEl = document.getElementById("res-bias");
    biasEl.textContent = a.market_bias || "Neutral / Ranging";
    biasEl.className = "bias-tag " + biasClass(a.market_bias);

    document.getElementById("res-confidence").textContent = a.confidence || "—";

    const structure = a.market_structure || {};
    document.getElementById("res-trend").textContent = structure.trend || "Not enough visible detail to describe trend.";

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
      a.disclaimer || "This is an AI-generated technical read of a chart image, not financial advice. Always confirm with your own analysis and risk management.";
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
