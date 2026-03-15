#!/usr/bin/env node
/**
 * Overlay Compositor — Apply CG lower-thirds, sponsor, logo, and CTA overlays.
 * Reads:  episodes/{slug}/meta.json, episodes/{slug}/overlay-config.json
 * Input:  A video file (subtitled reel or raw video)
 * Writes: episodes/{slug}/reels/reel-XX-final.mp4 (or full-final.mp4)
 *
 * Usage:
 *   node overlay.js --slug <slug> --config         (use overlay-config.json)
 *   node overlay.js --slug <slug> --all             (legacy: apply all with defaults)
 *   node overlay.js --slug <slug> [--lower-third] [--sponsor] [--logo] [--force]
 */

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const EPISODES_DIR = path.join(__dirname, "episodes");
const ASSETS_DIR = path.join(__dirname, "assets");
const FONTS_DIR = path.join(__dirname, "fonts");

function loadJSON(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}

/**
 * Probe video dimensions via ffprobe.
 */
function probeVideoDimensions(videoPath) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", videoPath], { stdio: "pipe" }).toString().trim();
    const [w, h] = out.split("x").map(Number);
    return { width: w || 1920, height: h || 1080 };
  } catch (_) {
    return { width: 1920, height: 1080 };
  }
}

/**
 * Build the FFmpeg drawtext filter for a lower-third CG.
 */
