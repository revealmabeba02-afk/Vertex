// Builds a short vertical (1080x1920) trade-recap video: intro card with the
// pair + direction, the chart screenshot with a stats overlay, then an
// outro. Each scene is rendered as a single PNG (sharp) and held for a few
// seconds (ffmpeg), then the segments are concatenated.
//
// Deliberately avoids a headless browser (Playwright/Chromium) — sharp and
// ffmpeg-static both ship as portable prebuilt binaries, which is much safer
// on Render's Node buildpack than relying on system-level Chromium deps
// being present.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");
const { W, H, introSvg, statsOverlaySvg, outroSvg } = require("./scenes");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${path.basename(cmd)} failed: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}

async function svgToPng(svgString, outPath, backgroundImagePath) {
  const svgBuffer = Buffer.from(svgString);
  if (backgroundImagePath) {
    const bg = await sharp(backgroundImagePath).resize(W, H, { fit: "cover" }).toBuffer();
    await sharp(bg).composite([{ input: svgBuffer, top: 0, left: 0 }]).png().toFile(outPath);
  } else {
    await sharp(svgBuffer).png().toFile(outPath);
  }
}

// Turns one still PNG into a short silent mp4 segment of the given duration.
async function imageToSegment(imagePath, seconds, outPath) {
  await run(ffmpegPath, [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-t", String(seconds),
    "-vf", `scale=${W}:${H},format=yuv420p`,
    "-r", "30",
    "-an",
    outPath
  ]);
}

async function concatSegments(segmentPaths, outPath, workDir) {
  const listFile = path.join(workDir, "concat.txt");
  fs.writeFileSync(listFile, segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath]);
}

/**
 * @param {object} opts
 * @param {string} opts.pair - e.g. "XAUUSD"
 * @param {string} opts.direction - "BUY" | "SELL"
 * @param {string|number} opts.entry
 * @param {string|number} opts.sl
 * @param {string|number} opts.tp
 * @param {number} [opts.confidence] - 0-100
 * @param {string} [opts.chartImagePath] - path to the chart screenshot (PNG/JPG)
 * @param {string} [opts.handle] - social handle for the outro, e.g. "@VertexScanner"
 * @returns {Promise<string>} path to the finished mp4 (caller should move/send then delete)
 */
async function generateTradeVideo(opts) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vx-video-"));
  try {
    const introPng = path.join(workDir, "intro.png");
    const statsPng = path.join(workDir, "stats.png");
    const outroPng = path.join(workDir, "outro.png");

    await svgToPng(introSvg(opts), introPng, null);
    await svgToPng(statsOverlaySvg(opts), statsPng, opts.chartImagePath || null);
    await svgToPng(outroSvg(opts), outroPng, null);

    const introSeg = path.join(workDir, "intro.mp4");
    const statsSeg = path.join(workDir, "stats.mp4");
    const outroSeg = path.join(workDir, "outro.mp4");

    await imageToSegment(introPng, 2.5, introSeg);
    await imageToSegment(statsPng, 5, statsSeg);
    await imageToSegment(outroPng, 2.5, outroSeg);

    const finalPath = path.join(os.tmpdir(), `vx-trade-${crypto.randomBytes(6).toString("hex")}.mp4`);
    await concatSegments([introSeg, statsSeg, outroSeg], finalPath, workDir);
    return finalPath;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { generateTradeVideo };
