#!/usr/bin/env node
/**
 * Analyze transcript for YouTube clips (4-20 min segments).
 * Separate from analyze.js to avoid overcrowding the LLM prompt.
 * Reads:  episodes/{slug}/transcript.json
 * Writes: episodes/{slug}/clips-analysis.json
 *         episodes/{slug}/clips/clip-XX-thumb.png (thumbnails)
 *
 * Usage:
 *   node analyze-clips.js --slug <slug> [--force] [--resume]
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const llm = require("./llm");
const prompts = require("./prompts");
const { formatTimestamp, loadTranscript, formatTranscriptForPrompt, findSegmentByText, EPISODES_DIR } = require("./utils");

const FONTS_DIR = path.join(__dirname, "fonts");
const CLI_ARGS = process.argv.slice(2);

/**
 * Generate a YouTube-style thumbnail with Arabic text on purple background strip.
 */
function generateThumbnail(videoPath, outputPath, text, timestampSec) {
  const fontPath = path.join(FONTS_DIR, "SomarSans-Bold.otf");
  if (!fs.existsSync(fontPath)) {
    console.log("   ⚠️  Font not found, skipping thumbnail");
    return false;
  }

  // Use temp dir to avoid special chars in paths
  const os = require("os");
  const tmpDir = os.tmpdir();
  const tmpFrame = path.join(tmpDir, "tajarib-thumb-frame.png");
  const tmpOut = path.join(tmpDir, "tajarib-thumb-out.png");
  const tmpFont = path.join(tmpDir, "tajarib-thumb-font.otf");

  try {
    // Copy font to temp
    fs.copyFileSync(fontPath, tmpFont);

    // Extract a frame from ~30 sec into the clip for a good thumbnail
    const seekTo = Math.max(0, timestampSec + 30);
    execFileSync("ffmpeg", [
      "-y", "-ss", String(seekTo), "-i", videoPath,
      "-vframes", "1", "-q:v", "2",
      "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
      tmpFrame
    ], { stdio: "pipe" });

    // Overlay purple text bar with Arabic text
    const escapedText = text.replace(/'/g, "'\\''").replace(/:/g, "\\:");
    const escapedFont = tmpFont.replace(/'/g, "'\\''").replace(/:/g, "\\:");
    // Purple bar at bottom-center with bold text
    const filter = [
      // Semi-transparent purple bar
      `drawbox=x=0:y=ih-280:w=iw:h=200:color=0xa855f7@0.88:t=fill`,
      // Main text centered on the bar
      `drawtext=fontfile='${escapedFont}':text='${escapedText}':fontsize=80:fontcolor=white:x=(w-text_w)/2:y=h-230:borderw=3:bordercolor=0x7c3aed`
    ].join(",");

    execFileSync("ffmpeg", [
      "-y", "-i", tmpFrame,
      "-vf", filter,
      "-q:v", "2", tmpOut
    ], { stdio: "pipe" });

    // Copy result back
    fs.copyFileSync(tmpOut, outputPath);
    return true;
  } catch (e) {
    console.log(`   ⚠️  Thumbnail generation failed: ${e.message}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFrame); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
    try { fs.unlinkSync(tmpFont); } catch {}
  }
}

const SYSTEM_PROMPT = prompts.load("analyze-clips-system");

async function analyzeClips(slug, force = false) {
  const outputPath = path.join(EPISODES_DIR, slug, "clips-analysis.json");

  if (fs.existsSync(outputPath) && !force) {
    console.log(`⏭️  Clips analysis already exists: ${outputPath}`);
    console.log("   Use --force to re-analyze.");
    return outputPath;
  }

  console.log(`🎬 Analyzing episode for YouTube clips: ${slug}`);
  const transcript = loadTranscript(slug);
  console.log(`📄 Transcript: ${transcript.segment_count} segments, ${Math.round(transcript.duration_seconds / 60)} min`);

  const formattedTranscript = formatTranscriptForPrompt(transcript);

  const userMessage = prompts.load("analyze-clips-user", {
    durationMinutes: Math.round(transcript.duration_seconds / 60),
    formattedTranscript,
  });

  const epDir = path.join(EPISODES_DIR, slug);
  const isResume = CLI_ARGS.includes("--resume");
  let rawContent;
  let elapsed = "0";
  let tokenInfo = { input: 0, output: 0, total: 0 };
  let modelName = "manual";

  if (isResume) {
    const responsePath = path.join(epDir, "llm-clips-response.txt");
    if (!fs.existsSync(responsePath)) {
      console.error("❌ No llm-clips-response.txt found for resume.");
      process.exit(1);
    }
    rawContent = fs.readFileSync(responsePath, "utf8");
    console.log("📋 Using manually provided LLM response");
  } else {
    if (!llm.hasKey()) {
      console.log("📋 No API key found — entering manual LLM mode");
      const promptData = {
        step: "analyze-clips",
        system: SYSTEM_PROMPT,
        user: userMessage,
        expectedFormat: "json"
      };
      fs.writeFileSync(path.join(epDir, "llm-prompt.json"), JSON.stringify(promptData, null, 2), "utf8");
      console.log("📄 Prompt saved to llm-prompt.json — awaiting manual response");
      process.exit(42);
    }

    const config = llm.getConfig();
    console.log(`🤖 Sending to ${config.model || 'default model'} for clips analysis...`);
    const startTime = Date.now();

    const response = await llm.chat({
      system: SYSTEM_PROMPT,
      user: userMessage,
      maxTokens: 4096,
    });

    elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    rawContent = response.text;
    modelName = response.model;
    tokenInfo = response.usage;
  }

  // Parse JSON response
  let analysis;
  try {
    const cleaned = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    analysis = JSON.parse(cleaned);
  } catch (e) {
    console.error("❌ Failed to parse LLM response as JSON:");
    console.error(rawContent.slice(0, 500));
    process.exit(1);
  }

  // Resolve text references to timestamps
  if (analysis.clips) {
    console.log("🔗 Resolving text references to precise timestamps...");
    for (const clip of analysis.clips) {
      if (clip.text_start) {
        const t = findSegmentByText(transcript.segments, clip.text_start);
        if (t !== null) clip.start = formatTimestamp(t);
        delete clip.text_start;
      }
      if (clip.text_end) {
        const t = findSegmentByText(transcript.segments, clip.text_end);
        if (t !== null) clip.end = formatTimestamp(t);
        delete clip.text_end;
      }
    }
    analysis.clips = analysis.clips.filter(c => c.start && c.end);
    console.log(`   ✅ Resolved: ${analysis.clips.length} clips`);
  }

  // Generate thumbnails
  const clipsDir = path.join(epDir, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });

  // Find the raw video for frame extraction
  const files = fs.readdirSync(epDir);
  const rawVideo = files.find(f => /\.(mp4|mkv|mov)$/i.test(f) && !f.includes("reel") && !f.includes("final") && !f.includes("clip"));

  if (rawVideo && analysis.clips) {
    const videoPath = path.join(epDir, rawVideo);
    console.log(`\n🖼️  Generating thumbnails...`);
    for (const clip of analysis.clips) {
      const padded = String(clip.id).padStart(2, "0");
      const thumbPath = path.join(clipsDir, `clip-${padded}-thumb.png`);
      // Parse start timestamp to seconds for seek
      const parts = clip.start.split(":").map(Number);
      const startSec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      if (generateThumbnail(videoPath, thumbPath, clip.thumbnail_text || clip.title, startSec)) {
        console.log(`   ✅ clip-${padded}-thumb.png — "${clip.thumbnail_text}"`);
        clip.thumbnail = `clips/clip-${padded}-thumb.png`;
      }
    }
  }

  // Save
  const output = {
    slug,
    analyzed_at: new Date().toISOString(),
    model: modelName,
    tokens: tokenInfo,
    duration_minutes: Math.round(transcript.duration_seconds / 60),
    ...analysis
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`\n✅ Clips analysis done in ${elapsed}s`);
  console.log(`   Clips: ${analysis.clips?.length || 0}`);
  console.log(`   Tokens used: ${output.tokens.total.toLocaleString()}`);
  console.log(`📄 Saved: ${outputPath}`);
  return outputPath;
}

// CLI
const slugIdx = CLI_ARGS.indexOf("--slug");
const force = CLI_ARGS.includes("--force");
if (slugIdx === -1 || !CLI_ARGS[slugIdx + 1]) {
  console.error("Usage: node analyze-clips.js --slug <episode-slug> [--force] [--resume]");
  process.exit(1);
}
const slug = CLI_ARGS[slugIdx + 1];
analyzeClips(slug, force).catch(err => { console.error("❌", err.message); process.exit(1); });
