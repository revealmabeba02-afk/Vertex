// Small helpers shared by the log in and sign up pages.

(() => {
  "use strict";

  const alertEl = document.getElementById("form-alert");
  const submitBtn = document.getElementById("submit-btn");

  // Show / hide password buttons.
  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    const input = document.getElementById(btn.dataset.toggle);
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  });

  // Clear an input's error state as soon as the user edits it.
  document.querySelectorAll(".input").forEach((input) => {
    input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
  });

  window.AuthPage = {
    showError(message, input) {
      alertEl.textContent = message;
      alertEl.hidden = false;
      if (input) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    },

    clearError() {
      alertEl.hidden = true;
      alertEl.textContent = "";
    },

    setBusy(busy) {
      submitBtn.disabled = busy;
      submitBtn.classList.toggle("is-loading", busy);
    },

    // Without Supabase keys the forms cannot work, so say why and disable them
    // rather than letting someone type a password into a dead form.
    guardSetup() {
      if (window.Auth.ready) return true;
      const notice = document.getElementById("setup-alert");
      const message = window.Auth.problemMessage();
      if (message) notice.textContent = message;
      notice.hidden = false;
      document.querySelectorAll("form input, form button").forEach((el) => { el.disabled = true; });
      return false;
    }
  };
})();
