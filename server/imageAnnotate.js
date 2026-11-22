// Draws the smart-money concepts the vision model detected directly onto the
// uploaded chart screenshot, so the result card can show the trader's own
// image marked up — order blocks and FVGs as shaded zones, liquidity sweeps
// and BOS/CHoCH breaks as labelled lines — instead of only listing them as
// text.
//
// The model reports the concepts as PRICES plus a calibration of the chart's
// visible price axis (highest/lowest axis label and where each sits
// vertically). Mapping price -> height here is far more reliable than asking a
// vision model for pixel positions directly. Zones span most of the chart
// width, which is how SMC traders draw them anyway.
//
// Labels live in a rail added to the right edge of the image, never on top of
// the candles. The first version printed white-on-dark text plates over the
// chart itself: at phone width they collided with candles, covered the price
// axis and had to be truncated ("zone near swing h…"). A dedicated rail keeps
// the chart clean, gives every label a full line with its price, and stays
// legible when the image is zoomed or shared.
//
// Purely additive: every call is best-effort and returns null if anything is
// missing or malformed, and the caller falls back to the unmarked image.

const sharp = require("sharp");

const PALETTE = {
  order_block: { stroke: "#b388ff", fill: "rgba(179,136,255,0.16)" },
  fvg: { stroke: "#ffc46b", fill: "rgba(255,196,107,0.13)" },
  sweep: { stroke: "#ff8a9b", fill: "rgba(255,138,155,0.10)" },
  break: { stroke: "#4dd4c1", fill: "rgba(77,212,193,0.10)" },
  entry: { stroke: "#5ee6a8" },
  stop: { stroke: "#ff6b81" },
  target: { stroke: "#6cb8ff" },
  level: { stroke: "#8f98a8" }
};

const PLAN_DASH = { entry: "", stop: "6 4", target: "4 5", level: "2 5" };

// A marked-up copy is sent back to the browser as base64, so a 4000px phone
// screenshot would bloat the response. 1800px keeps labels and candles crisp
// while keeping the payload small enough to load quickly on mobile data.
const MAX_ANNOTATE_WIDTH = 1800;

// The label rail. Proportional so it scales with the screenshot, clamped so it
// never eats the chart on a small image or becomes a billboard on a huge one.
const RAIL_FRAC = 0.24;
const RAIL_MIN = 230;
const RAIL_MAX = 520;

// More than this and the rail turns into a wall of text; the unmarked lists
// below the image still carry every concept the model found.
const MAX_LABELS = 14;