function buildLowerThirdFilter(guestName, guestRole, startTime, endTime, videoHeight) {
  const fontPath = path.join(FONTS_DIR, "SomarSans-Bold.otf");
  const escapedFont = fontPath.replace(/'/g, "'\\''").replace(/:/g, "\\:");
  const escName = guestName.replace(/'/g, "'\\''").replace(/:/g, "\\:").replace(/\\/g, "\\\\");
  const escRole = guestRole.replace(/'/g, "'\\''").replace(/:/g, "\\:").replace(/\\/g, "\\\\");

  const fadeIn = 0.4;
  const fadeOut = 0.4;
  const holdStart = startTime + fadeIn;
  const holdEnd = endTime - fadeOut;

  // Use absolute pixel values instead of ih expressions (avoids FFmpeg 8.x filter_complex parsing issues)
  const boxY = videoHeight - 200;
  const nameY = videoHeight - 190;
  const roleY = videoHeight - 145;

  const bgFilter = `drawbox=x=0:y=${boxY}:w=520:h=120:color=0xa855f7@0.85:t=fill:enable='between(t,${startTime},${endTime})'`;
  const nameX = `if(lt(t\,${holdStart})\,-tw+(tw+20)*(t-${startTime})/${fadeIn}\,if(gt(t\,${holdEnd})\,20-(tw+20)*(t-${holdEnd})/${fadeOut}\,20))`;
  const nameFilter = `drawtext=fontfile='${escapedFont}':text='${escName}':fontsize=36:fontcolor=white:x='${nameX}':y=${nameY}:enable='between(t,${startTime},${endTime})'`;
  const roleX = `if(lt(t\,${holdStart})\,-tw+(tw+20)*(t-${startTime})/${fadeIn}\,if(gt(t\,${holdEnd})\,20-(tw+20)*(t-${holdEnd})/${fadeOut}\,20))`;
  const roleFilter = `drawtext=fontfile='${escapedFont}':text='${escRole}':fontsize=24:fontcolor=0xcccccc:x='${roleX}':y=${roleY}:enable='between(t,${startTime},${endTime})'`;

  return [bgFilter, nameFilter, roleFilter];
}

/**
 * Build FFmpeg drawtext filter for CTA text overlay.
 */
function buildCTATextFilter(ctaConfig, videoWidth, videoHeight) {
  const fontPath = path.join(FONTS_DIR, "SomarSans-Bold.otf");
  const escapedFont = fontPath.replace(/'/g, "'\\''").replace(/:/g, "\\:");
  const text = (ctaConfig.text || "").replace(/'/g, "'\\''").replace(/:/g, "\\:").replace(/\\/g, "\\\\");
  const fontSize = ctaConfig.fontSize || 28;
  const color = (ctaConfig.fontColor || "#ffffff").replace("#", "0x");
  const x = Math.round((ctaConfig.x / 100) * videoWidth);
  const y = Math.round((ctaConfig.y / 100) * videoHeight);
  const start = ctaConfig.startTime || 0;
  const end = ctaConfig.endTime || 10;

  return `drawtext=fontfile='${escapedFont}':text='${text}':fontsize=${fontSize}:fontcolor=${color}:x=${x}:y=${y}:enable='between(t,${start},${end})'`;
}

/**
 * Build gradient shadow vignette filters for logo contrast.
 * Creates semi-transparent black strips at top and bottom edges.
 */
// Shadow overlay is handled via shadow-reels.png with multiply blend

/**
 * Build overlay inputs and filter chain from config.
 * Returns { inputs, chain, lastLabel, inputIdx } for building filter_complex.
 */
function buildConfigOverlays(config, videoWidth, videoHeight) {
  const inputs = [];
  let chain = "";
  let lastLabel = null; // will be set by caller
  let inputIdx = 1;

  // Shadow is handled separately in the main overlay loop

  // Sponsor overlay
  if (config.sponsor && config.sponsor.enabled) {
    const sponsorFile = path.join(ASSETS_DIR, "sponsor.mov");
    if (fs.existsSync(sponsorFile)) {
      inputs.push(sponsorFile);
      const scale = config.sponsor.scale || 180;
      const x = Math.round((config.sponsor.x / 100) * videoWidth);
      const y = Math.round((config.sponsor.y / 100) * videoHeight);
      const fadeOut = 0.5; // fade out duration in seconds
      const sponsorEnd = 5;
      if (chain) chain += ";";
      chain += `[${inputIdx}:v]scale=${scale}:-1,format=rgba,fade=t=out:st=${sponsorEnd - fadeOut}:d=${fadeOut}:alpha=1[sponsor];{LAST}[sponsor]overlay=${x}:${y}:eof_action=pass[after_sponsor]`;
      lastLabel = "[after_sponsor]";
      inputIdx++;
    }
  }

  // Logo overlay (supports .mov, .png, .jpg)
  if (config.logo && config.logo.enabled) {
    const logoFile = [".mov", ".png", ".jpg", ".mp4"].map(ext => path.join(ASSETS_DIR, "logo" + ext)).find(f => fs.existsSync(f));
    if (logoFile) {
      inputs.push(logoFile);
      const scale = config.logo.scale || 140;
      const margin = 10;
      let x = Math.round((config.logo.x / 100) * videoWidth);
      const y = Math.round((config.logo.y / 100) * videoHeight);
      // Clamp so logo doesn't get cut off on the right
      x = Math.min(x, videoWidth - scale - margin);
      const isStatic = /\.(png|jpg|jpeg)$/i.test(logoFile);
      if (chain) chain += ";";
      chain += `[${inputIdx}:v]scale=${scale}:-1[logo];{LAST}[logo]overlay=${x}:${y}${isStatic ? "" : ":eof_action=pass"}[after_logo]`;
      lastLabel = "[after_logo]";
      inputIdx++;
    }
  }

  // CTA image overlay
  if (config.cta && config.cta.enabled && config.cta.mode === "image") {
    const ctaFile = findCTAAsset();
    if (ctaFile) {
      inputs.push(ctaFile);
      const scale = config.cta.scale || 200;
      const x = Math.round((config.cta.x / 100) * videoWidth);
      const y = Math.round((config.cta.y / 100) * videoHeight);
      const start = config.cta.startTime || 0;
      const end = config.cta.endTime || 10;
      if (chain) chain += ";";
      chain += `[${inputIdx}:v]scale=${scale}:-1[cta];{LAST}[cta]overlay=${x}:${y}:eof_action=pass:enable='between(t,${start},${end})'[after_cta]`;
      lastLabel = "[after_cta]";
      inputIdx++;
    }
  }

  return { inputs, chain, lastLabel, inputIdx };
}

function findCTAAsset() {
  for (const ext of [".png", ".mov", ".mp4", ".gif"]) {
    const p = path.join(ASSETS_DIR, "cta" + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve the {LAST} placeholder in chain with proper label tracking.
 */
function resolveChain(chain, startLabel) {
  let current = startLabel;
  return chain.replace(/\{LAST\}/g, () => {
    const label = current;
    // Find the next output label after this match
    const afterIdx = chain.indexOf("{LAST}");
    if (afterIdx !== -1) {
      const afterChain = chain.substring(afterIdx);
      const match = afterChain.match(/\[after_\w+\]/);
      if (match) current = match[0];
    }
    return label;
  });
}

async function overlay(slug, options) {
  console.log(`\n🎬 Overlay Compositor — ${slug}\n`);

  const dir = path.join(EPISODES_DIR, slug);
  const meta = loadJSON(path.join(dir, "meta.json")) || {};
  const reelsDir = path.join(dir, "reels");

  const guestName = meta.guest || "";
  const guestRole = meta.role || "";

  // Load config if --config mode
  let config = null;
  if (options.useConfig) {
    config = loadJSON(path.join(dir, "overlay-config.json"));
    if (!config) {
      console.log("⚠️  No overlay-config.json found, falling back to defaults.");
      config = {
        sponsor: { enabled: true, x: 1.3, y: 1.2, scale: 180 },
        logo: { enabled: true, x: 92.3, y: 1.2, scale: 140 },
        lowerThird: { enabled: true, startTime: 2, endTime: 8 },
        cta: { enabled: false, mode: "text", text: "", fontSize: 28, fontColor: "#ffffff", x: 50, y: 85, scale: 200, startTime: 50, endTime: 58 }
      };
    }
    console.log("📋 Using overlay config:");
    if (config.sponsor?.enabled) console.log(`   Sponsor: ${config.sponsor.scale}px at (${config.sponsor.x.toFixed(1)}%, ${config.sponsor.y.toFixed(1)}%)`);
    if (config.logo?.enabled) console.log(`   Logo: ${config.logo.scale}px at (${config.logo.x.toFixed(1)}%, ${config.logo.y.toFixed(1)}%)`);
    if (config.lowerThird?.enabled) console.log(`   Lower-third: ${config.lowerThird.startTime}s-${config.lowerThird.endTime}s`);
    if (config.cta?.enabled) console.log(`   CTA (${config.cta.mode}): ${config.cta.startTime}s-${config.cta.endTime}s`);
  }

  // Determine which overlays to apply
  const doLowerThird = config ? config.lowerThird?.enabled : options.lowerThird;
  const doSponsor = config ? config.sponsor?.enabled : options.sponsor;
  const doLogo = config ? config.logo?.enabled : options.logo;
  const doCTAText = config && config.cta?.enabled && config.cta.mode === "text";
  const doCTAImage = config && config.cta?.enabled && config.cta.mode === "image";

  if (doLowerThird && (!guestName || !guestRole)) {
    console.error("❌ Guest name and role required for lower-third. Set them in episode metadata.");
    process.exit(1);
  }

  // Find input videos — prefer subtitled, fall back to cropped, then raw reel
  const videos = [];

  if (fs.existsSync(reelsDir)) {
    // Collect all reel IDs
    const reelIds = fs.readdirSync(reelsDir)
      .filter(f => /^reel-\d+\.mp4$/.test(f))
      .map(f => f.match(/reel-(\d+)\.mp4/)[1])
      .sort();
    for (const id of reelIds) {
      const subtitled = path.join(reelsDir, `reel-${id}-subtitled.mp4`);
      const cropped = path.join(reelsDir, `reel-${id}-cropped.mp4`);
      const raw = path.join(reelsDir, `reel-${id}.mp4`);
      const input = fs.existsSync(subtitled) ? subtitled :
                    fs.existsSync(cropped) ? cropped : raw;
      videos.push({ input, output: path.join(reelsDir, `reel-${id}-final.mp4`), label: `reel-${id}` });
    }
  }

  const fullSubtitled = path.join(dir, "full-subtitled.mp4");
  if (fs.existsSync(fullSubtitled)) {
    videos.push({ input: fullSubtitled, output: path.join(dir, "full-final.mp4"), label: "full" });
  }

  if (videos.length === 0 && meta.mediaType === "reel_full") {
    const files = fs.readdirSync(dir);
    const rawVideo = files.find(f => /\.(mp4|mkv|mov)$/i.test(f) && !f.includes("final") && !f.includes("compressed"));
    if (rawVideo) {
      videos.push({ input: path.join(dir, rawVideo), output: path.join(dir, "full-final.mp4"), label: "full" });
    }
  }

  if (videos.length === 0) {
    console.error("❌ No videos found to overlay. Run subtitle step first (or upload a reel).");
    process.exit(1);
  }

  // Per-reel filter
  if (options.reelId) {
    const padded = options.reelId.padStart(2, "0");
    const targetLabel = `reel-${padded}`;
    const filtered = videos.filter(v => v.label === targetLabel);
    if (filtered.length === 0) {
      console.error(`❌ Reel ${options.reelId} not found among overlay-able videos.`);
      process.exit(1);
    }
    videos.length = 0;
    videos.push(...filtered);
    console.log(`🎨 Per-reel mode: processing only ${targetLabel}`);
  }

  console.log(`📼 Processing ${videos.length} video(s)...\n`);

  for (const video of videos) {
    if (fs.existsSync(video.output) && !options.force) {
      console.log(`⏭️  ${video.label}: already has overlay (use --force to overwrite)`);
      continue;
    }

    console.log(`🎨 ${video.label}: applying overlays...`);

    const dims = probeVideoDimensions(video.input);
    const vfFilters = [];

    // Shadow gradient PNG — injected as extra input, composited before everything else
    const shadowFile = path.join(ASSETS_DIR, "shadow-reels.png");
    let shadowInput = null;
    if (fs.existsSync(shadowFile)) {
      shadowInput = shadowFile;
    }

    // Lower-third: auto-generated drawtext (custom file handled below after movInputs init)
    let customLTFile = null;
    if (doLowerThird && config && config.lowerThird.mode === "custom" && config.lowerThird.customFile) {
      customLTFile = path.join(ASSETS_DIR, config.lowerThird.customFile);
      if (!fs.existsSync(customLTFile)) customLTFile = null;
    }
    if (doLowerThird && !customLTFile) {
      const ltStart = config ? config.lowerThird.startTime : 2;
      const ltEnd = config ? config.lowerThird.endTime : 8;
      vfFilters.push(...buildLowerThirdFilter(guestName, guestRole, ltStart, ltEnd, dims.height));
      console.log(`   📝 Lower-third: "${guestName}" / "${guestRole}" (${ltStart}s-${ltEnd}s)`);
    }

    // CTA text drawtext
    if (doCTAText && config.cta.text) {
      vfFilters.push(buildCTATextFilter(config.cta, dims.width, dims.height));
      console.log(`   📝 CTA text: "${config.cta.text}" (${config.cta.startTime}s-${config.cta.endTime}s)`);
    }

    // Image overlays (sponsor, logo, CTA image)
    let movInputs = [];
    let movChain = "";
    let movLastLabel = null;

    if (config) {
      const ovData = buildConfigOverlays(config, dims.width, dims.height);
      movInputs = ovData.inputs;
      movChain = ovData.chain;
      movLastLabel = ovData.lastLabel;
    } else {
      // Legacy --all / --sponsor / --logo mode
      if (doSponsor && fs.existsSync(path.join(ASSETS_DIR, "sponsor.mov"))) {
        movInputs.push(path.join(ASSETS_DIR, "sponsor.mov"));
        movChain += `[1:v]scale=180:-1[sponsor];{LAST}[sponsor]overlay=10:10:eof_action=pass:enable='between(t,0,5)'[after_sponsor]`;
        movLastLabel = "[after_sponsor]";
      }
      const legacyLogo = [".mov", ".png", ".jpg", ".mp4"].map(ext => path.join(ASSETS_DIR, "logo" + ext)).find(f => fs.existsSync(f));
      if (doLogo && legacyLogo) {
        const idx = movInputs.length + 1;
        movInputs.push(legacyLogo);
        if (movChain) movChain += ";";
        movChain += `[${idx}:v]scale=140:-1[logo];{LAST}[logo]overlay=W-w-10:10:eof_action=pass:enable='between(t,0,5)'[after_logo]`;
        movLastLabel = "[after_logo]";
      }
    }

    // Custom lower-third file overlay (added after other overlays)
    if (customLTFile) {
      const ltStart = config.lowerThird.startTime || 2;
      const ltEnd = config.lowerThird.endTime || 8;
      const ltScale = config.lowerThird.scale || 300;
      const ltX = Math.round((config.lowerThird.x || 5) / 100 * dims.width);
      const ltY = Math.round((config.lowerThird.y || 80) / 100 * dims.height);
      const isStatic = /\.(png|jpg|jpeg)$/i.test(customLTFile);
      const fadeOut = 0.5;
      movInputs.push(customLTFile);
      const idx = movInputs.length; // input index (1-based, since 0 is main video)
      if (movChain) movChain += ";";
      if (isStatic) {
        movChain += `[${idx}:v]scale=${ltScale}:-1[lt];{LAST}[lt]overlay=${ltX}:${ltY}:enable='between(t,${ltStart},${ltEnd})'[after_lt]`;
      } else {
        movChain += `[${idx}:v]scale=${ltScale}:-1,format=rgba,fade=t=out:st=${ltEnd - fadeOut}:d=${fadeOut}:alpha=1[lt];{LAST}[lt]overlay=${ltX}:${ltY}:eof_action=pass:enable='between(t,${ltStart},${ltEnd})'[after_lt]`;
      }
      movLastLabel = "[after_lt]";
      console.log(`   📝 Lower-third: custom file "${config.lowerThird.customFile}" (${ltStart}s-${ltEnd}s)`);
    }

    const hasMovOverlays = movInputs.length > 0;
    const hasDrawtext = vfFilters.length > 0;

    // Build shadow prefix: if shadow PNG exists, add it as input and prepend overlay step
    let shadowPrefix = "";
    let shadowInputs = [];
    let inputOffset = 0; // offset for other input indices when shadow is present
    if (shadowInput) {
      shadowInputs = [shadowInput];
      inputOffset = 1;
      shadowPrefix = `[1:v]scale=${dims.width}:${dims.height},format=rgba[shadow];[0:v][shadow]overlay=0:0[shadowed];`;
      // Reindex all overlay input references (they assumed input 1,2,3... but shadow took slot 1)
      if (movChain) {
        movChain = movChain.replace(/\[(\d+):v\]/g, (match, idx) => `[${parseInt(idx) + inputOffset}:v]`);
      }
    }
    const baseLabel = shadowInput ? "[shadowed]" : "[0:v]";

    // Attach overlay input paths so runFFmpeg can copy them to temp
    video._overlayInputs = [...shadowInputs, ...movInputs];

    if (hasMovOverlays && hasDrawtext) {
      // Both drawtext AND image overlays
      const drawtextChain = vfFilters.join(",");
      let fullChain = shadowPrefix + `${baseLabel}${drawtextChain}[drawn]`;
      // Resolve {LAST} placeholders sequentially starting from [drawn]
      let resolvedMov = movChain;
      let currentLabel = "[drawn]";
      while (resolvedMov.includes("{LAST}")) {
        const pos = resolvedMov.indexOf("{LAST}");
        resolvedMov = resolvedMov.replace("{LAST}", currentLabel);
        const afterPos = resolvedMov.substring(pos);
        const nextLabel = afterPos.match(/\[after_\w+\]/);
        if (nextLabel) currentLabel = nextLabel[0];
      }
      const outputLabels = resolvedMov.match(/\[after_\w+\]/g) || [];
      const finalLabel = outputLabels.length > 0 ? outputLabels[outputLabels.length - 1] : "[drawn]";
      fullChain += ";" + resolvedMov;

      const ffArgs = [
        "-y",
        "-i", video.input,
        ...shadowInputs.flatMap(f => ["-i", f]),
        ...movInputs.flatMap(f => ["-i", f]),
        "-filter_complex", fullChain,
        "-map", finalLabel, "-map", "0:a",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-c:a", "copy",
        video.output
      ];

      runFFmpeg(ffArgs, video);

    } else if (hasMovOverlays) {
      // Only image overlays — resolve {LAST} placeholders sequentially
      let resolved = movChain;
      let currentLabel = baseLabel;
      while (resolved.includes("{LAST}")) {
        const pos = resolved.indexOf("{LAST}");
        resolved = resolved.replace("{LAST}", currentLabel);
        // Find the next [after_*] label after this replacement point
        const afterPos = resolved.substring(pos);
        const nextLabel = afterPos.match(/\[after_\w+\]/);
        if (nextLabel) currentLabel = nextLabel[0];
      }
      let fullChain = shadowPrefix + resolved;
      const outputLabels = fullChain.match(/\[after_\w+\]/g) || [];
      const finalLabel = outputLabels.length > 0 ? outputLabels[outputLabels.length - 1] : baseLabel;

      const ffArgs = [
        "-y",
        "-i", video.input,
        ...shadowInputs.flatMap(f => ["-i", f]),
        ...movInputs.flatMap(f => ["-i", f]),
        "-filter_complex", fullChain,
        "-map", finalLabel, "-map", "0:a",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-c:a", "copy",
        video.output
      ];

      runFFmpeg(ffArgs, video);

    } else if (hasDrawtext) {
      // Only drawtext filters
      if (shadowInput) {
        // Shadow + drawtext
        const fullChain = shadowPrefix + `${baseLabel}${vfFilters.join(",")}[final]`;
        const ffArgs = [
          "-y",
          "-i", video.input,
          ...shadowInputs.flatMap(f => ["-i", f]),
          "-filter_complex", fullChain,
          "-map", "[final]", "-map", "0:a",
          "-c:v", "libx264", "-crf", "18", "-preset", "fast",
          "-c:a", "copy",
          video.output
        ];
        runFFmpeg(ffArgs, video);
      } else {
        const ffArgs = [
          "-y",
          "-i", video.input,
          "-vf", vfFilters.join(","),
          "-c:v", "libx264", "-crf", "18", "-preset", "fast",
          "-c:a", "copy",
          video.output
        ];
        runFFmpeg(ffArgs, video);
      }

    } else {
      console.log(`   ⏭️  No overlays to apply for ${video.label}`);
    }
  }

  console.log(`\n✅ Overlay complete for ${slug}`);
}

function runFFmpeg(ffArgs, video) {
  const os = require("os");
  const tmpDir = os.tmpdir();

  // Copy input files to /tmp to avoid special chars (!, spaces) breaking FFmpeg filters
  const tmpMap = {};
  const actualArgs = ffArgs.map(a => {
    // Map input files and overlay assets to temp paths
    if ((a === video.input || video._overlayInputs?.includes(a)) && !tmpMap[a]) {
      const ext = path.extname(a);
      const tmpPath = path.join(tmpDir, `tajarib-ovr-${Object.keys(tmpMap).length}${ext}`);
      fs.copyFileSync(a, tmpPath);
      tmpMap[a] = tmpPath;
    }
    if (tmpMap[a]) return tmpMap[a];
    // Output goes to temp too
    if (a === video.output) {
      const tmpOut = path.join(tmpDir, `tajarib-ovr-out.mp4`);
      tmpMap[video.output] = tmpOut;
      return tmpOut;
    }
    return a;
  });

  // Also remap font paths inside filter strings
  const fontDir = path.join(__dirname, "fonts");
  const tmpFontDir = path.join(tmpDir, "tajarib-fonts");
  let fontsCopied = false;
  for (let i = 0; i < actualArgs.length; i++) {
    if (typeof actualArgs[i] === "string" && actualArgs[i].includes(fontDir)) {
      if (!fontsCopied) {
        fs.mkdirSync(tmpFontDir, { recursive: true });
        fs.readdirSync(fontDir).forEach(f => fs.copyFileSync(path.join(fontDir, f), path.join(tmpFontDir, f)));
        fontsCopied = true;
      }
      actualArgs[i] = actualArgs[i].split(fontDir).join(tmpFontDir);
    }
  }

  const tmpOutput = tmpMap[video.output];
  const startTime = Date.now();
  try {
    execFileSync("ffmpeg", actualArgs, { stdio: "pipe" });
    // Success — copy result back
    fs.copyFileSync(tmpOutput, video.output);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const size = (fs.statSync(video.output).size / 1024 / 1024).toFixed(1);
    console.log(`   ✅ Done in ${duration}s (${size} MB) → ${path.basename(video.output)}`);
  } catch (e) {
    console.error(`   ❌ FFmpeg failed for ${video.label}:`, e.stderr?.toString().split("\n").slice(-10).join("\n") || e.message);
  } finally {
    // Clean up all temp files
    Object.values(tmpMap).forEach(f => { try { fs.unlinkSync(f); } catch {} });
    if (fontsCopied) {
      try { fs.readdirSync(tmpFontDir).forEach(f => fs.unlinkSync(path.join(tmpFontDir, f))); fs.rmdirSync(tmpFontDir); } catch {}
    }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const force = args.includes("--force");
const all = args.includes("--all");
const useConfig = args.includes("--config");
const reelId = get("--reel-id");

const options = {
  lowerThird: all || args.includes("--lower-third"),
  sponsor: all || args.includes("--sponsor"),
  logo: all || args.includes("--logo"),
  useConfig,
  force,
  reelId
};

if (!slug) {
  console.error("Usage: node overlay.js --slug <slug> [--config] [--all] [--lower-third] [--sponsor] [--logo] [--force]");
  process.exit(1);
}

overlay(slug, options).catch(err => { console.error("❌", err.message); process.exit(1); });
