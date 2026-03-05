#!/usr/bin/env node
/**
 * Step 6: Crop reels to target aspect ratio using FFmpeg.
 * Supports center crop (default) and face-tracking crop.
 *
 * Reads:  episodes/{slug}/selected-reels.json (or analysis.json fallback)
 * Input:  episodes/{slug}/reels/reel-XX.mp4
 * Output: episodes/{slug}/reels/reel-XX-cropped.mp4
 *
 * Usage:
 *   node crop.js --slug my-episode --ratio 9:16 [--force] [--face-track]
 *
 * Supported ratios: 9:16 (vertical), 1:1 (square), 4:5 (Instagram portrait)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const EPISODES_DIR = path.join(__dirname, "episodes");
const PYTHON = "python3";
const FACE_TRACK_SCRIPT = path.join(__dirname, "face_track.py");

const RATIOS = {
  "9:16": { w: 9, h: 16 },
  "1:1":  { w: 1, h: 1 },
  "4:5":  { w: 4, h: 5 },
};

/**
 * Get video dimensions via ffprobe.
 */
function probeVideo(filePath) {
  const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${filePath}"`;
  const out = JSON.parse(execSync(cmd, { encoding: "utf8" }));
  const s = out.streams[0];
  return { width: s.width, height: s.height };
}

/**
 * Run face_track.py on a video and return the keyframes JSON.
 */
