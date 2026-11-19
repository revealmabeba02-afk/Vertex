// Draws the smart-money concepts the vision model detected directly onto the
// uploaded chart screenshot, so the result card can show the trader's own
// image marked up — order blocks and FVGs as shaded zones, liquidity sweeps
// and BOS/CHoCH breaks as labelled lines — instead of only listing them as
// text.
//
// The model reports the concepts as PRICES plus a calibration of the chart's
// visible price axis (highest/lowest axis label and where each sits
// vertically). Mapping price -> height here is far more reliable than asking
// a vision model for pixel positions directly. Zones span most of the chart
// width, which is how SMC traders draw them anyway.
//
// Purely additive: every call is best-effort and returns the original buffer
// unchanged if anything is missing or malformed.

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

const MAX_PER_TYPE = 3;

// A marked-up copy is sent back to the browser as base64, so a 4000px phone
// screenshot would bloat the response. 1800px keeps labels and candles crisp
// while keeping the payload small enough to load quickly on mobile data.
const MAX_ANNOTATE_WIDTH = 1800;

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

// Rows of { kind, y1, y2, label } — y1/y2 are percent of height.
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

function collectRows(concepts, priceScale) {
  const rows = [];
  const toPct = makePriceToPct(priceScale);
  const cap = (kind) => rows.filter((r) => r.kind === kind).length < MAX_PER_TYPE;

  for (const ob of Array.isArray(concepts.order_blocks) ? concepts.order_blocks : []) {
    if (!cap("order_block")) break;
    const top = toPct && toPct(ob?.top_price);
    const bottom = toPct && toPct(ob?.bottom_price);
    if (top == null || bottom == null) continue;
    rows.push({
      kind: "order_block",
      y1: Math.min(top, bottom),
      y2: Math.max(top, bottom),
      label: `OB ${ob.bias === "bearish" ? "▼" : "▲"}${ob?.note ? " · " + esc(ob.note) : ""}`
    });
  }

  for (const f of Array.isArray(concepts.fvgs) ? concepts.fvgs : []) {
    if (!cap("fvg")) break;
    const top = toPct && toPct(f?.top_price);
    const bottom = toPct && toPct(f?.bottom_price);
    if (top == null || bottom == null) continue;
    rows.push({
      kind: "fvg",
      y1: Math.min(top, bottom),
      y2: Math.max(top, bottom),
      label: `FVG${f?.filled ? " (filled)" : ""}${f?.note ? " · " + esc(f.note) : ""}`
    });
  }

  for (const s of Array.isArray(concepts.liquidity_sweeps) ? concepts.liquidity_sweeps : []) {
    if (!cap("sweep")) break;
    const y = toPct && toPct(s?.price);
    if (y == null) continue;
    rows.push({
      kind: "sweep",
      y1: y,
      y2: y,
      label: `SWEEP ${s?.side === "buy-side" ? "▲" : "▼"}${s?.note ? " · " + esc(s.note) : ""}`
    });
  }

  for (const b of Array.isArray(concepts.breaks) ? concepts.breaks : []) {
    if (!cap("break")) break;
    const y = toPct && toPct(b?.price);
    if (y == null) continue;
    rows.push({
      kind: "break",
      y1: y,
      y2: y,
      label: `${String(b?.kind || "BREAK").toUpperCase()} ${b?.direction === "bearish" ? "▼" : "▲"}${b?.note ? " · " + esc(b.note) : ""}`
    });
  }

  return rows;
}

