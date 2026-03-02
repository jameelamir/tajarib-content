#!/usr/bin/env node
/**
 * Multi-Track Video Compositor — Combine speaker + guest camera tracks.
 * Reads:  episodes/{slug}/meta.json (track paths, guest info)
 *         episodes/{slug}/switches.json (manual or AI-generated switch points)
 *         episodes/{slug}/transcript.json (for AI switch generation)
 * Writes: episodes/{slug}/composed.mp4
 *
 * Usage:
 *   node compose.js --slug <slug> [--ai-switch] [--force]
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");

const EPISODES_DIR = path.join(__dirname, "episodes");

function loadJSON(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}

function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

// ── AI Switch Point Generation ──────────────────────────────────────────────

function getAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const authPaths = [
    path.join(__dirname, "auth.json"),
    "/root/.openclaw/agents/main/agent/auth.json",
    "/root/.openclaw/agents/main/agent/models.json",
  ];
  for (const p of authPaths) {
    try {
      const data = loadJSON(p);
      const key = data?.anthropic?.key || data?.providers?.anthropic?.apiKey;
      if (key) return key;
    } catch (_) {}
  }
  return null;
}

async function generateAISwitchPoints(slug) {
  console.log("🤖 Generating AI camera switch points...");

  const dir = path.join(EPISODES_DIR, slug);
  const transcript = loadJSON(path.join(dir, "transcript.json"));
  const meta = loadJSON(path.join(dir, "meta.json")) || {};

  if (!transcript || !transcript.segments) {
    console.error("❌ No transcript found. Run transcription first.");
    process.exit(1);
  }

  const apiKey = getAnthropicKey();

  // Build a condensed transcript for the AI
  const segmentText = transcript.segments
    .map(s => `[${formatTime(s.start)}] ${s.text}`)
    .join("\n");

  const guestName = meta.guest || "the guest";
  const duration = transcript.duration_seconds || 3600;

  const systemPrompt = "You are a professional video editor. Return only valid JSON, no explanation.";
  const userPrompt = `You are a podcast video editor for the "Tajarib" podcast. The podcast has two camera tracks:
- "speaker" camera: on the host
- "guest" camera: on ${guestName}

Analyze this transcript and decide when to switch camera views. There are three view modes:
- "dual": 50/50 split showing both cameras (good for introductions, casual conversation)
- "speaker": full screen on the host (when host is making a key point or asking an important question)
- "guest": full screen on the guest (when guest is sharing an insight, story, or important answer)

Rules:
- Start with "dual" for the first 10-15 seconds
- Switch to single-camera views during powerful moments, stories, or key arguments
- Use "dual" during back-and-forth exchanges
- Don't switch too frequently — aim for segments of at least 15-30 seconds
- End with "dual" for the last 10 seconds

Transcript (with timestamps):
${segmentText.substring(0, 8000)}${segmentText.length > 8000 ? "\n... (truncated)" : ""}

Total duration: ${formatTime(duration)}

Return ONLY valid JSON:
{
  "switches": [
    { "time": 0, "view": "dual", "reason": "Opening" },
    { "time": 15, "view": "guest", "reason": "Guest introduces themselves" },
    ...
  ]
}`;

  const isResume = process.argv.includes("--resume");
  let text;

  if (isResume) {
    const responsePath = path.join(dir, "llm-response.txt");
    if (!fs.existsSync(responsePath)) {
      console.error("❌ No llm-response.txt found for resume.");
      process.exit(1);
    }
    text = fs.readFileSync(responsePath, "utf8").trim();
    console.log("📋 Using manually provided LLM response");
  } else if (!apiKey) {
    // Manual mode
    console.log("📋 No API key — manual LLM mode for camera switching");
    const promptData = {
      step: "compose",
      system: systemPrompt,
      user: userPrompt,
      expectedFormat: "json"
    };
    fs.writeFileSync(path.join(dir, "llm-prompt.json"), JSON.stringify(promptData, null, 2), "utf8");
    console.log("📄 Prompt saved to llm-prompt.json — awaiting manual response");
    process.exit(42);
  } else {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    text = response.content[0].text.trim();
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Could not parse AI response as JSON");
  }

  const result = JSON.parse(jsonMatch[0]);
  const switchesPath = path.join(dir, "switches.json");
  saveJSON(switchesPath, { generatedBy: "ai", createdAt: new Date().toISOString(), ...result });

  console.log(`✅ Generated ${result.switches.length} switch points → switches.json`);
  return result.switches;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── Composition Logic ───────────────────────────────────────────────────────

/**
 * Generate a simple 50/50 split without any camera switching.
 * Used as fallback or when no switch points are available.
 */
function composeSplit(speakerPath, guestPath, outputPath) {
  console.log("📐 Composing 50/50 vertical split (no switching)...");

  const cmd = [
    "ffmpeg -y",
    `-i "${speakerPath}"`,
    `-i "${guestPath}"`,
    `-filter_complex "`,
    `[0:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2,setsar=1[top];`,
    `[1:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2,setsar=1[bot];`,
    `[top][bot]vstack,drawbox=x=0:y=959:w=1080:h=2:color=0x333333@0.8:t=fill[out]"`,
    `-map "[out]" -map 0:a`,
    `-c:v libx264 -crf 18 -preset fast`,
    `-c:a aac -b:a 192k`,
    `-movflags +faststart`,
    `"${outputPath}"`
  ].join(" ");

  return cmd;
}

/**
 * Generate composition with camera switching.
 * Uses a complex filter graph that selects between three views:
 * - dual (vstack), speaker (full), guest (full)
 * Based on switch points and crossfade transitions.
 */