const RAIL_BG = "#070a10";
const RAIL_EDGE = "rgba(255,255,255,0.10)";
const TEXT_DIM = "#8b98ad";

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  const decimals = abs >= 100 ? 2 : abs >= 10 ? 3 : abs >= 1 ? 4 : 5;
  const [whole, frac] = n.toFixed(decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

// Calibration points from the vision model: ideally 3-5 price labels read off
// the chart's own axis, each with where it sits vertically. Older replies only
// carried two (top/bottom), which still works.
function scalePoints(scale) {
  if (!scale || typeof scale !== "object") return [];
  const pts = [];
  if (Array.isArray(scale.labels)) {
    for (const l of scale.labels) {
      const price = Number(l?.price);
      const pct = Number(l?.pct);
      if (Number.isFinite(price) && Number.isFinite(pct) && price > 0 && pct >= 0 && pct <= 100) {
        pts.push({ price, pct });
      }
    }
  }
  if (pts.length < 2) {
    const tp = Number(scale.top_price);
    const bp = Number(scale.bottom_price);
    const ty = Number(scale.top_pct);
    const by = Number(scale.bottom_pct);
    if ([tp, bp, ty, by].every(Number.isFinite)) {
      pts.length = 0;
      pts.push({ price: tp, pct: ty }, { price: bp, pct: by });
    }
  }
  return pts;
}

// Least-squares fit of price -> vertical percent. Chart labels must move DOWN
// as price moves UP, so the longest decreasing run is used to throw out a
// misread label before fitting; otherwise one stray number (a typo, another
// instrument's scale) tilts every annotation on the image.
function fitScale(points) {
  const fit = (pts) => {
    const n = pts.length;
    if (n < 2) return null;
    const mp = pts.reduce((s, p) => s + p.price, 0) / n;
    const my = pts.reduce((s, p) => s + p.pct, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of pts) {
      num += (p.price - mp) * (p.pct - my);
      den += (p.price - mp) ** 2;
    }
    if (den === 0) return null;
    const slope = num / den;
    return { slope, intercept: my - slope * mp };
  };

  const sorted = points.slice().sort((a, b) => a.price - b.price);

  // Longest strictly-decreasing subsequence of percents (price ascending).
  const len = sorted.map(() => 1);
  const prev = sorted.map(() => -1);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j < i; j++) {
      if (sorted[j].pct > sorted[i].pct && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
  }
  let bestEnd = 0;
  for (let i = 1; i < len.length; i++) if (len[i] > len[bestEnd]) bestEnd = i;
  const kept = [];
  for (let i = bestEnd; i !== -1; i = prev[i]) kept.push(sorted[i]);
  kept.reverse();

  let pts = kept.length >= 2 ? kept : sorted;
  let f = fit(pts);
  if (!f) return null;

  // Drop any remaining point that sits far off the fitted line (still keeping
  // enough points to define a line), then refit.
  if (pts.length >= 3) {
    const residuals = pts.map((p) => Math.abs(f.slope * p.price + f.intercept - p.pct));
    const worst = residuals.indexOf(Math.max(...residuals));
    if (residuals[worst] > 10) {
      pts = pts.filter((_, i) => i !== worst);
      f = fit(pts) || f;
    }
  }
  return { ...f, points: pts };
}

// Positions come from mapping the concept's price through the chart's own
// price-axis calibration (price_scale), which is far more reliable than
// asking the model for pixel positions directly. A concept whose price can't
// be mapped is skipped rather than drawn in the wrong place.
function makePriceToPct(scale) {
  const points = scalePoints(scale);
  const fitted = fitScale(points);
  if (!fitted) return null;
  const { slope, intercept } = fitted;
  const used = fitted.points;

  // Prices rise up the screen, so the mapped percent must fall as price rises.
  // A positive slope means the labels were mismatched, not a real axis.
  if (!(slope < 0)) return null;

  const prices = used.map((p) => p.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo;
  if (!(span > 0)) return null;

  // Calibration that only covers a sliver of the axis extrapolates wildly.
  if (Math.abs(slope) * span < 5) return null;

  // Numbers far outside the calibrated window are usually misreads. Skipping
  // them is what stops annotations from piling up on the image edges.
  const tolerance = span * 0.12;

  return (price) => {
    const p = Number(price);
    if (!Number.isFinite(p)) return null;
    if (p < lo - tolerance || p > hi + tolerance) return null;
    const pct = slope * p + intercept;
    if (!Number.isFinite(pct)) return null;
    return Math.max(0, Math.min(100, pct));
  };
}

// One entry per drawn thing: where it sits on the chart (y1/y2 in percent) and
// how it should be labelled in the rail. `priority` decides what survives when
// the rail is full — the trade plan always outranks a passing concept.
function collectItems(concepts, priceScale, planLevels) {
  const toPct = makePriceToPct(priceScale);
  if (!toPct) return [];

  const items = [];
  const add = (item) => {
    if (!item || item.pct == null || !Number.isFinite(item.pct)) return;
    items.push(item);
  };

  const addZone = (kind, topPrice, bottomPrice, title, priority) => {
    const a = toPct(topPrice);
    const b = toPct(bottomPrice);
    if (a == null || b == null) return;
    const mid = (Number(topPrice) + Number(bottomPrice)) / 2;
    add({
      kind,
      y1: Math.min(a, b),
      y2: Math.max(a, b),
      pct: (a + b) / 2,
      title,
      price: fmtPrice(mid),
      priority
    });
  };

  const orderBlocks = Array.isArray(concepts.order_blocks) ? concepts.order_blocks : [];
  for (const ob of orderBlocks.slice(0, 2)) {
    addZone("order_block", ob?.top_price, ob?.bottom_price, `Order block ${ob?.bias === "bearish" ? "▼" : "▲"}`, 4);
  }

  const fvgs = Array.isArray(concepts.fvgs) ? concepts.fvgs : [];
  for (const f of fvgs.slice(0, 2)) {
    addZone("fvg", f?.top_price, f?.bottom_price, `FVG${f?.filled ? " (filled)" : ""}`, 5);
  }

  const sweeps = Array.isArray(concepts.liquidity_sweeps) ? concepts.liquidity_sweeps : [];
  for (const s of sweeps.slice(0, 2)) {
    const y = toPct(s?.price);
    add({
      kind: "sweep",
      y1: y,
      y2: y,
      pct: y,
      title: `Sweep ${s?.side === "buy-side" ? "▲" : "▼"}`,
      price: fmtPrice(s?.price),
      priority: 7
    });
  }

  const breaks = Array.isArray(concepts.breaks) ? concepts.breaks : [];
  for (const b of breaks.slice(0, 2)) {
    const y = toPct(b?.price);
    add({
      kind: "break",
      y1: y,
      y2: y,
      pct: y,
      title: `${String(b?.kind || "Break").toUpperCase()} ${b?.direction === "bearish" ? "▼" : "▲"}`,
      price: fmtPrice(b?.price),
      priority: 6
    });
  }

  const plan = Array.isArray(planLevels) ? planLevels : [];
  for (const lvl of plan) {
    const y = toPct(lvl?.price);
    if (y == null) continue;
    const kind = PALETTE[lvl.kind] ? lvl.kind : "level";
    const priority = kind === "entry" ? 1 : kind === "stop" ? 2 : kind === "target" ? 3 : 8;
    add({
      kind,
      y1: y,
      y2: y,
      pct: y,
      title: String(lvl.label || kind).slice(0, 22),
      price: fmtPrice(lvl.price),
      priority
    });
  }

  return items;
}

function buildOverlaySvg(width, height, railWidth, concepts, priceScale, planLevels) {
  const all = collectItems(concepts, priceScale, planLevels);
  if (!all.length) return null;

  // Keep the most important labels when there are too many to read.
  all.sort((a, b) => a.priority - b.priority);
  const kept = all.slice(0, MAX_LABELS).sort((a, b) => a.pct - b.pct);

  const totalWidth = width + railWidth;
  const railX = width;
  const chartLeft = Math.round(width * 0.04);
  const chartRight = width - 2;
  const pad = 12;

  const maxChars = kept.reduce((m, it) => Math.max(m, it.title.length), 6);
  const priceChars = kept.reduce((m, it) => Math.max(m, it.price.length), 4);

  // Font size is whatever fits both the available height and the rail width,
  // so 3 labels breathe and 12 still fit instead of overlapping.
  const byHeight = Math.floor((height - pad * 2) / (kept.length * 1.85));
  let fontSize = Math.min(22, Math.max(10, byHeight));
  const byWidth = Math.floor((railWidth - pad * 2 - priceChars * fontSize * 0.58) / (maxChars * 0.57));
  if (byWidth > 0) fontSize = Math.max(9, Math.min(fontSize, byWidth));
  const rowH = Math.max(fontSize + 8, Math.round(fontSize * 1.85));
  const labelH = rowH - 6;

  const parts = [];

  // --- rail background ---------------------------------------------------
  parts.push(
    `<rect x="${railX}" y="0" width="${railWidth}" height="${height}" fill="${RAIL_BG}"/>`,
    `<line x1="${railX + 0.5}" y1="0" x2="${railX + 0.5}" y2="${height}" stroke="${RAIL_EDGE}" stroke-width="1"/>`
  );

  // --- chart markings (no text on the chart itself) ----------------------
  for (const item of kept) {
    const c = PALETTE[item.kind] || PALETTE.level;
    const y1 = (item.y1 / 100) * height;
    const y2 = (item.y2 / 100) * height;
    const isZone = item.kind === "order_block" || item.kind === "fvg";

    if (isZone && y2 - y1 >= 2) {
      parts.push(
        `<rect x="${chartLeft}" y="${y1}" width="${chartRight - chartLeft}" height="${Math.max(2, y2 - y1)}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5" stroke-dasharray="7 5" rx="3"/>`
      );
    } else {
      const y = isZone ? (y1 + y2) / 2 : y1;
      parts.push(
        `<line x1="${chartLeft}" y1="${y}" x2="${chartRight}" y2="${y}" stroke="${c.stroke}" stroke-width="1.6" stroke-dasharray="${PLAN_DASH[item.kind] || (item.kind === "sweep" ? "10 6" : "")}" opacity="0.9"/>`
      );
    }
  }

  // --- label layout ------------------------------------------------------
  // Ideal position is the concept's own height; labels are pushed down only
  // enough to stop colliding, then the whole column is nudged up if it spills
  // past the bottom edge.
  const centers = [];
  let cursor = pad + rowH / 2;
  for (const item of kept) {
    const ideal = (item.pct / 100) * height;
    const center = Math.max(ideal, cursor);
    centers.push(center);
    cursor = center + rowH + 2;
  }
  const spill = centers[centers.length - 1] + labelH / 2 - (height - pad);
  if (spill > 0) {
    const room = Math.max(0, centers[0] - labelH / 2 - pad);
    const shift = Math.min(spill, room);
    for (let i = 0; i < centers.length; i++) centers[i] -= shift;
  }

  // --- connectors and plates --------------------------------------------
  kept.forEach((item, index) => {
    const c = PALETTE[item.kind] || PALETTE.level;
    const center = centers[index];
    const anchorY = (item.pct / 100) * height;

    // A thin elbow from the chart edge to the label, so a nudged label still
    // clearly belongs to its line.
    parts.push(
      `<path d="M ${chartRight} ${anchorY} H ${railX + 10} L ${railX + pad - 2} ${center} H ${railX + pad}" fill="none" stroke="${c.stroke}" stroke-width="1" opacity="0.45"/>`,
      `<circle cx="${chartRight}" cy="${anchorY}" r="2.4" fill="${c.stroke}"/>`
    );

    const plateX = railX + pad;
    const plateW = railWidth - pad * 2;
    const plateTop = center - labelH / 2;

    parts.push(
      `<rect x="${plateX}" y="${plateTop}" width="${plateW}" height="${labelH}" rx="4" fill="rgba(255,255,255,0.035)"/>`,
      `<rect x="${plateX}" y="${plateTop}" width="3" height="${labelH}" rx="1.5" fill="${c.stroke}"/>`
    );

    const title = item.title.slice(0, maxChars);
    const textX = plateX + 11;
    const textY = center + fontSize * 0.35;
    // The price column is right-aligned; if the two would touch, the title
    // gives way rather than running into the number.
    const priceX = plateX + plateW - 9;
    const priceW = item.price.length * fontSize * 0.58;
    const room = plateW - 20 - priceW - 10;
    const charsThatFit = Math.max(4, Math.floor(room / (fontSize * 0.57)));
    const shownTitle = title.slice(0, charsThatFit);

    parts.push(
      `<text x="${textX}" y="${textY}" fill="${c.stroke}" font-size="${fontSize}" font-family="DejaVu Sans, Segoe UI, Arial, sans-serif" font-weight="600">${esc(shownTitle)}</text>`
    );
    if (item.price) {
      parts.push(
        `<text x="${priceX}" y="${textY}" fill="${TEXT_DIM}" font-size="${Math.max(9, fontSize - 2)}" font-family="DejaVu Sans Mono, Consolas, monospace" text-anchor="end">${esc(item.price)}</text>`
      );
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}">${parts.join("")}</svg>`;
}

async function annotateChartImage({ buffer, concepts, priceScale, planLevels }) {
  if (!buffer || !buffer.length) return null;
  try {
    // Downscale first so the overlay text is drawn crisp at the final size
    // (and so EXIF-rotated phone shots are upright before calibrating).
    const base = await sharp(buffer)
      .rotate()
      .resize({ width: MAX_ANNOTATE_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer();

    const meta = await sharp(base).metadata();
    const width = meta.width;
    const height = meta.height;
    if (!width || !height || width < 100 || height < 100) return null;

    const railWidth = Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, width * RAIL_FRAC)));
    const svg = buildOverlaySvg(width, height, railWidth, concepts || {}, priceScale, planLevels);
    if (!svg) return null;

    // The marked image is wider than the screenshot by the rail. Build the
    // canvas first (dark rail), drop the untouched chart on the left, then
    // draw the overlay across both.
    const canvas = sharp({
      create: {
        width: width + railWidth,
        height,
        channels: 4,
        background: { r: 7, g: 10, b: 16, alpha: 1 }
      }
    });

    const out = await canvas
      .composite([
        { input: base, top: 0, left: 0 },
        { input: Buffer.from(svg), top: 0, left: 0 }
      ])
      .png()
      .toBuffer();
    return out;
  } catch (err) {
    console.error("Chart annotation failed:", err.message);
    return null;
  }
}

module.exports = { annotateChartImage, fmtPrice };
