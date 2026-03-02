#!/usr/bin/env node
/**
 * Overlay Compositor — Apply CG lower-thirds, sponsor, and logo overlays.
 * Reads:  episodes/{slug}/meta.json (guest, role, overlay settings)
 * Input:  A video file (subtitled reel or raw video)
 * Writes: episodes/{slug}/reels/reel-XX-final.mp4 (or full-final.mp4)
 *
 * Usage:
 *   node overlay.js --slug <slug> [--lower-third] [--sponsor] [--logo] [--force]
 *   node overlay.js --slug <slug> --all  (applies all available overlays)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const EPISODES_DIR = path.join(__dirname, "episodes");
const ASSETS_DIR = path.join(__dirname, "assets");
const FONTS_DIR = path.join(__dirname, "fonts");

// Default timing (seconds)
const LOWER_THIRD_START = 2;
const LOWER_THIRD_END = 8;
const OVERLAY_ANIM_START = 0;
const OVERLAY_ANIM_END = 5;

function loadJSON(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}

/**
 * Build the FFmpeg drawtext filter for a lower-third CG.
 * Slide-in from left, hold, slide-out to left.
 */
function buildLowerThirdFilter(guestName, guestRole, startTime, endTime) {
  const fontPath = path.join(FONTS_DIR, "SomarSans-SemiBold.otf");
  const escapedFont = fontPath.replace(/'/g, "'\\''").replace(/:/g, "\\:");

  // Escape text for FFmpeg (handle Arabic, colons, quotes)
  const escName = guestName.replace(/'/g, "'\\''").replace(/:/g, "\\:").replace(/\\/g, "\\\\");
  const escRole = guestRole.replace(/'/g, "'\\''").replace(/:/g, "\\:").replace(/\\/g, "\\\\");

  const fadeIn = 0.4;   // seconds for slide-in
  const fadeOut = 0.4;   // seconds for slide-out
  const holdStart = startTime + fadeIn;
  const holdEnd = endTime - fadeOut;

  // Background box: semi-transparent purple, slides in/out
  // Using drawbox with enable for the hold period, and drawtext x-animation for the slide
  const bgFilter = `drawbox=x=0:y=ih-200:w=520:h=120:color=0xa855f7@0.85:t=fill:enable='between(t,${startTime},${endTime})'`;

  // Guest name: large, white, with slide animation
  // x expression: slide from -text_w to 20 during fadeIn, hold at 20, slide out to -text_w during fadeOut
  const nameX = `if(lt(t\\,${holdStart})\\,-tw+(tw+20)*(t-${startTime})/${fadeIn}\\,if(gt(t\\,${holdEnd})\\,20-(tw+20)*(t-${holdEnd})/${fadeOut}\\,20))`;
  const nameFilter = `drawtext=fontfile='${escapedFont}':text='${escName}':fontsize=36:fontcolor=white:x='${nameX}':y=ih-190:enable='between(t,${startTime},${endTime})'`;

  // Guest role: smaller, lighter gray
  const roleX = `if(lt(t\\,${holdStart})\\,-tw+(tw+20)*(t-${startTime})/${fadeIn}\\,if(gt(t\\,${holdEnd})\\,20-(tw+20)*(t-${holdEnd})/${fadeOut}\\,20))`;
  const roleFilter = `drawtext=fontfile='${escapedFont}':text='${escRole}':fontsize=24:fontcolor=0xcccccc:x='${roleX}':y=ih-145:enable='between(t,${startTime},${endTime})'`;

  return [bgFilter, nameFilter, roleFilter];
}

/**
 * Build FFmpeg filter_complex for sponsor/logo MOV overlays.
 * Returns { filterComplex, inputs } where inputs are additional -i flags.
 */
function buildOverlayInputs(options) {
  const inputs = [];
  const filters = [];
  let inputIdx = 1; // 0 is the main video
  let lastLabel = "[0:v]";

  if (options.sponsor && fs.existsSync(path.join(ASSETS_DIR, "sponsor.mov"))) {
    inputs.push(`-i "${path.join(ASSETS_DIR, "sponsor.mov")}"`);
    const sponsorScale = `[${inputIdx}:v]scale=180:-1[sponsor]`;
    const sponsorOverlay = `${lastLabel}[sponsor]overlay=10:10:shortest=1:enable='between(t,${OVERLAY_ANIM_START},${OVERLAY_ANIM_END})'[after_sponsor]`;
    filters.push(sponsorScale, sponsorOverlay);
    lastLabel = "[after_sponsor]";
    inputIdx++;
  }

  if (options.logo && fs.existsSync(path.join(ASSETS_DIR, "logo.mov"))) {
    inputs.push(`-i "${path.join(ASSETS_DIR, "logo.mov")}"`);
    const logoScale = `[${inputIdx}:v]scale=140:-1[logo]`;
    const logoOverlay = `${lastLabel}[logo]overlay=W-w-10:10:shortest=1:enable='between(t,${OVERLAY_ANIM_START},${OVERLAY_ANIM_END})'[after_logo]`;
    filters.push(logoScale, logoOverlay);
    lastLabel = "[after_logo]";
    inputIdx++;
  }

  return { inputs, filters, lastLabel };
}

async function overlay(slug, options) {
  console.log(`\n🎬 Overlay Compositor — ${slug}\n`);

  const dir = path.join(EPISODES_DIR, slug);
  const meta = loadJSON(path.join(dir, "meta.json")) || {};
  const reelsDir = path.join(dir, "reels");

  const guestName = meta.guest || "";
  const guestRole = meta.role || "";

  if (options.lowerThird && (!guestName || !guestRole)) {
    console.error("❌ Guest name and role required for lower-third. Set them in episode metadata.");
    process.exit(1);
  }

  // Find input videos to process
  const videos = [];

  if (fs.existsSync(reelsDir)) {
    // Process subtitled reels
    const reelFiles = fs.readdirSync(reelsDir)
      .filter(f => f.endsWith("-subtitled.mp4"))
      .sort();

    for (const f of reelFiles) {
      const base = f.replace("-subtitled.mp4", "");
      videos.push({
        input: path.join(reelsDir, f),
        output: path.join(reelsDir, `${base}-final.mp4`),
        label: base
      });
    }
  }

  // Also check for full-subtitled.mp4
  const fullSubtitled = path.join(dir, "full-subtitled.mp4");
  if (fs.existsSync(fullSubtitled)) {
    videos.push({
      input: fullSubtitled,
      output: path.join(dir, "full-final.mp4"),
      label: "full"
    });
  }

  // For reel_full (no subtitles step), use raw video
  if (videos.length === 0 && meta.mediaType === "reel_full") {
    const files = fs.readdirSync(dir);
    const rawVideo = files.find(f => /\.(mp4|mkv|mov)$/i.test(f) && !f.includes("final") && !f.includes("compressed"));
    if (rawVideo) {
      videos.push({
        input: path.join(dir, rawVideo),
        output: path.join(dir, "full-final.mp4"),
        label: "full"
      });
    }
  }

  if (videos.length === 0) {
    console.error("❌ No videos found to overlay. Run subtitle step first (or upload a reel).");
    process.exit(1);
  }

  console.log(`📼 Processing ${videos.length} video(s)...\n`);

  for (const video of videos) {
    if (fs.existsSync(video.output) && !options.force) {
      console.log(`⏭️  ${video.label}: already has overlay (use --force to overwrite)`);
      continue;
    }

    console.log(`🎨 ${video.label}: applying overlays...`);

    // Build filter chain
    const vfFilters = [];

    // Lower-third drawtext filters
    if (options.lowerThird) {
      const ltFilters = buildLowerThirdFilter(guestName, guestRole, LOWER_THIRD_START, LOWER_THIRD_END);
      vfFilters.push(...ltFilters);
      console.log(`   📝 Lower-third: "${guestName}" / "${guestRole}" (${LOWER_THIRD_START}s-${LOWER_THIRD_END}s)`);
    }

    // Sponsor/logo overlays (require filter_complex with multiple inputs)
    const overlayData = buildOverlayInputs({ sponsor: options.sponsor, logo: options.logo });
    const hasMovOverlays = overlayData.inputs.length > 0;

    if (hasMovOverlays && vfFilters.length > 0) {
      // Both drawtext AND mov overlays — use filter_complex
      // First apply drawtext to main video, then overlay MOVs
      const drawtextChain = vfFilters.join(",");
      const allFilters = [`[0:v]${drawtextChain}[drawn]`, ...overlayData.filters.map(f => f.replace("[0:v]", "[drawn]").replace(overlayData.filters[0].includes("[0:v]") ? "[0:v]" : "", ""))];

      // Rebuild the filter chain properly
      let chain = `[0:v]${drawtextChain}[drawn]`;
      let lastLabel = "[drawn]";
      let inputIdx = 1;

      if (options.sponsor && fs.existsSync(path.join(ASSETS_DIR, "sponsor.mov"))) {
        chain += `;[${inputIdx}:v]scale=180:-1[sponsor];${lastLabel}[sponsor]overlay=10:10:shortest=1:enable='between(t,${OVERLAY_ANIM_START},${OVERLAY_ANIM_END})'[after_sponsor]`;
        lastLabel = "[after_sponsor]";
        inputIdx++;
      }

      if (options.logo && fs.existsSync(path.join(ASSETS_DIR, "logo.mov"))) {
        chain += `;[${inputIdx}:v]scale=140:-1[logo];${lastLabel}[logo]overlay=W-w-10:10:shortest=1:enable='between(t,${OVERLAY_ANIM_START},${OVERLAY_ANIM_END})'[after_logo]`;
        lastLabel = "[after_logo]";
        inputIdx++;
      }

      const cmd = [
        "ffmpeg -y",
        `-i "${video.input}"`,
        ...overlayData.inputs,
        `-filter_complex "${chain}"`,
        `-map "${lastLabel}" -map 0:a`,
        `-c:v libx264 -crf 18 -preset fast`,
        `-c:a copy`,
        `"${video.output}"`
      ].join(" ");

      runFFmpeg(cmd, video);

    } else if (hasMovOverlays) {
      // Only MOV overlays, no drawtext
      let chain = "";
      let lastLabel = "[0:v]";
      let inputIdx = 1;

      if (options.sponsor && fs.existsSync(path.join(ASSETS_DIR, "sponsor.mov"))) {
        chain += `[${inputIdx}:v]scale=180:-1[sponsor];${lastLabel}[sponsor]overlay=10:10:shortest=1:enable='between(t,${OVERLAY_ANIM_START},${OVERLAY_ANIM_END})'[after_sponsor]`;
        lastLabel = "[after_sponsor]";
        inputIdx++;
      }

      if (options.logo && fs.existsSync(path.join(ASSETS_DIR, "logo.mov"))) {
        if (chain) chain += ";";
        chain += `[${inputIdx}:v]scale=140:-1[logo];${lastLabel}[logo]overlay=W-w-10:10:shortest=1:enable='between(t,${OVERLAY_ANIM_START},${OVERLAY_ANIM_END})'[after_logo]`;
        lastLabel = "[after_logo]";
        inputIdx++;
      }

      const cmd = [
        "ffmpeg -y",
        `-i "${video.input}"`,
        ...overlayData.inputs,
        `-filter_complex "${chain}"`,
        `-map "${lastLabel}" -map 0:a`,
        `-c:v libx264 -crf 18 -preset fast`,
        `-c:a copy`,
        `"${video.output}"`
      ].join(" ");

      runFFmpeg(cmd, video);

    } else if (vfFilters.length > 0) {
      // Only drawtext filters (no MOV overlays)
      const cmd = [
        "ffmpeg -y",
        `-i "${video.input}"`,
        `-vf "${vfFilters.join(",")}"`,
        `-c:v libx264 -crf 18 -preset fast`,
        `-c:a copy`,
        `"${video.output}"`
      ].join(" ");

      runFFmpeg(cmd, video);

    } else {
      console.log(`   ⏭️  No overlays to apply for ${video.label}`);
    }
  }

  console.log(`\n✅ Overlay complete for ${slug}`);
}

function runFFmpeg(cmd, video) {
  const startTime = Date.now();
  try {
    execSync(cmd, { stdio: "pipe" });
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const size = (fs.statSync(video.output).size / 1024 / 1024).toFixed(1);
    console.log(`   ✅ Done in ${duration}s (${size} MB) → ${path.basename(video.output)}`);
  } catch (e) {
    console.error(`   ❌ FFmpeg failed for ${video.label}:`, e.stderr?.toString().split("\n").slice(-3).join("\n") || e.message);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const force = args.includes("--force");
const all = args.includes("--all");

const options = {
  lowerThird: all || args.includes("--lower-third"),
  sponsor: all || args.includes("--sponsor"),
  logo: all || args.includes("--logo"),
  force
};

if (!slug) {
  console.error("Usage: node overlay.js --slug <slug> [--lower-third] [--sponsor] [--logo] [--all] [--force]");
  process.exit(1);
}

overlay(slug, options).catch(err => { console.error("❌", err.message); process.exit(1); });
