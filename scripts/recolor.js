// One-off migration: teal/cyan ramp -> steel blue / navy.
//
// Vertex and a competing product shared the same cyan identity, which made
// the two look like the same company. This rewrites the whole colour ramp
// (backgrounds, panels, borders, glows, chart strokes, SVG badges) in a
// single pass so no value can be mapped twice.
//
// Run from the repo root: node scripts/recolor.js [--dry]

const fs = require("fs");
const path = require("path");

const MAP = {
  // --- base surfaces -------------------------------------------------
  "001312": "060B14", // page background (deep navy-black)
  "001818": "0A1020", // legacy palette value
  "003030": "0F1B2E", // legacy palette value
  "00201F": "0A1524", // top glow band in the backdrop
  "000A09": "03060C", // bottom of the backdrop gradient
  "061817": "0A1322", // badge inner radial
  "000605": "04070E", // badge outer radial
  "03100F": "070D18",
  "04211F": "0B1526", // --panel
  "062A27": "101E33", // --panel-alt
  "0F403C": "1D3355", // --border
  "0A302D": "16263F", // --border-soft
  "0E0B12": "060B14", // manifest

  // --- text ----------------------------------------------------------
  "E9FFFC": "EAF1FF",
  "93BDB8": "9DB2CE",
  "78A5A0": "7E96B4",

  // --- brand accent --------------------------------------------------
  "18F0F0": "4C8DFF", // electric cyan -> electric blue
  "12B8C4": "3B7BDD", // mid stroke
  "0FA3AE": "2F68C2", // depth stroke
  "0B8E9E": "2C6BC4", // --accent-2
  "0B6B76": "1E457F", // dark ring stop
  "0A7C86": "24518F",
  "A8FFFF": "A9C8FF", // light glow
  "E6FFFF": "E8EFFF",
  "0E7C88": "2A5FA8", // alternate candle fill in the badge SVG
  "002322": "04101F", // --action-ink
  "7FD4FF": "8FB3FF", // --neutral

  // --- light theme ---------------------------------------------------
  "EFFBFB": "F2F5FB",
  "F5FDFD": "F7F9FD",
  "CBE7E6": "D3DEEC",
  "DEF1F0": "E3EAF4",
  "062322": "0B1424",
  "456C69": "4C5F78",
  "5E827F": "61708A"
};

const ROOT = path.resolve(__dirname, "..");
const dry = process.argv.includes("--dry");

const files = [];
for (const dir of ["public", "pages"]) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    const full = path.join(ROOT, dir, name);
    if (!fs.statSync(full).isFile()) continue;
    if (!/\.(css|js|html|webmanifest|xml|txt)$/.test(name)) continue;
    files.push(full);
  }
}

const HEX = /#([0-9a-fA-F]{6})/g;
let grand = 0;

for (const file of files) {
  const before = fs.readFileSync(file, "utf8");
  const hits = {};
  const after = before.replace(HEX, (whole, hex) => {
    const to = MAP[hex.toUpperCase()];
    if (!to) return whole;
    hits[hex.toUpperCase()] = (hits[hex.toUpperCase()] || 0) + 1;
    return "#" + to;
  });
  const count = Object.values(hits).reduce((a, b) => a + b, 0);
  if (!count) continue;
  grand += count;
  if (!dry) fs.writeFileSync(file, after);
  const summary = Object.entries(hits)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `#${k}x${v}`)
    .join(" ");
  console.log(`${path.relative(ROOT, file).padEnd(28)} ${String(count).padStart(4)}  ${summary}`);
}

// Anything still teal-ish means the ramp has a hole in it.
const left = {};
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(HEX)) {
    const h = m[1].toUpperCase();
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const teal = g > 120 && b > 120 && r < 90 && Math.abs(g - b) < 70;
    if (teal) left[h] = (left[h] || 0) + 1;
  }
}
console.log(`\n${dry ? "DRY RUN: " : ""}${grand} colours rewritten`);
console.log(
  Object.keys(left).length
    ? "STILL TEAL: " + Object.entries(left).map(([k, v]) => `#${k}x${v}`).join(" ")
    : "no teal/cyan hexes left"
);