function runFaceTracking(inputFile, reelsDir, id) {
  const trackFile = path.join(reelsDir, `reel-${id}-facetrack.json`);

  console.log(`   🔍 reel-${id}: detecting faces...`);
  try {
    execSync(
      `${PYTHON} "${FACE_TRACK_SCRIPT}" "${inputFile}" "${trackFile}"`,
      { stdio: ["pipe", "pipe", "pipe"], timeout: 120000 }
    );
  } catch (e) {
    const stderr = e.stderr?.toString() || e.message;
    if (stderr.includes("Missing dependencies")) {
      console.error(`   ⚠️  Face tracking dependencies not installed.`);
      console.error(`   Run: pip3 install mediapipe opencv-python-headless`);
      return null;
    }
    console.error(`   ⚠️  Face tracking failed for reel-${id}: ${stderr.slice(-200)}`);
    return null;
  }

  if (!fs.existsSync(trackFile)) return null;

  try {
    return JSON.parse(fs.readFileSync(trackFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Build FFmpeg crop filter expression with face-tracking interpolation.
 * Reduces keyframes to max ~30, then generates nested if(lt(t,...)) for smooth panning.
 */
function buildFaceTrackCropFilter(keyframes, videoWidth, videoHeight, targetW, targetH) {
  // Calculate crop dimensions (same logic as center crop)
  let cropW, cropH;
  if (videoWidth / videoHeight > targetW / targetH) {
    // Video is wider than target — crop width, keep height
    cropH = videoHeight;
    cropW = Math.floor(videoHeight * targetW / targetH);
  } else {
    // Video is taller — crop height, keep width
    cropW = videoWidth;
    cropH = Math.floor(videoWidth * targetH / targetW);
  }

  // Ensure even dimensions
  cropW = Math.floor(cropW / 2) * 2;
  cropH = Math.floor(cropH / 2) * 2;

  const maxOffset = videoWidth - cropW;
  if (maxOffset <= 0) {
    // Video is narrower than or equal to crop — no panning possible, center it
    return `crop=${cropW}:${cropH}:(iw-${cropW})/2:0,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  }

  // Convert normalized x positions to pixel offsets (clamped)
  let pixelKeyframes = keyframes.map(kf => {
    let offset = Math.round(kf.x * videoWidth - cropW / 2);
    offset = Math.max(0, Math.min(maxOffset, offset));
    return { t: kf.t, offset };
  });

  // Reduce keyframes to avoid overly deep nesting in FFmpeg expressions.
  // Keep first, last, and points where position changes significantly.
  // Larger dead zone means small jitters are ignored → smoother panning.
  const MAX_KEYFRAMES = 30;
  const MIN_CHANGE_PX = 60; // only keep a keyframe if position shifted ≥60px — smoother panning
  if (pixelKeyframes.length > MAX_KEYFRAMES) {
    const reduced = [pixelKeyframes[0]];
    for (let i = 1; i < pixelKeyframes.length - 1; i++) {
      const prev = reduced[reduced.length - 1];
      if (Math.abs(pixelKeyframes[i].offset - prev.offset) >= MIN_CHANGE_PX) {
        reduced.push(pixelKeyframes[i]);
      }
    }
    reduced.push(pixelKeyframes[pixelKeyframes.length - 1]);

    // If still too many, uniformly sample
    if (reduced.length > MAX_KEYFRAMES) {
      const step = Math.ceil(reduced.length / MAX_KEYFRAMES);
      const sampled = [];
      for (let i = 0; i < reduced.length; i += step) sampled.push(reduced[i]);
      if (sampled[sampled.length - 1].t !== reduced[reduced.length - 1].t) {
        sampled.push(reduced[reduced.length - 1]);
      }
      pixelKeyframes = sampled;
    } else {
      pixelKeyframes = reduced;
    }
  }

  console.log(`   📊 Using ${pixelKeyframes.length} keyframes for crop expression`);

  // Build nested if() expression for linear interpolation between keyframes.
  // Uses \, escaping for commas (NOT single quotes) so FFmpeg parses them correctly.
  let expr;
  if (pixelKeyframes.length === 1) {
    expr = String(pixelKeyframes[0].offset);
  } else {
    // Build from the last keyframe backwards
    expr = String(pixelKeyframes[pixelKeyframes.length - 1].offset);
    for (let i = pixelKeyframes.length - 2; i >= 0; i--) {
      const curr = pixelKeyframes[i];
      const next = pixelKeyframes[i + 1];
      const dt = next.t - curr.t;
      if (dt <= 0) continue;
      const dOffset = next.offset - curr.offset;
      const lerp = dOffset === 0
        ? String(curr.offset)
        : `${curr.offset}+${dOffset}*(t-${curr.t})/${dt}`;
      expr = `if(lt(t\\,${next.t})\\,${lerp}\\,${expr})`;
    }
  }

  // No single quotes around expression — \, handles comma escaping within filter args
  return `crop=${cropW}:${cropH}:${expr}:0,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

async function crop(slug, ratio, force = false, faceTrack = false, reelId = null) {
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

  // Per-reel filter
  if (reelId) {
    const padded = reelId.padStart(2, "0");
    reelIds = reelIds.filter(id => id === padded);
    if (reelIds.length === 0) {
      console.error(`❌ Reel ${reelId} not found among available reels.`);
      process.exit(1);
    }
    console.log(`📐 Per-reel mode: processing only reel-${padded}`);
  }

  if (reelIds.length === 0) {
    console.error("❌ No reels found to crop. Run cut step first.");
    process.exit(1);
  }

  // Check ffmpeg
  try { execSync("ffmpeg -version", { stdio: "pipe" }); }
  catch { console.error("❌ ffmpeg not found."); process.exit(1); }

  const { w, h } = RATIOS[ratio];
  const mode = faceTrack ? "face-tracking" : "center";
  console.log(`📐 Cropping ${reelIds.length} reels to ${ratio} (${mode} crop)`);

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

    let cropFilter;

    if (faceTrack) {
      // Face-tracking crop
      const trackData = runFaceTracking(inputFile, reelsDir, id);
      if (trackData && trackData.keyframes && trackData.keyframes.length > 0) {
        const { width, height } = probeVideo(inputFile);
        cropFilter = buildFaceTrackCropFilter(trackData.keyframes, width, height, w, h);
        console.log(`   📐 reel-${id}: face-tracking crop to ${ratio}...`);
      } else {
        // Fallback to center crop
        console.log(`   ⚠️  reel-${id}: no face data, falling back to center crop`);
        cropFilter = `crop='if(gt(iw/ih\\,${w}/${h})\\,ih*${w}/${h}\\,iw)':'if(gt(iw/ih\\,${w}/${h})\\,ih\\,iw*${h}/${w})',scale=trunc(iw/2)*2:trunc(ih/2)*2`;
      }
    } else {
      // Standard center crop
      cropFilter = `crop='if(gt(iw/ih\\,${w}/${h})\\,ih*${w}/${h}\\,iw)':'if(gt(iw/ih\\,${w}/${h})\\,ih\\,iw*${h}/${w})',scale=trunc(iw/2)*2:trunc(ih/2)*2`;
      console.log(`   📐 reel-${id}: cropping to ${ratio}...`);
    }

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
const faceTrack = args.includes("--face-track");
const reelId = get("--reel-id");

if (!slug) {
  console.error("Usage: node crop.js --slug <slug> --ratio 9:16|1:1|4:5 [--force] [--face-track]");
  process.exit(1);
}
crop(slug, ratio, force, faceTrack, reelId).catch(err => { console.error("❌", err.message); process.exit(1); });