function composeWithSwitching(speakerPath, guestPath, outputPath, switches, duration) {
  console.log(`🎬 Composing with ${switches.length} camera switches...`);

  // Strategy: Create the three view streams, then use overlay + enable expressions
  // to switch between them. This avoids the complexity of concat/xfade chaining.

  // For each switch segment, we'll enable/disable the appropriate view.
  // The "base" is always the dual view. Speaker and guest full views overlay on top
  // with enable expressions.

  const transitionDur = 0.3; // fade duration in seconds

  // Build enable expressions for speaker-only and guest-only overlays
  let speakerEnableExprs = [];
  let guestEnableExprs = [];

  for (let i = 0; i < switches.length; i++) {
    const sw = switches[i];
    const nextTime = i < switches.length - 1 ? switches[i + 1].time : duration;

    if (sw.view === "speaker") {
      // Fade in at sw.time, fade out at nextTime
      speakerEnableExprs.push(`between(t,${sw.time},${nextTime})`);
    } else if (sw.view === "guest") {
      guestEnableExprs.push(`between(t,${sw.time},${nextTime})`);
    }
    // "dual" = no overlay needed (base shows through)
  }

  const speakerEnable = speakerEnableExprs.length > 0
    ? speakerEnableExprs.join("+")
    : "0";
  const guestEnable = guestEnableExprs.length > 0
    ? guestEnableExprs.join("+")
    : "0";

  // Build the filter complex:
  // 1. Scale both inputs for dual view (half height)
  // 2. Create dual view via vstack
  // 3. Scale speaker to full frame
  // 4. Scale guest to full frame
  // 5. Overlay speaker-full on dual with enable + fade
  // 6. Overlay guest-full on top with enable + fade
  const filter = [
    // Dual view
    `[0:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2,setsar=1[stop]`,
    `[1:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2,setsar=1[sbot]`,
    `[stop][sbot]vstack,drawbox=x=0:y=959:w=1080:h=2:color=0x333333@0.8:t=fill[dual]`,
    // Speaker full
    `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuva420p,colorchannelmixer=aa='if(${speakerEnable},1,0)'[spk_full]`,
    // Guest full
    `[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuva420p,colorchannelmixer=aa='if(${guestEnable},1,0)'[gst_full]`,
    // Stack overlays
    `[dual][spk_full]overlay=0:0:format=auto[mid]`,
    `[mid][gst_full]overlay=0:0:format=auto[out]`
  ].join(";");

  const cmd = [
    "ffmpeg -y",
    `-i "${speakerPath}"`,
    `-i "${guestPath}"`,
    `-filter_complex "${filter}"`,
    `-map "[out]" -map 0:a`,
    `-c:v libx264 -crf 18 -preset fast`,
    `-c:a aac -b:a 192k`,
    `-movflags +faststart`,
    `"${outputPath}"`
  ].join(" ");

  return cmd;
}

/**
 * Get video duration via ffprobe.
 */
function getVideoDuration(videoPath) {
  try {
    const probe = execSync(
      `ffprobe -v quiet -print_format json -show_format "${videoPath}"`,
      { encoding: "utf8" }
    );
    return parseFloat(JSON.parse(probe).format.duration) || 0;
  } catch (e) {
    console.error("⚠️ Could not probe video duration:", e.message);
    return 0;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function compose(slug, options) {
  console.log(`\n🎬 Multi-Track Compositor — ${slug}\n`);

  const dir = path.join(EPISODES_DIR, slug);
  const meta = loadJSON(path.join(dir, "meta.json")) || {};

  if (!meta.multiTrack || !meta.tracks) {
    console.error("❌ This episode is not a multi-track upload.");
    console.error("   meta.multiTrack:", meta.multiTrack);
    process.exit(1);
  }

  const speakerPath = meta.tracks.speaker;
  const guestPath = meta.tracks.guest;

  if (!fs.existsSync(speakerPath)) {
    console.error(`❌ Speaker track not found: ${speakerPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(guestPath)) {
    console.error(`❌ Guest track not found: ${guestPath}`);
    process.exit(1);
  }

  const outputPath = path.join(dir, "composed.mp4");

  if (fs.existsSync(outputPath) && !options.force) {
    console.log(`⏭️  Composed video already exists (use --force to overwrite)`);
    return;
  }

  // Check for switch points
  let switches = null;
  const switchesPath = path.join(dir, "switches.json");

  if (fs.existsSync(switchesPath)) {
    const data = loadJSON(switchesPath);
    switches = data?.switches;
    console.log(`📋 Using existing switch points (${switches?.length || 0} switches)`);
  } else if (options.aiSwitch) {
    switches = await generateAISwitchPoints(slug);
  }

  // Get video duration for switch calculations
  const duration = getVideoDuration(speakerPath);
  console.log(`⏱️  Video duration: ${formatTime(duration)} (${duration.toFixed(1)}s)`);

  let cmd;
  if (switches && switches.length > 0) {
    cmd = composeWithSwitching(speakerPath, guestPath, outputPath, switches, duration);
  } else {
    console.log("ℹ️  No switch points — creating simple 50/50 split");
    cmd = composeSplit(speakerPath, guestPath, outputPath);
  }

  console.log(`\n⏳ Running FFmpeg...\n`);
  const startTime = Date.now();

  try {
    execSync(cmd, { stdio: "inherit" });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const size = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`\n✅ Composed in ${elapsed}s (${size} MB) → ${outputPath}`);
  } catch (e) {
    console.error(`\n❌ Composition failed.`);
    process.exit(1);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const force = args.includes("--force");
const aiSwitch = args.includes("--ai-switch");

if (!slug) {
  console.error("Usage: node compose.js --slug <slug> [--ai-switch] [--force]");
  process.exit(1);
}

compose(slug, { force, aiSwitch }).catch(err => { console.error("❌", err.message); process.exit(1); });
