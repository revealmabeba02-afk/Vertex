// Shared Supabase wiring for every page.
//
// Load order on a page: the supabase-js CDN script, then /config.js (written
// by the server from .env), then this file. It exposes window.Auth.

(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};

  // Why accounts are unavailable, so each page can say the right thing:
  //   "config"     /config.js did not load (server down or unreachable)
  //   "keys"       the server has no valid Supabase keys yet
  //   "library"    the supabase-js script did not load (offline, blocked)
  //   "client"     supabase-js refused the settings
  // Backed by sessionStorage by default — closing the tab/browser clears it
  // and the next visit asks for your details again. If "Remember me" was
  // checked at login (REMEMBER_KEY set in localStorage, which persists
  // across browser restarts on its own), reads/writes go to localStorage
  // instead so the session survives a full restart. The flag has to live in
  // localStorage (not sessionStorage) for this to actually work — it's the
  // one thing that has to outlive the session storage it's switching to.
  const REMEMBER_KEY = "vertex_remember_me";
  function remembering() {
    try {
      return localStorage.getItem(REMEMBER_KEY) === "1";
    } catch {
      return false;
    }
  }
  const dualStorage = {
    getItem(key) {
      try {
        return remembering() ? localStorage.getItem(key) : sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        if (remembering()) {
          localStorage.setItem(key, value);
          sessionStorage.removeItem(key);
        } else {
          sessionStorage.setItem(key, value);
          localStorage.removeItem(key);
        }
      } catch { /* storage unavailable (private mode etc.) */ }
    },
    removeItem(key) {
      try {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      } catch { /* ignore */ }
    }
  };

  let client = null;
  let reason = null;
  if (!window.APP_CONFIG) reason = "config";
  else if (!cfg.ready) reason = "keys";
  else if (!window.supabase) reason = "library";
  else {
    try {
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: dualStorage }
      });
    } catch {
      reason = "client";
    }
  }

  // Text for the setup notice when the cause is not the usual "keys not added
  // yet" case. Returns null for that case: the page keeps its own wording.
  function problemMessage() {
    if (reason === "config") return "Could not load the site settings. Refresh the page and make sure the server is running.";
    if (reason === "library") return "Could not load the sign in tools. Check your internet connection and refresh the page.";
    if (reason === "client") return "Accounts could not start. Check SUPABASE_URL in server/.env and restart.";
    return null;
  }

  // Only same-site relative paths, so ?next= cannot send people off to
  // another domain after they log in.
  function safeNext(value, fallback = "/app") {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
      ? value
      : fallback;
  }

  async function getSession() {
    if (!client) return null;
    try {
      const { data } = await client.auth.getSession();
      return (data && data.session) || null;
    } catch {
      return null;
    }
  }

  // Supabase's own messages are written for developers. Turn the common ones
  // into something a customer understands.
  function friendlyError(error) {
    const msg = (error && error.message) || "";
    if (/invalid login credentials/i.test(msg)) return "Email or password is incorrect.";
    if (/email not confirmed/i.test(msg)) return "Please confirm your email first. The link is in your inbox.";
    if (/already registered|already been registered/i.test(msg)) return "An account with that email already exists. Log in instead.";
    if (/password should be at least/i.test(msg)) return "Password must be at least 8 characters.";
    if (/rate limit|too many/i.test(msg)) return "Too many attempts. Please wait a minute and try again.";
    if (/unable to validate email|invalid email/i.test(msg)) return "Please enter a valid email address.";
    if (/failed to fetch|network/i.test(msg)) return "Could not reach the server. Check your connection and try again.";
    return msg || "Something went wrong. Please try again.";
  }

  // True while a log out is in progress, so a page does not also treat the
  // SIGNED_OUT event as "kicked out" and race the redirect to the home page.
  let signingOut = false;

  // Forget the session in this browser only, without asking the server. Used
  // when the server has already rejected the token.
  async function clearSession() {
    if (!client) return;
    try {
      await client.auth.signOut({ scope: "local" });
    } catch { /* nothing more to do */ }
    try { localStorage.removeItem(REMEMBER_KEY); } catch { /* ignore */ }
  }

  async function signOut() {
    signingOut = true;
    if (client) {
      try {
        const { error } = await client.auth.signOut();
        // If Supabase could not be reached, the session would stay in the
        // browser and the user would look logged in. Clear it locally.
        if (error) await clearSession();
      } catch {
        await clearSession();
      }
    }
    try { localStorage.removeItem(REMEMBER_KEY); } catch { /* ignore */ }
    window.location.href = "/";
  }

  // Call before signInWithPassword so the session Supabase writes during
  // sign-in lands in the right storage from the start — set(true) only
  // changes where things are written, it never moves a session that's
  // already in the other store.
  function setRememberMe(remember) {
    try {
      if (remember) localStorage.setItem(REMEMBER_KEY, "1");
      else localStorage.removeItem(REMEMBER_KEY);
    } catch { /* ignore */ }
  }

  window.Auth = {
    client,
    ready: Boolean(client),
    reason,
    problemMessage,
    getSession,
    safeNext,
    friendlyError,
    signOut,
    clearSession,
    setRememberMe,
    isSigningOut: () => signingOut
  };
})();
