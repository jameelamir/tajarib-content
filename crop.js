#!/usr/bin/env node
/**
 * Step 5: Crop reels to target aspect ratio using FFmpeg (center crop).
 * Reads:  episodes/{slug}/selected-reels.json (or analysis.json fallback)
 * Input:  episodes/{slug}/reels/reel-XX.mp4
 * Output: episodes/{slug}/reels/reel-XX-cropped.mp4
 *
 * Usage:
 *   node crop.js --slug my-episode --ratio 9:16 [--force]
 *
 * Supported ratios: 9:16 (vertical), 1:1 (square), 4:5 (Instagram portrait)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const EPISODES_DIR = path.join(__dirname, "episodes");

const RATIOS = {
  "9:16": { w: 9, h: 16 },
  "1:1":  { w: 1, h: 1 },
  "4:5":  { w: 4, h: 5 },
};

async function crop(slug, ratio, force = false) {
  const dir = path.join(EPISODES_DIR, slug);
  const reelsDir = path.join(dir, "reels");

  if (!RATIOS[ratio]) {
    console.error(`❌ Unknown ratio: ${ratio}. Use: ${Object.keys(RATIOS).join(", ")}`);
    process.exit(1);
  }

  if (!fs.existsSync(reelsDir)) {
    console.error("❌ No reels/ directory. Run cut step first.");
    process.exit(1);
  }

  // Determine which reels to crop
  const selectedReelsPath = path.join(dir, "selected-reels.json");
  const analysisPath = path.join(dir, "analysis.json");
  let reelIds = [];

  if (fs.existsSync(selectedReelsPath)) {
    const selected = JSON.parse(fs.readFileSync(selectedReelsPath, "utf8"));
    reelIds = selected.reels.map(r => String(r.id).padStart(2, "0"));
  } else if (fs.existsSync(analysisPath)) {
    const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    reelIds = (analysis.reels || []).map(r => String(r.id).padStart(2, "0"));
  } else {
    // Fallback: find all reel-XX.mp4 files
    reelIds = fs.readdirSync(reelsDir)
      .filter(f => /^reel-\d+\.mp4$/.test(f))
      .map(f => f.match(/reel-(\d+)\.mp4/)[1]);
  }

  if (reelIds.length === 0) {
    console.error("❌ No reels found to crop. Run cut step first.");
    process.exit(1);
  }

  // Check ffmpeg
  try { execSync("ffmpeg -version", { stdio: "pipe" }); }
  catch { console.error("❌ ffmpeg not found."); process.exit(1); }

  const { w, h } = RATIOS[ratio];
  console.log(`📐 Cropping ${reelIds.length} reels to ${ratio} (center crop)`);

  for (const id of reelIds) {
    const inputFile = path.join(reelsDir, `reel-${id}.mp4`);
    const outputFile = path.join(reelsDir, `reel-${id}-cropped.mp4`);

    if (!fs.existsSync(inputFile)) {
      console.log(`   ⏭️  reel-${id}.mp4 not found, skipping`);
      continue;
    }

    if (fs.existsSync(outputFile) && !force) {
      console.log(`   ⏭️  reel-${id}-cropped.mp4 already exists`);
      continue;
    }

    // FFmpeg center-crop: constrain to target aspect ratio, then ensure even dimensions
    const cropFilter = `crop='if(gt(iw/ih\\,${w}/${h})\\,ih*${w}/${h}\\,iw)':'if(gt(iw/ih\\,${w}/${h})\\,ih\\,iw*${h}/${w})',scale=trunc(iw/2)*2:trunc(ih/2)*2`;

    console.log(`   📐 reel-${id}: cropping to ${ratio}...`);

    const cmd = [
      "ffmpeg -y",
      `-i "${inputFile}"`,
      `-vf "${cropFilter}"`,
      `-c:v libx264 -crf 18 -preset fast`,
      `-c:a copy`,
      `-movflags +faststart`,
      `"${outputFile}"`
    ].join(" ");

    try {
      execSync(cmd, { stdio: "pipe" });
      const size = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ ${size} MB → reel-${id}-cropped.mp4`);
    } catch (e) {
      console.error(`   ❌ Crop failed for reel-${id}:`, e.stderr?.toString().slice(-200) || e.message);
    }
  }

  console.log(`\n✅ Crop complete for ${slug}`);
}

// CLI
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const ratio = get("--ratio") || "9:16";
const force = args.includes("--force");

if (!slug) {
  console.error("Usage: node crop.js --slug <slug> --ratio 9:16|1:1|4:5 [--force]");
  process.exit(1);
}
crop(slug, ratio, force).catch(err => { console.error("❌", err.message); process.exit(1); });
