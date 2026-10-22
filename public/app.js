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

  // Maintenance mode: a cheap, fail-open check (any error or non-OK response
  // just lets the app load as normal — this must never be what breaks the
  // site). Runs once on load, not blocking the rest of the page's own auth
  // check below.
  fetch("/api/maintenance")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => { if (data && data.enabled) location.replace("/maintenance"); })
    .catch(() => {});

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
          const settingsEmailEl = document.getElementById("settings-account-email");
          if (settingsEmailEl) settingsEmailEl.textContent = session.user.email || "—";
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
  const settingsLogoutBtn = document.getElementById("settings-logout-btn");
  if (settingsLogoutBtn) settingsLogoutBtn.addEventListener("click", () => Auth.signOut());

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

  const scanHudCheckItems = document.querySelectorAll("#scan-hud-checklist .scan-hud__check");

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
  // Declared up here, ahead of applyView() below, because applyView runs
  // immediately on page load — if someone lands directly on #news (a
  // bookmark, a shared link, or just reopening the app on that tab), the
  // News code that reacts to it (startNewsClock, loadNewsCalendar further
  // down this file) needs these to already exist. Having them declared
  // later in the same scope while something that runs this early reaches
  // for them is a ReferenceError (temporal dead zone), which used to crash
  // before the clock or the free-signals count could ever be filled in —
  // that's why News could get stuck showing "--:--:--" and "—".
  const newsList = document.getElementById("news-list");
  const newsEmpty = document.getElementById("news-empty");
  const newsRemainingValue = document.getElementById("news-remaining-value");
  const newsStatus = document.getElementById("news-status");
  const newsClock = document.getElementById("news-clock");
  let newsLoaded = false;
  let newsClockTimer = null;

  const views = {
    scan: document.getElementById("view-scan"),
    credits: document.getElementById("view-credits"),
    news: document.getElementById("view-news"),
    how: document.getElementById("view-how"),
    history: document.getElementById("view-history"),
    "whats-new": document.getElementById("view-whats-new"),
    help: document.getElementById("view-help"),
    settings: document.getElementById("view-settings")
  };
  const tabs = document.querySelectorAll(".navpill[data-view]");
  const HASH_TO_VIEW = { "#credits": "credits", "#news": "news", "#how": "how", "#history": "history", "#whats-new": "whats-new", "#help": "help", "#settings": "settings" };

  // Each section should feel like turning to its own page, not a tab
  // crossfading on top of the last one. So the old page fully leaves
  // (fades + slides out) before the new page is shown and slides in —
  // sequential, never both visible at once — unless the person has
  // asked their OS for reduced motion, in which case we just swap.
  const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const PAGE_LEAVE_MS = 150;
  // Bumped on every applyView() call. A pending leave-transition timeout
  // only acts if its own token is still the latest one — otherwise a fast
  // double-tap (very normal on mobile) would let a stale timeout finish
  // last and silently override a newer tap, leaving you stuck on the
  // wrong tab. The hash itself (not a locally-held view name) is read when
  // the timeout fires, so it always lands on wherever the user ended up.
  let transitionToken = 0;

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => { el.hidden = key !== name; });
    tabs.forEach((tab) => {
      const active = tab.dataset.view === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    const nextEl = views[name];
    if (nextEl) {
      nextEl.classList.remove("view--leaving");
      nextEl.classList.add("view--entering");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        nextEl.classList.remove("view--entering");
      }));
    }
    window.scrollTo({ top: 0, behavior: "auto" });
    if (name === "history") loadHistory();
    if (name === "whats-new") loadWhatsNew();
    if (name === "credits") refreshBalance();
    if (name === "help") loadHelpHistory();
    if (name === "news") { loadNewsCalendar(); startNewsClock(); }
    if (name === "settings") loadReferral();
  }

  function applyView() {
    const myToken = ++transitionToken;
    const name = HASH_TO_VIEW[location.hash] || "scan";
    const currentEl = Object.values(views).find((el) => el && !el.hidden);
    const nextEl = views[name];

    if (!currentEl || currentEl === nextEl || REDUCED_MOTION) {
      currentEl && currentEl.classList.remove("view--leaving");
      showView(name);
      return;
    }

    // Jump to the top before the fade starts, not after the swap — so a
    // tab tapped while scrolled down doesn't show the old page jumping to
    // the top mid-animation.
    window.scrollTo({ top: 0, behavior: "auto" });
    currentEl.classList.add("view--leaving");
    setTimeout(() => {
      // A later tap has already taken over — let that one finish instead.
      if (myToken !== transitionToken) return;
      currentEl.classList.remove("view--leaving");
      showView(HASH_TO_VIEW[location.hash] || "scan");
    }, PAGE_LEAVE_MS);
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
  // Mobile nav drawer: the sidebar becomes an off-canvas panel below the
  // 760px breakpoint (see style.css), opened by the hamburger in the
  // slim mobile top bar and closed by the backdrop, a nav tap, or Esc.
  // --------------------------------------------------------------
  const MOBILE_NAV_BREAKPOINT = 760;
  const mobileNavBtn = document.getElementById("mobile-nav-btn");
  const mobileNavBackdrop = document.getElementById("mobile-nav-backdrop");
  const isMobileViewport = () => window.innerWidth <= MOBILE_NAV_BREAKPOINT;

  function openMobileNav() {
    root.setAttribute("data-mobile-nav", "open");
    if (mobileNavBtn) mobileNavBtn.setAttribute("aria-expanded", "true");
    if (mobileNavBackdrop) mobileNavBackdrop.hidden = false;
  }
  function closeMobileNav() {
    root.removeAttribute("data-mobile-nav");
    if (mobileNavBtn) mobileNavBtn.setAttribute("aria-expanded", "false");
    if (mobileNavBackdrop) mobileNavBackdrop.hidden = true;
  }

  if (mobileNavBtn) {
    mobileNavBtn.addEventListener("click", () => {
      if (root.getAttribute("data-mobile-nav") === "open") closeMobileNav();
      else openMobileNav();
    });
  }
  if (mobileNavBackdrop) {
    mobileNavBackdrop.addEventListener("click", closeMobileNav);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMobileNav();
  });
  // Tapping any nav link in the drawer should close it behind you.
  document.querySelectorAll(".navpill[data-view]").forEach((tab) => {
    tab.addEventListener("click", () => { if (isMobileViewport()) closeMobileNav(); });
  });
  // Resizing past the breakpoint (e.g. rotating to a tablet landscape)
  // shouldn't leave the drawer stuck open with no backdrop logic to close it.
  window.addEventListener("resize", () => { if (!isMobileViewport()) closeMobileNav(); });

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
    syncQuickpickActive();
  });

  // Quick-pick pills just fill the symbol field — same field, same scan
  // button, nothing special happens server-side.
  const quickpickEl = document.getElementById("quickpick-pairs");
  function syncQuickpickActive() {
    if (!quickpickEl) return;
    const current = symbolInput.value.trim().toUpperCase();
    quickpickEl.querySelectorAll(".quickpick__pill").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.symbol === current);
    });
  }
  if (quickpickEl) {
    quickpickEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".quickpick__pill");
      if (!btn) return;
      symbolInput.value = btn.dataset.symbol;
      clearFormError();
      updateScanBtnState();
      syncQuickpickActive();
      symbolInput.focus();
    });
  }

  function clearForm() {
    symbolInput.value = "";
    clearTimeframe();
    updateScanBtnState();
  }

  // ---- Watchlist: a quick-glance strip of saved pairs, stored per-browser
  // in localStorage (no backend table needed for a convenience list like
  // this). The star on a scan result adds/removes that pair; tapping a
  // watchlist tile drops it straight into the symbol field, same as a
  // quick-pick pill.
  const WATCHLIST_KEY = "vertex_watchlist_v1";

  function loadWatchlist() {
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function saveWatchlist(list) {
    try {
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list.slice(0, 12)));
    } catch {
      // Private browsing / storage disabled — the star just won't persist.
    }
  }

  function isWatchlisted(symbol) {
    if (!symbol) return false;
    return loadWatchlist().includes(symbol.toUpperCase());
  }

  function toggleWatchlist(symbol) {
    if (!symbol) return;
    const sym = symbol.toUpperCase();
    const list = loadWatchlist();
    const idx = list.indexOf(sym);
    if (idx === -1) {
      list.unshift(sym);
    } else {
      list.splice(idx, 1);
    }
    saveWatchlist(list);
    renderWatchlistStrip();
    return idx === -1; // true if it was just added
  }

  const watchlistStripEl = document.getElementById("watchlist-strip");
  const watchlistTilesEl = document.getElementById("watchlist-tiles");

  function renderWatchlistStrip() {
    if (!watchlistStripEl || !watchlistTilesEl) return;
    const list = loadWatchlist();
    if (list.length === 0) {
      watchlistStripEl.hidden = true;
      return;
    }
    watchlistStripEl.hidden = false;
    watchlistTilesEl.innerHTML = "";
    list.forEach((sym) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "watchlist__tile";
      tile.dataset.symbol = sym;

      const label = document.createElement("span");
      label.textContent = sym;
      tile.appendChild(label);

      const remove = document.createElement("span");
      remove.className = "watchlist__tile-remove";
      remove.setAttribute("role", "button");
      remove.setAttribute("aria-label", `Remove ${sym} from watchlist`);
      remove.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleWatchlist(sym);
        if (symbolInput.value.trim().toUpperCase() === sym) syncWatchlistStar();
      });
      tile.appendChild(remove);

      tile.addEventListener("click", () => {
        symbolInput.value = sym;
        clearFormError();
        updateScanBtnState();
        syncQuickpickActive();
        syncWatchlistStar();
        symbolInput.focus();
        symbolInput.scrollIntoView({ behavior: "smooth", block: "center" });
      });

      watchlistTilesEl.appendChild(tile);
    });
  }

  function syncWatchlistStar() {
    const btn = document.getElementById("res-watchlist-btn");
    if (!btn) return;
    const sym = (lastResultForCopy?.a?.pair_guess || "").toUpperCase();
    if (!sym) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.classList.toggle("is-saved", isWatchlisted(sym));
    btn.setAttribute("aria-label", isWatchlisted(sym) ? "Remove from watchlist" : "Add to watchlist");
  }

  const watchlistBtn = document.getElementById("res-watchlist-btn");
  if (watchlistBtn) {
    watchlistBtn.addEventListener("click", () => {
      const sym = (lastResultForCopy?.a?.pair_guess || "").toUpperCase();
      if (!sym) return;
      toggleWatchlist(sym);
      syncWatchlistStar();
    });
  }

  renderWatchlistStrip();

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

  // One-tap "copy trade plan": formats the current scan's bias, entry, stop
  // and targets as plain text ready to paste into MT4/MT5, a broker app, or
  // a chat with whoever's following your calls.
  const copyPlanBtn = document.getElementById("res-copy-plan-btn");
  if (copyPlanBtn) {
    copyPlanBtn.addEventListener("click", async () => {
      if (!lastResultForCopy) return;
      const { a, timeframe } = lastResultForCopy;
      const pair = a.pair_guess ? friendlySymbol(a.pair_guess) : "Symbol unclear";
      const tf = timeframe ? (TF_LABELS[timeframe] || timeframe) : "—";
      const bias = a.market_bias || "Neutral / Ranging";
      const firstEntry = Array.isArray(a.potential_entries) ? a.potential_entries[0] : null;
      const side = (firstEntry?.type || "").toLowerCase();
      const signal = side === "long" ? "BUY" : side === "short" ? "SELL" : "NO TRADE";
      const entryLine = firstEntry?.entry || firstEntry?.zone || "—";
      const sl = a.stop_loss?.suggestion || "—";
      const targets = Array.isArray(a.take_profit) ? a.take_profit : [];
      const tpLine = targets.length > 0 ? targets.map((t) => t.target).join("  ·  ") : "—";

      const lines = [
        `Vertex AI — ${pair} (${tf})`,
        `${signal} — ${bias}`,
        `Entry: ${entryLine}`,
        `Stop loss: ${sl}`,
        `Take profit: ${tpLine}`,
      ];
      if (a.invalidation) lines.push(`Invalidation: ${a.invalidation}`);

      const text = lines.join("\n");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard API can be blocked (older browsers, non-HTTPS); fall back
        // to a hidden textarea + execCommand so the button still works.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch {}
        document.body.removeChild(ta);
      }

      const label = copyPlanBtn.querySelector("span");
      const prevLabel = label.textContent;
      copyPlanBtn.classList.add("is-copied");
      label.textContent = "Copied!";
      setTimeout(() => {
        copyPlanBtn.classList.remove("is-copied");
        label.textContent = prevLabel;
      }, 1800);
    });
  }

  // One-tap "share as image": renders the current plan as a branded card
  // (canvas, drawn client-side — no server round trip) with a QR code back
  // to Vertex, ready to post or share. Uses the Web Share API on mobile
  // (native share sheet) and falls back to a plain download on desktop.
  const shareImageBtn = document.getElementById("res-share-image-btn");
  if (shareImageBtn) {
    shareImageBtn.addEventListener("click", async () => {
      if (!lastResultForCopy) return;
      const label = shareImageBtn.querySelector("span");
      const prevLabel = label.textContent;
      label.textContent = "Building…";
      shareImageBtn.disabled = true;
      try {
        const blob = await buildShareCard(lastResultForCopy);
        const file = new File([blob], "vertex-plan.png", { type: "image/png" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "Vertex trade plan" });
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "vertex-plan.png";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        }
      } catch (err) {
        if (err.name !== "AbortError") console.error("Share card failed:", err);
      } finally {
        label.textContent = prevLabel;
        shareImageBtn.disabled = false;
      }
    });
  }

  function buildShareCard({ a, timeframe }) {
    return new Promise((resolve, reject) => {
      try {
        const W = 1080, H = 1350;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");

        const pair = a.pair_guess ? friendlySymbol(a.pair_guess) : "Vertex scan";
        const tf = timeframe ? (TF_LABELS[timeframe] || timeframe) : "—";
        const firstEntry = Array.isArray(a.potential_entries) ? a.potential_entries[0] : null;
        const side = (firstEntry?.type || "").toLowerCase();
        const isLong = side === "long";
        const signal = side === "long" ? "BUY" : side === "short" ? "SELL" : "NO TRADE";
        const bullColor = "#39D98A";
        const bearColor = "#FF5C7A";
        const signalColor = side === "long" ? bullColor : side === "short" ? bearColor : "#9BB0C9";
        const entryLine = firstEntry?.entry || firstEntry?.zone || "—";
        const sl = a.stop_loss?.suggestion || "—";
        const targets = Array.isArray(a.take_profit) ? a.take_profit : [];
        const tpLine = targets.length > 0 ? targets.map((t) => t.target).join("  ·  ") : "—";
        const confidence = typeof a.confidence === "number" ? a.confidence : null;

        // Background
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, "#0B1118");
        grad.addColorStop(1, "#05080C");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // Brand
        ctx.fillStyle = "#EDF3FA";
        ctx.font = "800 44px 'Inter Tight', sans-serif";
        ctx.fillText("VERTEX", 64, 100);
        ctx.fillStyle = "#6B8299";
        ctx.font = "600 22px 'Inter', sans-serif";
        ctx.fillText("AI chart analysis", 64, 132);

        // Pair + timeframe
        ctx.fillStyle = "#EDF3FA";
        ctx.font = "800 64px 'Inter Tight', sans-serif";
        ctx.fillText(pair, 64, 230);
        ctx.fillStyle = "#9BB0C9";
        ctx.font = "600 28px 'Inter', sans-serif";
        ctx.fillText(tf, 64, 270);

        // Signal badge
        ctx.fillStyle = signalColor;
        ctx.font = "900 120px 'Inter Tight', sans-serif";
        ctx.fillText(signal, 64, 420);

        // Stats block
        const statsY = 520;
        const stats = [
          ["ENTRY", entryLine],
          ["STOP LOSS", sl],
          ["TAKE PROFIT", tpLine]
        ];
        let y = statsY;
        stats.forEach(([lbl, val]) => {
          ctx.fillStyle = "#6B8299";
          ctx.font = "700 24px 'Inter', sans-serif";
          ctx.fillText(lbl, 64, y);
          ctx.fillStyle = "#EDF3FA";
          ctx.font = "700 40px 'IBM Plex Mono', monospace";
          ctx.fillText(String(val), 64, y + 50);
          y += 110;
        });

        if (confidence !== null) {
          ctx.fillStyle = "#6B8299";
          ctx.font = "700 24px 'Inter', sans-serif";
          ctx.fillText("CONFIDENCE", 64, y);
          ctx.fillStyle = "#EDF3FA";
          ctx.font = "700 40px 'IBM Plex Mono', monospace";
          ctx.fillText(confidence + "%", 64, y + 50);
        }

        // Footer + QR
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(64, H - 180);
        ctx.lineTo(W - 64, H - 180);
        ctx.stroke();

        ctx.fillStyle = "#9BB0C9";
        ctx.font = "600 24px 'Inter', sans-serif";
        ctx.fillText("Scanned with Vertex AI", 64, H - 130);
        ctx.fillStyle = "#4A5C70";
        ctx.font = "500 20px 'Inter', sans-serif";
        ctx.fillText("Not financial advice.", 64, H - 95);

        try {
          const qr = qrcode(4, "M");
          qr.addData("https://vertex-9s4c.onrender.com/signup?ref=share");
          qr.make();
          const qrSize = 140;
          const modules = qr.getModuleCount();
          const cell = qrSize / modules;
          const qrX = W - 64 - qrSize;
          const qrY = H - 180 + 20;
          ctx.fillStyle = "#fff";
          ctx.fillRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20);
          ctx.fillStyle = "#05080C";
          for (let row = 0; row < modules; row++) {
            for (let col = 0; col < modules; col++) {
              if (qr.isDark(row, col)) {
                ctx.fillRect(qrX + col * cell, qrY + row * cell, cell, cell);
              }
            }
          }
        } catch (qrErr) {
          console.error("QR render skipped:", qrErr.message);
        }

        canvas.toBlob((blob) => {
          if (blob) resolve(blob); else reject(new Error("Could not render image."));
        }, "image/png");
      } catch (err) {
        reject(err);
      }
    });
  }

  // Steps the loading checklist walks through while a scan is running. There
  // is no real progress signal from the server (a single API call, not a
  // stream), so this is a paced simulation that holds on the last step
  // until the caller marks it done the moment a real response lands —
  // same idea as the old percentage bar, just expressed as checked-off
  // work instead of a number climbing.
  const HUD_STEP_DURATIONS_MS = [1400, 1700, 1500, 2200]; // last one just holds, see below
  let hudTimer = null;

  // Decorative candlestick strip + price line drawn behind the HUD. Purely
  // cosmetic (randomized each run), but an empty <g>/<path> here used to
  // leave the whole background blank except for the gradient glow, so the
  // "scanning" screen looked unfinished. Regenerated every time a scan
  // starts so it never repeats identically.
  function buildHudBackground() {
    const group = document.getElementById("scan-hud-candles");
    const priceLine = document.getElementById("scan-hud-priceline");
    if (!group || !priceLine) return;

    const COUNT = 28;
    const startX = 60;
    const endX = 940;
    const step = (endX - startX) / (COUNT - 1);
    const baseY = 740;
    const topY = 280;

    let prevClose = baseY;
    let markup = "";
    const points = [];

    for (let i = 0; i < COUNT; i++) {
      const t = i / (COUNT - 1);
      const trendTarget = baseY - (baseY - topY) * t;
      const noise = (Math.random() - 0.5) * 46;
      const close = trendTarget + noise;
      const open = prevClose;
      prevClose = close;

      const bodyTop = Math.min(open, close);
      const bodyHeight = Math.max(Math.abs(close - open), 7);
      const wickHigh = bodyTop - (Math.random() * 20 + 6);
      const wickLow = bodyTop + bodyHeight + (Math.random() * 20 + 6);
      const isUp = close <= open; // smaller y = higher price on screen
      const x = startX + step * i;
      const fill = isUp ? "url(#hud-green)" : "#4B5B53";
      const wickColor = isUp ? "#2DAE78" : "#45544C";

      markup += `<line x1="${x.toFixed(1)}" y1="${wickHigh.toFixed(1)}" x2="${x.toFixed(1)}" y2="${wickLow.toFixed(1)}" stroke="${wickColor}" stroke-width="2"/>`;
      markup += `<rect x="${(x - 7.5).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="15" height="${bodyHeight.toFixed(1)}" rx="2.5" fill="${fill}" opacity="0.92"/>`;
      points.push(`${x.toFixed(1)},${close.toFixed(1)}`);
    }

    group.innerHTML = markup;
    priceLine.setAttribute("d", `M ${points[0]} L ${points.slice(1).join(" L ")}`);
  }

  function setHudStep(index, { done = false } = {}) {
    scanHudCheckItems.forEach((item, i) => {
      item.classList.remove("is-active", "is-done");
      if (i < index || (i === index && done)) item.classList.add("is-done");
      else if (i === index) item.classList.add("is-active");
    });
  }

  function startScanHud() {
    buildHudBackground();
    let step = 0;
    setHudStep(step);
    const advance = () => {
      if (step >= scanHudCheckItems.length - 1) return; // hold on the last step
      step += 1;
      setHudStep(step);
      hudTimer = setTimeout(advance, HUD_STEP_DURATIONS_MS[step] || 1800);
    };
    hudTimer = setTimeout(advance, HUD_STEP_DURATIONS_MS[0]);
  }

  function finishScanHud(success) {
    if (hudTimer) {
      clearTimeout(hudTimer);
      hudTimer = null;
    }
    if (success) {
      setHudStep(scanHudCheckItems.length - 1, { done: true });
    }
  }

  // Hard ceiling on how long a scan is allowed to sit on the loading screen.
  // The backend call is a single request/response (no streaming progress),
  // so without this a stalled network or a backend that never replies would
  // leave the HUD spinning forever. 75s comfortably covers a slow vision-model
  // response and a sleepy Render instance waking from idle.
  const SCAN_TIMEOUT_MS = 75000;

  async function runScan(symbol, timeframe) {
    scanInFlight = true;
    setLoadingUI(true);
    if (scanHudBg) scanHudBg.hidden = true;
    showState("loading");
    startScanHud();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

    try {
      // Ask for the session at scan time rather than caching it: supabase-js
      // refreshes the access token when it is close to expiring.
      const session = await Auth.getSession();
      const headers = { "Content-Type": "application/json" };
      if (session) headers.Authorization = `Bearer ${session.access_token}`;

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers,
        body: JSON.stringify({ symbol, timeframe }),
        signal: controller.signal
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
      if (err.name === "AbortError") {
        errorText.textContent = "This scan is taking longer than expected. Please check your connection and try again.";
      } else if (err.code === "no_credits") {
        errorText.innerHTML = "";
        errorText.appendChild(document.createTextNode("You're out of free scans for today and have no credits left. "));
        const link = document.createElement("a");
        link.href = "#credits";
        link.className = "error-link";
        link.textContent = "Buy more credits →";
        errorText.appendChild(link);
      } else if (err.name === "TypeError" && /fetch|network/i.test(err.message || "")) {
        // The browser's raw fetch failure (offline, DNS, no connection) —
        // never surface "Failed to fetch" verbatim.
        errorText.textContent = "Couldn't reach Vertex. Check your internet connection and try again.";
      } else {
        errorText.textContent = err.message || "Something went wrong. Please try again.";
      }
      showState("error");
    } finally {
      clearTimeout(timeoutId);
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
    // body.scanning uses position:fixed to stop the page from scrolling or
    // bouncing behind the HUD on mobile — that removes the page from normal
    // flow, so we save/restore the real scroll position around it to avoid
    // a visible jump when the scan finishes.
    var isLoading = name === "loading";
    var wasLoading = document.body.classList.contains("scanning");
    if (isLoading && !wasLoading) {
      document.body.dataset.scrollLock = String(window.scrollY || window.pageYOffset || 0);
      document.body.style.top = "-" + document.body.dataset.scrollLock + "px";
      document.body.classList.add("scanning");
    } else if (!isLoading && wasLoading) {
      document.body.classList.remove("scanning");
      var y = parseInt(document.body.dataset.scrollLock || "0", 10);
      document.body.style.top = "";
      window.scrollTo(0, y);
    }
    if (name !== "empty" && name !== "loading") {
      outputPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // --------------------------------------------------------------
  // Render
  // --------------------------------------------------------------
  // --------------------------------------------------------------
  // What's new. A hand-maintained list — newest entry first — rather than
  // pulled from git history, so it only ever shows things actually worth
  // telling a user about, in their own words.
  // --------------------------------------------------------------
  const CHANGELOG = [
    { date: "2026-10-23", title: "Full-screen scan HUD", body: "The loading screen while Vertex builds your plan now takes over the whole screen, holds rock-steady on mobile, and shows an AI scan-ring animation instead of the old bouncing candles." },
    { date: "2026-10-23", title: "Risk:reward on every plan", body: "Each trade plan now shows its risk:reward ratio (e.g. 1:2.4) right next to stop loss and take profit." },
    { date: "2026-10-23", title: "Confidence, explained", body: "Tap \"Why this confidence score?\" on any result to see exactly what pushed the score up or down." },
    { date: "2026-10-23", title: "Pin your favorite pairs", body: "Star a pair in History to pin it as a quick-filter chip, plus a new search box to find any past scan fast." },
    { date: "2026-10-22", title: "Redesigned admin command center", body: "A full sidebar rebuild with a system health banner that flags problems automatically — no more digging through logs." },
    { date: "2026-10-22", title: "Q2 got an upgrade", body: "Q2's chat panel now has a whole new look and feel to go with its sharper personality." }
  ];

  async function loadWhatsNew() {
    const wrap = document.getElementById("whats-new-list");
    if (!wrap || wrap.dataset.rendered) return;
    wrap.innerHTML = "";
    CHANGELOG.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "whats-new-item";
      const date = document.createElement("span");
      date.className = "whats-new-item__date";
      try {
        date.textContent = new Date(entry.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
      } catch {
        date.textContent = entry.date;
      }
      const title = document.createElement("h3");
      title.className = "whats-new-item__title";
      title.textContent = entry.title;
      const body = document.createElement("p");
      body.className = "whats-new-item__body";
      body.textContent = entry.body;
      item.appendChild(date);
      item.appendChild(title);
      item.appendChild(body);
      wrap.appendChild(item);
    });
    wrap.dataset.rendered = "1";
  }

  const TF_LABELS = {
    M1: "1 minute", M5: "5 minutes", M15: "15 minutes", M30: "30 minutes",
    H1: "1 hour", H4: "4 hours",
    D1: "1 day", W1: "1 week", MN1: "1 month"
  };

  // Tickers mean nothing to a first-time visitor — pair them with a plain
  // name wherever a symbol is shown back to the user.
  const SYMBOL_NAMES = {
    XAUUSD: "Gold", EURUSD: "Euro / Dollar", GBPUSD: "Pound / Dollar",
    BTCUSD: "Bitcoin", US30: "Dow Jones", NAS100: "Nasdaq 100"
  };
  function friendlySymbol(sym) {
    if (!sym) return sym;
    const name = SYMBOL_NAMES[String(sym).toUpperCase()];
    return name ? `${name} (${sym})` : sym;
  }

  // --------------------------------------------------------------
  // Live candlestick chart. Built on the bars the scan itself read, so it
  // always matches what the analysis below it is talking about — not a
  // separately-polled "live" feed running on its own.
  // --------------------------------------------------------------
  let liveChart = null;
  let liveCandleSeries = null;
  let chartResizeObserver = null;

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function ensureChart(container) {
    if (liveChart) return liveChart;
    const LWC = window.LightweightCharts;
    if (!LWC) return null;

    liveChart = LWC.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: cssVar("--text-faint", "#8A8199"),
        fontFamily: "Inter, sans-serif",
        fontSize: 11
      },
      grid: {
        vertLines: { color: cssVar("--border-soft", "rgba(255,255,255,0.06)") },
        horzLines: { color: cssVar("--border-soft", "rgba(255,255,255,0.06)") }
      },
      rightPriceScale: { borderColor: cssVar("--border-soft", "rgba(255,255,255,0.08)") },
      timeScale: { borderColor: cssVar("--border-soft", "rgba(255,255,255,0.08)"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: LWC.CrosshairMode.Normal }
    });

    liveCandleSeries = liveChart.addCandlestickSeries({
      upColor: cssVar("--bull", "#3FBF8A"),
      downColor: cssVar("--bear", "#E25C63"),
      borderUpColor: cssVar("--bull", "#3FBF8A"),
      borderDownColor: cssVar("--bear", "#E25C63"),
      wickUpColor: cssVar("--bull", "#3FBF8A"),
      wickDownColor: cssVar("--bear", "#E25C63")
    });

    if (!chartResizeObserver && window.ResizeObserver) {
      chartResizeObserver = new ResizeObserver(() => liveChart && liveChart.timeScale().fitContent());
      chartResizeObserver.observe(container);
    }

    return liveChart;
  }

  function priceLine(series, value, color, title) {
    if (typeof value !== "number" || Number.isNaN(value)) return;
    series.createPriceLine({
      price: value,
      color,
      lineWidth: 1,
      lineStyle: window.LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title
    });
  }

  function renderChart(a) {
    const wrap = document.getElementById("res-chart-wrap");
    const candles = Array.isArray(a.candles) ? a.candles : [];

    if (!window.LightweightCharts || candles.length < 2) {
      wrap.hidden = true;
      return;
    }

    const container = document.getElementById("res-chart");
    const chart = ensureChart(container);
    if (!chart) {
      wrap.hidden = true;
      return;
    }

    wrap.hidden = false;
    liveCandleSeries.setData(candles);

    // Clear old price lines by rebuilding the series rather than tracking
    // handles — simplest thing that can't leak stale lines across scans.
    liveChart.removeSeries(liveCandleSeries);
    liveCandleSeries = liveChart.addCandlestickSeries({
      upColor: cssVar("--bull", "#3FBF8A"),
      downColor: cssVar("--bear", "#E25C63"),
      borderUpColor: cssVar("--bull", "#3FBF8A"),
      borderDownColor: cssVar("--bear", "#E25C63"),
      wickUpColor: cssVar("--bull", "#3FBF8A"),
      wickDownColor: cssVar("--bear", "#E25C63")
    });
    liveCandleSeries.setData(candles);

    const firstEntry = Array.isArray(a.potential_entries) ? a.potential_entries[0] : null;
    const firstTarget = Array.isArray(a.take_profit) ? a.take_profit[0] : null;

    priceLine(liveCandleSeries, firstEntry?.entry_raw, cssVar("--accent", "#E0618F"), "Entry");
    priceLine(liveCandleSeries, a.stop_loss?.value_raw, cssVar("--bear", "#E25C63"), "Stop");
    priceLine(liveCandleSeries, firstTarget?.target_raw, cssVar("--bull", "#3FBF8A"), "Target");

    liveChart.timeScale().fitContent();
  }

  let lastResultForCopy = null;

  function renderResult(a, timeframe) {
    lastResultForCopy = { a, timeframe };
    syncWatchlistStar();
    renderChart(a);
    document.getElementById("res-pair").textContent = a.pair_guess ? friendlySymbol(a.pair_guess) : "Symbol unclear";
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
    renderConfidenceBreakdown(Array.isArray(a.confidence_breakdown) ? a.confidence_breakdown : null);

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
    renderTpList(firstEntry, sl, targets);
    document.getElementById("res-invalidation").textContent = a.invalidation || "";

    renderRiskReward(firstEntry, sl, targets);
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

    resetQ3Thread();
    if (q3Enabled) document.getElementById("res-q3-wrap").hidden = false;
  }

  // --------------------------------------------------------------
  // Q3: "Ask about this scan" — explains the result just rendered above,
  // nothing else. Off unless the admin has it switched on, so check once
  // up front and just hide the box entirely when it's off.
  // --------------------------------------------------------------
  let q3Enabled = false;

  function resetQ3Thread() {
    const thread = document.getElementById("q3-thread");
    thread.innerHTML = "";
    thread.hidden = true;
    const status = document.getElementById("q3-ask-status");
    status.hidden = true;
    status.className = "credits-status";
    const input = document.getElementById("q3-ask-input");
    if (input) input.value = "";
  }

  function addQ3Bubble(text, who) {
    const thread = document.getElementById("q3-thread");
    const bubble = document.createElement("div");
    bubble.className = "q3-bubble " + (who === "user" ? "q3-bubble--user" : "q3-bubble--ai");
    bubble.textContent = text;
    thread.appendChild(bubble);
    thread.hidden = false;
  }

  async function checkQ3Status() {
    try {
      const session = await Auth.getSession();
      if (!session) return;
      const r = await fetch("/api/q3/status", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      const data = await r.json();
      q3Enabled = !!(r.ok && data.enabled);
    } catch {
      q3Enabled = false;
    }
  }

  function wireQ3Ask() {
    const form = document.getElementById("q3-ask-form");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("q3-ask-input");
      const btn = document.getElementById("q3-ask-btn");
      const status = document.getElementById("q3-ask-status");
      const question = input.value.trim();
      if (!question || !lastResultForCopy) return;

      addQ3Bubble(question, "user");
      input.value = "";
      btn.disabled = true;
      status.hidden = true;

      try {
        const session = await Auth.getSession();
        if (!session) return toLogin();
        const r = await fetch("/api/q3/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ question, analysis: lastResultForCopy.a })
        });
        const data = await r.json();
        if (!r.ok) {
          status.textContent = data.error || "Couldn't get an answer just now.";
          status.className = "credits-status credits-status--error";
          status.hidden = false;
        } else {
          addQ3Bubble(data.reply, "ai");
        }
      } catch {
        status.textContent = "Could not reach the server.";
        status.className = "credits-status credits-status--error";
        status.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  }

  checkQ3Status();
  wireQ3Ask();

  // Multi-target take profit: each TP level its own row with a per-level R
  // multiple, instead of squashing every target into one joined string.
  // Falls back to the plain target text when raw numbers aren't available.
  function renderTpList(entry, sl, targets) {
    const wrap = document.getElementById("res-tp-list");
    wrap.innerHTML = "";

    if (!targets || targets.length === 0) {
      wrap.textContent = "—";
      return;
    }

    const entryVal = entry && typeof entry.entry_raw === "number" ? entry.entry_raw : null;
    const slVal = sl && typeof sl.value_raw === "number" ? sl.value_raw : null;
    const risk = (entryVal !== null && slVal !== null) ? Math.abs(entryVal - slVal) : null;

    targets.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "tp-list__row";

      const labelEl = document.createElement("span");
      labelEl.className = "tp-list__label";
      labelEl.textContent = targets.length > 1 ? `TP${i + 1}` : "Target";

      const valueEl = document.createElement("span");
      valueEl.className = "tp-list__value";
      valueEl.textContent = t.target || "—";
      row.appendChild(labelEl);
      row.appendChild(valueEl);

      if (risk && risk > 0 && entryVal !== null && typeof t.target_raw === "number") {
        const ratio = Math.abs(t.target_raw - entryVal) / risk;
        if (isFinite(ratio) && ratio > 0) {
          const rEl = document.createElement("span");
          rEl.className = "tp-list__r";
          rEl.textContent = ratio.toFixed(1) + "R";
          row.appendChild(rEl);
        }
      }
      wrap.appendChild(row);
    });
  }

  // Risk:reward ratio — how many R the nearest target is worth relative to
  // the stop distance. Uses the same clean numeric fields (entry_raw,
  // value_raw, target_raw) the trade ladder already relies on, so this only
  // ever shows when we actually have real numbers, never a guess.
  function renderRiskReward(entry, sl, targets) {
    const stat = document.getElementById("res-rr-stat");
    const valueEl = document.getElementById("res-rr-value");

    const entryVal = entry && typeof entry.entry_raw === "number" ? entry.entry_raw : null;
    const slVal = sl && typeof sl.value_raw === "number" ? sl.value_raw : null;
    const targetVals = (targets || [])
      .map((t) => t.target_raw)
      .filter((v) => typeof v === "number");

    if (entryVal === null || slVal === null || targetVals.length === 0) {
      stat.hidden = true;
      return;
    }

    const risk = Math.abs(entryVal - slVal);
    if (risk === 0) {
      stat.hidden = true;
      return;
    }

    // Nearest target to entry is the one actually likely to be hit first —
    // that's the R:R worth showing, not the biggest/furthest one.
    const nearest = targetVals.reduce((closest, t) =>
      Math.abs(t - entryVal) < Math.abs(closest - entryVal) ? t : closest
    , targetVals[0]);
    const reward = Math.abs(nearest - entryVal);
    const ratio = reward / risk;

    if (!isFinite(ratio) || ratio <= 0) {
      stat.hidden = true;
      return;
    }

    valueEl.textContent = "1 : " + ratio.toFixed(1);
    stat.hidden = false;
  }

  // Breaks the confidence % down into the factors that moved it, straight
  // from the server's computeConfidence() reasoning — never invented here.
  function renderConfidenceBreakdown(breakdown) {
    const wrap = document.getElementById("res-confidence-why-wrap");
    const list = document.getElementById("res-confidence-why-list");
    if (!wrap || !list) return;

    if (!breakdown || breakdown.length === 0) {
      wrap.hidden = true;
      return;
    }

    list.innerHTML = "";
    breakdown.forEach((factor) => {
      const li = document.createElement("li");
      const sign = factor.delta > 0 ? "+" : "";
      li.className = "confidence-why__item " +
        (factor.delta > 0 ? "confidence-why__item--up" : factor.delta < 0 ? "confidence-why__item--down" : "");
      li.innerHTML = `<span>${escapeHtmlClient(factor.label)}</span><strong>${factor.delta === 0 ? "—" : sign + factor.delta}</strong>`;
      list.appendChild(li);
    });
    wrap.hidden = false;
  }

  function escapeHtmlClient(str) {
    const div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
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
  const historyNoMatch = document.getElementById("history-no-match");
  const historyList = document.getElementById("history-list");
  const historyPinsWrap = document.getElementById("history-pins");
  const historySearchWrap = document.getElementById("history-search-wrap");
  const historySearchInput = document.getElementById("history-search");
  let historyLoaded = false;
  let historyItems = [];

  // Pinned pairs: a pure per-device convenience (quick-filter chips), not
  // account data worth a migration/table for, so it lives in localStorage.
  // Vertex scans by uploading a chart image rather than picking a pair from
  // a list, so "favorite pairs" means pinning ones you re-scan often to the
  // top of History instead of a pair-picker.
  const PINS_KEY = "vertex_pinned_pairs";
  function getPinnedPairs() {
    try {
      const raw = localStorage.getItem(PINS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function setPinnedPairs(arr) {
    try { localStorage.setItem(PINS_KEY, JSON.stringify(arr)); } catch { /* storage may be unavailable */ }
  }
  function togglePinnedPair(pair) {
    if (!pair) return;
    const pins = getPinnedPairs();
    const idx = pins.indexOf(pair);
    if (idx === -1) pins.push(pair); else pins.splice(idx, 1);
    setPinnedPairs(pins);
    renderPinChips();
    renderHistory(historySearchInput && historySearchInput.value.trim()
      ? historyItems.filter((item) => (item.pair || "").toLowerCase().includes(historySearchInput.value.trim().toLowerCase()))
      : historyItems);
  }

  function renderPinChips() {
    const pins = getPinnedPairs();
    historyPinsWrap.innerHTML = "";
    if (pins.length === 0) {
      historyPinsWrap.hidden = true;
      return;
    }
    historyPinsWrap.hidden = false;
    pins.forEach((pair) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "history-pin-chip";
      chip.textContent = "★ " + pair;
      chip.addEventListener("click", () => {
        if (historySearchInput) {
          historySearchInput.value = pair;
          historySearchInput.dispatchEvent(new Event("input"));
        }
      });
      historyPinsWrap.appendChild(chip);
    });
  }

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
      historyItems = Array.isArray(data.items) ? data.items : [];
      renderPinChips();
      renderHistory(historyItems);
      historyLoaded = true;
    } catch {
      // History is a nice-to-have; a failed fetch just leaves the empty state.
    }
  }

  if (historySearchInput) {
    historySearchInput.addEventListener("input", () => {
      const q = historySearchInput.value.trim().toLowerCase();
      const filtered = q
        ? historyItems.filter((item) => (item.pair || "").toLowerCase().includes(q))
        : historyItems;
      renderHistory(filtered, { isFilter: true });
    });
  }

  function renderHistory(items, opts) {
    const isFilter = !!(opts && opts.isFilter);
    historyList.innerHTML = "";

    // The search box only makes sense once there's something to search —
    // hide it on a genuinely empty history rather than show it for nothing.
    historySearchWrap.hidden = historyItems.length === 0;

    if (historyItems.length === 0) {
      historyEmpty.hidden = false;
      historyNoMatch.hidden = true;
      historyList.hidden = true;
      return;
    }
    historyEmpty.hidden = true;

    if (items.length === 0) {
      historyNoMatch.hidden = !isFilter;
      historyList.hidden = true;
      return;
    }
    historyNoMatch.hidden = true;
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

      if (item.pair) {
        const pinBtn = document.createElement("button");
        pinBtn.type = "button";
        pinBtn.className = "history-pin-btn";
        const isPinned = getPinnedPairs().includes(item.pair);
        pinBtn.classList.toggle("is-pinned", isPinned);
        pinBtn.setAttribute("aria-label", isPinned ? "Unpin " + item.pair : "Pin " + item.pair);
        pinBtn.textContent = "★";
        pinBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          togglePinnedPair(item.pair);
        });
        main.appendChild(pinBtn);
      }

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
      if (freeScansValue) freeScansValue.textContent = freeRemaining === null ? "—" : `${freeRemaining} / 2`;
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

  const feedbackForm = document.getElementById("feedback-form");
  const feedbackMessage = document.getElementById("feedback-message");
  const feedbackStatus = document.getElementById("feedback-status");
  const feedbackSubmitBtn = document.getElementById("feedback-submit-btn");

  if (feedbackForm) {
    feedbackForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = feedbackMessage.value.trim();
      if (!text) return;

      feedbackSubmitBtn.disabled = true;
      feedbackSubmitBtn.classList.add("is-loading");
      feedbackStatus.hidden = true;

      try {
        const session = await Auth.getSession();
        if (!session) return toLogin();
        const res = await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ message: text })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          feedbackStatus.textContent = (data && data.error) || "Could not send your suggestion. Please try again.";
          feedbackStatus.classList.add("credits-status--error");
          feedbackStatus.hidden = false;
          return;
        }
        feedbackMessage.value = "";
        feedbackStatus.textContent = "Thanks — added to the build list.";
        feedbackStatus.classList.remove("credits-status--error");
        feedbackStatus.hidden = false;
      } catch {
        feedbackStatus.textContent = "Could not reach the server. Please try again.";
        feedbackStatus.classList.add("credits-status--error");
        feedbackStatus.hidden = false;
      } finally {
        feedbackSubmitBtn.disabled = false;
        feedbackSubmitBtn.classList.remove("is-loading");
      }
    });
  }
})();