function buildOverlaySvg(width, height, concepts, priceScale, planLevels) {
  const rows = collectRows(concepts, priceScale);
  const toPct = makePriceToPct(priceScale);
  const planRows = (Array.isArray(planLevels) ? planLevels : [])
    .map((lvl) => ({ ...lvl, pct: toPct && toPct(lvl.price) }))
    .filter((lvl) => lvl.pct != null);
  if (!rows.length && !planRows.length) return null;

  const left = width * 0.04;
  const right = width * 0.96;
  const zoneW = right - left;
  const fontSize = Math.max(12, Math.round(height * 0.022));
  const pad = Math.round(fontSize * 0.5);

  const parts = [];
  // Zones first (behind), lines on top.
  const order = { fvg: 0, order_block: 1, sweep: 2, break: 3 };
  rows.sort((a, b) => order[a.kind] - order[b.kind]);

  // Labels are placed inside their zone/on their line and nudged downward
  // when they would collide with one already placed, so a cluster of
  // concepts near one price stays readable instead of stacking into a blob.
  const placed = [];
  const overlaps = (top, bottom) => placed.some((p) => top < p.bottom && bottom > p.top);
  const labelH = fontSize + pad * 2;

  for (const row of rows) {
    const c = PALETTE[row.kind];
    const y1 = (row.y1 / 100) * height;
    const y2 = (row.y2 / 100) * height;
    const isZone = row.kind === "order_block" || row.kind === "fvg";

    if (isZone && y2 - y1 >= 2) {
      parts.push(
        `<rect x="${left}" y="${y1}" width="${zoneW}" height="${Math.max(2, y2 - y1)}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5" stroke-dasharray="7 5" rx="3"/>`
      );
    } else {
      // Zones too thin to fill, and sweeps/breaks: a single line.
      const y = isZone ? (y1 + y2) / 2 : y1;
      parts.push(
        `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${c.stroke}" stroke-width="2" stroke-dasharray="${row.kind === "sweep" ? "10 6" : ""}"/>`
      );
    }

    // Start the label at the middle of the zone/on the line, keep it fully
    // inside the image, then push it down while it collides.
    let labelTop = Math.max(2, Math.min(height - labelH - 2, (y1 + y2) / 2 - labelH / 2));
    let guard = 0;
    while (overlaps(labelTop, labelTop + labelH) && guard < 12) {
      labelTop += labelH + 2;
      if (labelTop + labelH > height - 2) {
        labelTop = Math.max(2, labelTop - (placed.length + 1) * (labelH + 2));
        break;
      }
      guard++;
    }
    placed.push({ top: labelTop, bottom: labelTop + labelH });

    const maxChars = Math.max(8, Math.floor((zoneW - pad * 2) / (fontSize * 0.56)));
    const text = row.label.slice(0, Math.min(42, maxChars));
    const plateW = Math.min(text.length * fontSize * 0.56 + pad * 2, zoneW);
    parts.push(
      `<rect x="${left}" y="${labelTop}" width="${plateW}" height="${labelH}" fill="rgba(10,12,18,0.78)" rx="4"/>`,
      `<text x="${left + pad}" y="${labelTop + fontSize + pad * 0.4}" fill="${c.stroke}" font-size="${fontSize}" font-family="monospace">${text}</text>`
    );
  }

  // Trade-plan levels: entry, stop, targets, key levels. Drawn as thin lines
  // with their labels on the RIGHT edge so they never fight the concept
  // labels on the left, and de-duplicated when two levels sit on top of
  // each other (entry and a target rarely do, but key levels can).
  const planPlaced = [];
  for (const lvl of planRows) {
    const c = PALETTE[lvl.kind] || PALETTE.level;
    const y = (lvl.pct / 100) * height;
    if (planPlaced.some((p) => Math.abs(p - y) < fontSize * 0.9)) continue;
    planPlaced.push(y);

    parts.push(
      `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${c.stroke}" stroke-width="1.3" stroke-dasharray="${PLAN_DASH[lvl.kind] || ""}" opacity="0.95"/>`
    );

    const plateLimit = zoneW * 0.45;
    const maxChars = Math.max(6, Math.floor((plateLimit - pad * 2) / (fontSize * 0.56)));
    const text = String(lvl.label || "").slice(0, Math.min(20, maxChars));
    const plateW = Math.min(text.length * fontSize * 0.56 + pad * 2, plateLimit);
    const plateX = right - plateW;
    const plateTop = Math.max(2, Math.min(height - labelH - 2, y - labelH / 2));
    parts.push(
      `<rect x="${plateX}" y="${plateTop}" width="${plateW}" height="${labelH}" fill="rgba(10,12,18,0.78)" rx="4"/>`,
      `<text x="${plateX + pad}" y="${plateTop + fontSize + pad * 0.4}" fill="${c.stroke}" font-size="${fontSize}" font-family="monospace">${text}</text>`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
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

    const svg = buildOverlaySvg(width, height, concepts || {}, priceScale, planLevels);
    if (!svg) return null;

    const out = await sharp(base)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();
    return out;
  } catch (err) {
    console.error("Chart annotation failed:", err.message);
    return null;
  }
}

module.exports = { annotateChartImage };
