#!/usr/bin/env node
/**
 * Generate SRT subtitles from word-level transcript and burn into video.
 * Reads:  episodes/{slug}/transcript.json + analysis.json (for reel times)
 * Writes: episodes/{slug}/reels/reel-01.srt + reel-01-subtitled.mp4
 *
 * Usage:
 *   node subtitle.js --slug test-reel [--force]
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

function formatSRTTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// Group words into subtitle chunks (max ~6 words or 2 seconds per subtitle)
function generateSRT(words, startOffset = 0) {
  const chunks = [];
  let current = { words: [], start: null, end: null };

  for (const w of words) {
    const adjustedStart = w.start - startOffset;
    const adjustedEnd = w.end - startOffset;

    if (adjustedStart < 0) continue; // skip words before reel start

    if (current.start === null) current.start = adjustedStart;
    current.words.push(w.word.trim());
    current.end = adjustedEnd;

    // Break chunk after ~6 words or 2 seconds
    if (current.words.length >= 6 || (current.end - current.start) >= 2) {
      chunks.push({ text: current.words.join(" "), start: current.start, end: current.end });
      current = { words: [], start: null, end: null };
    }
  }

  // Push remaining
  if (current.words.length > 0) {
    chunks.push({ text: current.words.join(" "), start: current.start, end: current.end });
  }

  // Generate SRT format
  return chunks.map((chunk, i) => {
    return `${i + 1}\n${formatSRTTime(chunk.start)} --> ${formatSRTTime(chunk.end)}\n${chunk.text}\n`;
  }).join("\n");
}

async function subtitle(slug, force = false) {
  const dir = path.join(EPISODES_DIR, slug);
  const transcriptPath = path.join(dir, "transcript.json");
  const analysisPath = path.join(dir, "analysis.json");
  const reelsDir = path.join(dir, "reels");

  if (!fs.existsSync(transcriptPath)) {
    console.error("❌ No transcript.json. Run transcribe.py first.");
    process.exit(1);
  }

  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  const analysis = fs.existsSync(analysisPath) ? JSON.parse(fs.readFileSync(analysisPath, "utf8")) : null;
  const reels = analysis?.reels || [];

  if (reels.length === 0) {
    console.log("⚠️  No reels found in analysis. Generating full-video subtitles instead.");
    // Generate SRT for the entire video
    const srtContent = generateSRT(transcript.words, 0);
    const srtPath = path.join(dir, "full.srt");
    fs.writeFileSync(srtPath, srtContent, "utf8");
    console.log(`✅ Full video SRT: ${srtPath}`);
    return;
  }

  fs.mkdirSync(reelsDir, { recursive: true });

  console.log(`📝 Generating subtitles for ${reels.length} reels...`);

  for (const reel of reels) {
    const reelId = String(reel.id).padStart(2, "0");
    const srtPath = path.join(reelsDir, `reel-${reelId}.srt`);
    const videoPath = path.join(reelsDir, `reel-${reelId}.mp4`);
    const subtitledPath = path.join(reelsDir, `reel-${reelId}-subtitled.mp4`);

    if (!fs.existsSync(videoPath)) {
      console.log(`⏭️  Reel ${reel.id}: video not cut yet. Run cut.js first.`);
      continue;
    }

    if (fs.existsSync(subtitledPath) && !force) {
      console.log(`⏭️  Reel ${reel.id}: subtitled video already exists.`);
      continue;
    }

    const startSec = toSeconds(reel.start);
    const endSec = toSeconds(reel.end);

    // Get words in this reel's time range
    const reelWords = transcript.words.filter(w => w.start >= startSec && w.end <= endSec);
    const srtContent = generateSRT(reelWords, startSec);

    fs.writeFileSync(srtPath, srtContent, "utf8");
    console.log(`   📄 Reel ${reel.id}: SRT generated (${srtContent.split("\n\n").length} subtitles)`);

    // Burn subtitles into video with FFmpeg
    console.log(`   🔥 Burning subtitles into video...`);
    
    // Escape SRT path for FFmpeg
    const escapedSRT = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

    const cmd = [
      "ffmpeg -y",
      `-i "${videoPath}"`,
      `-vf "subtitles='${escapedSRT}':force_style='FontName=Arial,FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Bold=1,Alignment=2'"`,
      `-c:a copy`,
      `"${subtitledPath}"`
    ].join(" ");

    try {
      execSync(cmd, { stdio: "pipe" });
      const size = (fs.statSync(subtitledPath).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ ${size} MB → ${path.basename(subtitledPath)}`);
    } catch (e) {
      console.error(`   ❌ Subtitle burn failed for reel ${reel.id}:`, e.stderr?.toString() || e.message);
    }
  }

  console.log(`\n✅ Subtitled reels saved to: ${reelsDir}`);
}

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const force = args.includes("--force");

if (!slug) {
  console.error("Usage: node subtitle.js --slug <slug> [--force]");
  process.exit(1);
}
subtitle(slug, force).catch(err => { console.error("❌", err.message); process.exit(1); });
