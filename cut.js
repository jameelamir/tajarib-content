#!/usr/bin/env node
/**
 * Step 4: Cut reels using FFmpeg (precise word-level timestamps).
 * Reads:  episodes/{slug}/analysis.json + transcript.json
 * Writes: episodes/{slug}/reels/reel-01.mp4, reel-02.mp4, ...
 *
 * Usage:
 *   node cut.js --slug my-episode --video /path/to/episode.mp4 [--force]
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const EPISODES_DIR = path.join(__dirname, "episodes");

function toSeconds(ts) {
  const parts = ts.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Find the nearest word boundary in transcript for accurate FFmpeg cut
function snapToWord(words, targetSec, direction = "nearest") {
  if (!words || words.length === 0) return targetSec;
  let best = words[0];
  let bestDist = Infinity;
  for (const w of words) {
    const t = direction === "start" ? w.start : w.end;
    const dist = Math.abs(t - targetSec);
    if (dist < bestDist) { bestDist = dist; best = w; }
  }
  return direction === "start" ? best.start : best.end;
}

async function cut(slug, videoPath, force = false) {
  const dir = path.join(EPISODES_DIR, slug);
  const reelsDir = path.join(dir, "reels");
  const analysisPath = path.join(dir, "analysis.json");
  const transcriptPath = path.join(dir, "transcript.json");

  if (!fs.existsSync(analysisPath)) {
    console.error("❌ No analysis.json. Run analyze.js first.");
    process.exit(1);
  }
  if (!videoPath || !fs.existsSync(videoPath)) {
    console.error(`❌ Video file not found: ${videoPath}`);
    process.exit(1);
  }

  // Check ffmpeg
  try { execSync("ffmpeg -version", { stdio: "pipe" }); }
  catch { console.error("❌ ffmpeg not found. Install: apt install ffmpeg"); process.exit(1); }

  const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  const words = transcript.words || [];

  fs.mkdirSync(reelsDir, { recursive: true });

  const reels = analysis.reels || [];
  console.log(`✂️  Cutting ${reels.length} reels from: ${videoPath}`);

  for (const reel of reels) {
    const outFile = path.join(reelsDir, `reel-${String(reel.id).padStart(2, "0")}.mp4`);

    if (fs.existsSync(outFile) && !force) {
      console.log(`⏭️  Reel ${reel.id} already cut: ${outFile}`);
      continue;
    }

    const startSec = snapToWord(words, toSeconds(reel.start), "start");
    const endSec = snapToWord(words, toSeconds(reel.end), "end");
    const duration = endSec - startSec;

    console.log(`   ✂️  Reel ${reel.id}: ${reel.start}→${reel.end} (${duration.toFixed(1)}s) → ${path.basename(outFile)}`);

    const cmd = [
      "ffmpeg -y",
      `-ss ${startSec.toFixed(3)}`,
      `-i "${videoPath}"`,
      `-t ${duration.toFixed(3)}`,
      `-c:v libx264 -crf 18 -preset fast`,
      `-c:a aac -b:a 192k`,
      `-movflags +faststart`,
      `"${outFile}"`
    ].join(" ");

    try {
      execSync(cmd, { stdio: "pipe" });
      const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ ${size} MB`);
    } catch (e) {
      console.error(`   ❌ Reel ${reel.id} failed:`, e.message);
    }
  }

  console.log(`\n✅ Reels saved to: ${reelsDir}`);
}

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const video = get("--video");
const force = args.includes("--force");

if (!slug || !video) {
  console.error("Usage: node cut.js --slug <slug> --video /path/to/episode.mp4 [--force]");
  process.exit(1);
}
cut(slug, video, force).catch(err => { console.error("❌", err.message); process.exit(1); });
