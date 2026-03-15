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
 * Smoothstep easing — cubic ease-in-ease-out for smooth camera pans.
 */
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Build FFmpeg crop filter with hold-and-pan face tracking.
 *
 * Behaves like a camera operator: locks position, only pans when the face
 * has genuinely moved within a shot. At scene cuts, snaps instantly to the
 * new face position — no animation across cuts.
 */
function buildFaceTrackCropFilter(keyframes, videoWidth, videoHeight, targetW, targetH, cuts) {
  // Calculate crop dimensions (same logic as center crop)
  let cropW, cropH;
  if (videoWidth / videoHeight > targetW / targetH) {
    cropH = videoHeight;
    cropW = Math.floor(videoHeight * targetW / targetH);
  } else {
    cropW = videoWidth;
    cropH = Math.floor(videoWidth * targetH / targetW);
  }
  cropW = Math.floor(cropW / 2) * 2;
  cropH = Math.floor(cropH / 2) * 2;

  const maxOffset = videoWidth - cropW;
  if (maxOffset <= 0) {
    return `crop=${cropW}:${cropH}:(iw-${cropW})/2:0,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  }

  // Convert normalized x to pixel offsets
  const pixelKfs = keyframes.map(kf => {
    let offset = Math.round(kf.x * videoWidth - cropW / 2);
    offset = Math.max(0, Math.min(maxOffset, offset));
    return { t: kf.t, offset };
  });

  // Map precise cut times to the first keyframe at or after each cut
  const cutTimes = (cuts || []).sort((a, b) => a - b);
  const cutMap = new Map(); // keyframe time → precise cut time
  let cutIdx = 0;
  for (let i = 1; i < pixelKfs.length && cutIdx < cutTimes.length; i++) {
    if (pixelKfs[i].t >= cutTimes[cutIdx]) {
      cutMap.set(pixelKfs[i].t, cutTimes[cutIdx]);
      cutIdx++;
    }
  }

  // --- Hold-and-pan with scene cut awareness ---
  const HOLD_THRESHOLD_PX = 80;
  const PAN_SPEED = 200;
  const MIN_PAN_SEC = 0.8;
  const MAX_PAN_SEC = 2.0;
  const PAN_EASE_STEPS = 10;

  // 1. Group keyframes into hold zones — break at scene cuts unconditionally
  const zones = [{ sum: pixelKfs[0].offset, count: 1, startT: pixelKfs[0].t, endT: pixelKfs[0].t, cutT: null }];
  for (let i = 1; i < pixelKfs.length; i++) {
    const kf = pixelKfs[i];
    const preciseCutT = cutMap.get(kf.t);

    if (preciseCutT !== undefined) {
      // Scene cut — always start a new zone, store precise cut time
      zones.push({ sum: kf.offset, count: 1, startT: kf.t, endT: kf.t, cutT: preciseCutT });
    } else {
      const zone = zones[zones.length - 1];
      const mean = zone.sum / zone.count;
      if (Math.abs(kf.offset - mean) < HOLD_THRESHOLD_PX) {
        zone.sum += kf.offset;
        zone.count++;
        zone.endT = kf.t;
      } else {
        zones.push({ sum: kf.offset, count: 1, startT: kf.t, endT: kf.t, cutT: null });
      }
    }
  }

  // 2. Compute hold positions
  const holds = zones.map(z => ({
    offset: Math.max(0, Math.min(maxOffset, Math.round(z.sum / z.count))),
    startT: z.startT,
    endT: z.endT,
    cutT: z.cutT, // precise cut time (null = same shot, number = scene cut)
  }));

  const cutCount = holds.filter(h => h.cutT !== null).length;
  console.log(`   📊 ${holds.length} hold positions (${cutCount} scene cuts, from ${pixelKfs.length} raw keyframes)`);

  // 3. Build output keyframes: instant snap at cuts, smoothstep pan within shots
  const output = [];
  for (let i = 0; i < holds.length; i++) {
    const hold = holds[i];

    if (i > 0) {
      const prev = holds[i - 1];

      if (hold.cutT !== null) {
        // Scene cut — end previous hold at precise cut time, then snap instantly
        const snapT = hold.cutT; // precise per-frame cut timestamp
        const epsilon = 0.001;
        output.push({ t: Math.round((snapT - epsilon) * 1000) / 1000, offset: prev.offset });
        // New position starts at exactly the cut timestamp
      } else {
        // Same shot — smooth pan
        const dist = Math.abs(hold.offset - prev.offset);
        const panDur = Math.max(MIN_PAN_SEC, Math.min(MAX_PAN_SEC, dist / PAN_SPEED));
        const panStart = Math.max(prev.startT, hold.startT - panDur);
        const panEnd = hold.startT;

        output.push({ t: panStart, offset: prev.offset });

        for (let s = 1; s <= PAN_EASE_STEPS; s++) {
          const frac = s / (PAN_EASE_STEPS + 1);
          output.push({
            t: Math.round((panStart + (panEnd - panStart) * frac) * 1000) / 1000,
            offset: Math.round(prev.offset + (hold.offset - prev.offset) * smoothstep(frac)),
          });
        }
      }
    }

    // Hold start and end (flat line)
    // For cuts, start at the precise cut time, not the keyframe sample time
    const holdStart = (hold.cutT !== null) ? hold.cutT : hold.startT;
    output.push({ t: holdStart, offset: hold.offset });
    if (hold.endT > hold.startT) {
      output.push({ t: hold.endT, offset: hold.offset });
    }
  }

  console.log(`   📊 Using ${output.length} keyframes for crop expression`);

  // 4. Build nested if() FFmpeg expression
  let expr;
  if (output.length === 1) {
    expr = String(output[0].offset);
  } else {
    expr = String(output[output.length - 1].offset);
    for (let i = output.length - 2; i >= 0; i--) {
      const curr = output[i];
      const next = output[i + 1];
      const dt = Math.round((next.t - curr.t) * 1000) / 1000;
      if (dt <= 0) continue;
      const dOffset = next.offset - curr.offset;
      const tCurr = Math.round(curr.t * 1000) / 1000;
      const tNext = Math.round(next.t * 1000) / 1000;
      const lerp = dOffset === 0
        ? String(curr.offset)
        : `${curr.offset}+${dOffset}*(t-${tCurr})/${dt}`;
      expr = `if(lt(t\\,${tNext})\\,${lerp}\\,${expr})`;
    }
  }

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
        cropFilter = buildFaceTrackCropFilter(trackData.keyframes, width, height, w, h, trackData.cuts);
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
      execSync(cmd, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });
      const size = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ ${size} MB → reel-${id}-cropped.mp4`);
    } catch (e) {
      console.error(`   ❌ Crop failed for reel-${id}:`, e.stderr?.toString().slice(-500) || e.message);
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
