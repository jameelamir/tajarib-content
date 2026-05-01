/**
 * Low-quality video preview transcoder.
 *
 * Lazily generates a `.low.mp4` derivative next to each source video for
 * the LD preview toggle. Used both on-demand (via /api/video?q=low) and
 * proactively after the reel pipeline finishes a step.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Tracks transcodes currently running (keyed by source path) so we don't
// double-spawn ffmpeg on parallel requests for the same source video.
const inFlight = new Set();

// Returns the cached .low.mp4 path if ready, else null. When not ready, kicks
// off a background ffmpeg transcode (non-blocking, fire-and-forget) so a
// later request finds it cached. Atomic: writes to .tmp then renames.
function ensureLowQuality(srcPath) {
  if (!srcPath || !/\.mp4$/i.test(srcPath)) return null;
  const lowPath = srcPath.replace(/\.mp4$/i, ".low.mp4");
  try {
    const srcStat = fs.statSync(srcPath);
    if (fs.existsSync(lowPath)) {
      const lowStat = fs.statSync(lowPath);
      if (lowStat.size > 1024 && lowStat.mtimeMs >= srcStat.mtimeMs) return lowPath;
    }
  } catch { return null; }
  if (inFlight.has(srcPath)) return null;
  inFlight.add(srcPath);
  const tmpPath = lowPath + ".tmp";
  try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  const args = [
    "-y", "-i", srcPath,
    "-vf", "scale='trunc(iw/2)*2':'min(720,trunc(ih/2)*2)':force_original_aspect_ratio=decrease",
    "-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    "-f", "mp4", tmpPath,
  ];
  const child = spawn("ffmpeg", args, { stdio: "ignore", detached: false });
  child.on("exit", (code) => {
    inFlight.delete(srcPath);
    if (code === 0) { try { fs.renameSync(tmpPath, lowPath); } catch {} }
    else { try { fs.unlinkSync(tmpPath); } catch {} }
  });
  child.on("error", () => { inFlight.delete(srcPath); try { fs.unlinkSync(tmpPath); } catch {} });
  return null;
}

// Pre-warms the low-quality version of whichever reel file the given pipeline
// step just produced. Fire-and-forget — never throws.
function prewarmReelStep(episodesDir, slug, reelId, step) {
  if (!slug || !reelId) return;
  const padded = String(reelId).padStart(2, "0");
  const reelsDir = path.join(episodesDir, slug, "reels");
  const target = ({
    cut:      `reel-${padded}.mp4`,
    crop:     `reel-${padded}-cropped.mp4`,
    subtitle: `reel-${padded}-subtitled.mp4`,
    overlay:  `reel-${padded}-final.mp4`,
  })[step];
  if (!target) return;
  const srcPath = path.join(reelsDir, target);
  try { ensureLowQuality(srcPath); } catch {}
}

module.exports = { ensureLowQuality, prewarmReelStep };
