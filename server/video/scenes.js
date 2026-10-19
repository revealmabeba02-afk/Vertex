// Builds the SVG overlay for each scene of a trade-recap video. Pure string
// templates — no rendering here. generateTradeVideo.js rasterizes these with
// sharp and composites them onto a 1080x1920 (vertical, Reels/Shorts/TikTok
// sized) background.

function escapeXml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

const W = 1080;
const H = 1920;

// Scene 1: a few seconds of just the pair + direction, big and bold, to hook
// the first second of a scroll.
function introSvg({ pair, direction }) {
  const isBuy = String(direction || "").toUpperCase() === "BUY";
  const dirColor = isBuy ? "#3ddc84" : "#ff4d6d";
  const dirLabel = isBuy ? "BUY" : "SELL";
  return `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg" cx="50%" cy="35%" r="75%">
        <stop offset="0%" stop-color="#171225"/>
        <stop offset="100%" stop-color="#07050c"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <text x="50%" y="620" text-anchor="middle" font-family="Arial, sans-serif" font-size="46" font-weight="700" letter-spacing="10" fill="#8b7fb0">VERTEX SIGNAL</text>
    <text x="50%" y="800" text-anchor="middle" font-family="Arial, sans-serif" font-size="130" font-weight="800" fill="#ffffff">${escapeXml(pair)}</text>
    <rect x="${W / 2 - 220}" y="870" width="440" height="140" rx="26" fill="${dirColor}"/>
    <text x="50%" y="965" text-anchor="middle" font-family="Arial, sans-serif" font-size="80" font-weight="800" fill="#0a0d12">${dirLabel}</text>
  </svg>`;
}

// Scene 2: the chart screenshot (composited in separately, this is just the
// overlay) with a stats panel pinned to the bottom third.
function statsOverlaySvg({ entry, sl, tp, confidence }) {
  const rows = [
    ["ENTRY", entry],
    ["STOP LOSS", sl],
    ["TAKE PROFIT", tp],
    confidence != null ? ["CONFIDENCE", `${confidence}%`] : null
  ].filter(Boolean);
  const rowH = 96;
  const panelH = 80 + rows.length * rowH;
  const panelY = H - panelH - 90;
  const rowsSvg = rows
    .map(([label, value], i) => {
      const y = panelY + 70 + i * rowH;
      return `
      <text x="80" y="${y}" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#9aa3b5" letter-spacing="2">${escapeXml(label)}</text>
      <text x="${W - 80}" y="${y}" text-anchor="end" font-family="Arial, sans-serif" font-size="44" font-weight="800" fill="#ffffff">${escapeXml(value)}</text>`;
    })
    .join("");
  return `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#07050c" stop-opacity="0"/>
        <stop offset="100%" stop-color="#07050c" stop-opacity="0.95"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${panelY - 220}" width="${W}" height="${H - panelY + 220}" fill="url(#fade)"/>
    <rect x="48" y="${panelY}" width="${W - 96}" height="${panelH}" rx="28" fill="#121018" fill-opacity="0.88" stroke="#2b2438" stroke-width="2"/>
    ${rowsSvg}
  </svg>`;
}

// Scene 3: outro / follow call-to-action.
function outroSvg({ handle }) {
  return `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg2" cx="50%" cy="50%" r="75%">
        <stop offset="0%" stop-color="#171225"/>
        <stop offset="100%" stop-color="#07050c"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg2)"/>
    <text x="50%" y="880" text-anchor="middle" font-family="Arial, sans-serif" font-size="70" font-weight="800" fill="#ffffff">Not financial advice.</text>
    <text x="50%" y="970" text-anchor="middle" font-family="Arial, sans-serif" font-size="70" font-weight="800" fill="#ffffff">Trade your own plan.</text>
    <text x="50%" y="1160" text-anchor="middle" font-family="Arial, sans-serif" font-size="54" font-weight="700" fill="#3ddc84">Follow ${escapeXml(handle || "@VertexScanner")}</text>
    <text x="50%" y="1230" text-anchor="middle" font-family="Arial, sans-serif" font-size="40" font-weight="500" fill="#9aa3b5">for daily signals</text>
  </svg>`;
}

module.exports = { W, H, introSvg, statsOverlaySvg, outroSvg };
