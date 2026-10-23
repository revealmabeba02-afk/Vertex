// Minimal service worker — exists only so the browser considers Vertex an
// installable PWA (Add to Home Screen). It deliberately does NOT cache
// anything: every request still goes straight to the network. We already
// got burned once by stale cached app.js/style.css on mobile Safari (see
// the Cache-Control fix in server.js), so this stays a pass-through rather
// than adding another caching layer to get wrong.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // No-op: let the request go to the network as normal.
});
