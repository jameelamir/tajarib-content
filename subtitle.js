#!/usr/bin/env node
/**
 * Generate SRT subtitles from word-level transcript and burn into video.
 * Reads:  episodes/{slug}/transcript.json + analysis.json (for reel times)
 * Writes: episodes/{slug}/reels/reel-01.srt + reel-01-subtitled.mp4
 *
 * Usage:
 *   node subtitle.js --slug test-reel [--force] [--title-card]
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const EPISODES_DIR = path.join(__dirname, "episodes");

// Title card duration in seconds
const TITLE_DURATION = 5;

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

function formatASSTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// Generate ASS format with support for title card styling
function generateASS(words, startOffset = 0, titleCard = null) {
  const chunks = [];
  let current = { words: [], start: null, end: null };

  for (const w of words) {
    const adjustedStart = w.start - startOffset;
    const adjustedEnd = w.end - startOffset;

    if (adjustedStart < 0) continue;

    if (current.start === null) current.start = adjustedStart;
    current.words.push(w.word.trim());
    current.end = adjustedEnd;

    if (current.words.length >= 6 || (current.end - current.start) >= 2) {
      chunks.push({ text: current.words.join(" "), start: current.start, end: current.end });
      current = { words: [], start: null, end: null };
    }
  }

  if (current.words.length > 0) {
    chunks.push({ text: current.words.join(" "), start: current.start, end: current.end });
  }

  const dialogueLines = [];

  // Add title card dialogue (uses Title style with larger font)
  if (titleCard) {
    dialogueLines.push(`Dialogue: 0,${formatASSTime(0)},${formatASSTime(TITLE_DURATION)},Title,,0,0,0,,${titleCard}`);
  }

  // Add regular subtitle chunks (uses Default style)
  for (const chunk of chunks) {
    dialogueLines.push(`Dialogue: 0,${formatASSTime(chunk.start)},${formatASSTime(chunk.end)},Default,,0,0,0,,${chunk.text}`);
  }

  return `[Script Info]
Title: Reel Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,SomarSans-SemiBold,72,&H00FFFFFF,&H000000FF,&H00000000,&H009B30FF,1,0,0,0,100,100,0,0,4,0,0,2,60,60,150,1
Style: Default,SomarSans-SemiBold,52,&H00FFFFFF,&H000000FF,&H00000000,&H009B30FF,1,0,0,0,100,100,0,0,4,0,0,2,60,60,100,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogueLines.join("\n")}`;
}

// Group words into subtitle chunks (max ~6 words or 2 seconds per subtitle)
// If titleCard is provided, adds a title card at the beginning
function generateSRT(words, startOffset = 0, titleCard = null) {
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

  // Build SRT entries
  const entries = [];
  let entryNumber = 1;

  // Add title card if provided (shown for TILE_DURATION seconds from start)
  if (titleCard) {
    entries.push(`${entryNumber}\n${formatSRTTime(0)} --> ${formatSRTTime(TITLE_DURATION)}\n${titleCard}\n`);
    entryNumber++;
  }

  // Add regular subtitle chunks
  for (const chunk of chunks) {
    entries.push(`${entryNumber}\n${formatSRTTime(chunk.start)} --> ${formatSRTTime(chunk.end)}\n${chunk.text}\n`);
    entryNumber++;
  }

  return entries.join("\n");
}

async function subtitle(slug, force = false, titleCard = false) {
  console.log(`\n🎬 Subtitle Generator — ${slug}\n`);
  
  const dir = path.join(EPISODES_DIR, slug);
  const transcriptPath = path.join(dir, "transcript.json");
  const analysisPath = path.join(dir, "analysis.json");
  const reelsDir = path.join(dir, "reels");
  const metaPath = path.join(dir, "meta.json");

  console.log(`📁 Episode directory: ${dir}`);
  console.log(`📝 Transcript: ${transcriptPath}`);
  console.log(`📊 Analysis: ${analysisPath}`);
  
  if (!fs.existsSync(transcriptPath)) {
    console.error("❌ No transcript.json found. Run transcribe.py first.");
    process.exit(1);
  }
  console.log(`   ✅ Transcript exists (${(fs.statSync(transcriptPath).size / 1024).toFixed(1)} KB)`);

  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  console.log(`   📊 Found ${transcript.words?.length || 0} words in transcript`);

  const analysis = fs.existsSync(analysisPath) ? JSON.parse(fs.readFileSync(analysisPath, "utf8")) : null;
  const reels = analysis?.reels || [];
  console.log(`   📊 Found ${reels.length} reels in analysis`);

  // Get source video path
  let sourceVideo = path.join(dir, "raw.mov");
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.rawVideo) sourceVideo = meta.rawVideo;
  }

  if (reels.length === 0) {
    console.log("\n⚠️  No reels found in analysis. Will generate full-video subtitles.\n");
    
    // Generate SRT for the entire video
    console.log(`📝 Generating SRT from ${transcript.words?.length || 0} words...`);
    const srtContent = generateSRT(transcript.words, 0);
    const srtPath = path.join(dir, "full.srt");
    fs.writeFileSync(srtPath, srtContent, "utf8");
    console.log(`   ✅ SRT written: ${srtPath} (${srtContent.split("\n\n").length} subtitle blocks)`);

    // Burn subtitles into the full video
    const subtitledPath = path.join(dir, "full-subtitled.mp4");
    
    if (!fs.existsSync(sourceVideo)) {
      console.error(`❌ Source video not found: ${sourceVideo}`);
      console.log(`   Available files in directory:`);
      fs.readdirSync(dir).forEach(f => console.log(`      - ${f}`));
      process.exit(1);
    }
    console.log(`   ✅ Source video found: ${sourceVideo}`);

    if (fs.existsSync(subtitledPath) && !force) {
      console.log(`⏭️  Subtitled video already exists: ${subtitledPath}`);
      console.log(`   Use --force to overwrite.`);
      return;
    }

    console.log(`\n🔥 Burning subtitles into video...`);
    console.log(`   Input:  ${sourceVideo}`);
    console.log(`   SRT:    ${srtPath}`);
    console.log(`   Output: ${subtitledPath}`);
    
    // Escape SRT path for FFmpeg
    const escapedSRT = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

    const cmd = [
      "ffmpeg -y",
      `-i "${sourceVideo}"`,
      `-vf "subtitles='${escapedSRT}':force_style='FontName=SomarSans-SemiBold,FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H00000000,BackColour=&H800080,BorderStyle=4,Bold=1,Alignment=2,MarginV=50'"`,
      `-c:a copy`,
      `"${subtitledPath}"`
    ].join(" ");

    console.log(`\n⏳ Running ffmpeg (this may take a while)...`);
    const startTime = Date.now();
    
    try {
      execSync(cmd, { stdio: "inherit" });
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const size = (fs.statSync(subtitledPath).size / 1024 / 1024).toFixed(1);
      console.log(`\n✅ Done in ${duration}s`);
      console.log(`   📁 ${size} MB → ${subtitledPath}`);
    } catch (e) {
      console.error(`\n❌ Subtitle burn failed:`, e.stderr?.toString() || e.message);
      process.exit(1);
    }
    return;
  }

  fs.mkdirSync(reelsDir, { recursive: true });

  console.log(`\n📝 Processing ${reels.length} reels...\n`);

  for (const reel of reels) {
    const reelId = String(reel.id).padStart(2, "0");
    const subtitleExt = titleCard ? "ass" : "srt";
    const subtitlePath = path.join(reelsDir, `reel-${reelId}.${subtitleExt}`);
    const videoPath = path.join(reelsDir, `reel-${reelId}.mp4`);
    const subtitledPath = path.join(reelsDir, `reel-${reelId}-subtitled.mp4`);

    console.log(`\n📼 Reel ${reel.id} (${reel.start} → ${reel.end})`);

    if (!fs.existsSync(videoPath)) {
      console.log(`   ⏭️  Skipped: video not cut yet (run: node cut.js --slug ${slug})`);
      continue;
    }

    if (fs.existsSync(subtitledPath) && !force) {
      console.log(`   ⏭️  Skipped: subtitled video already exists (use --force to overwrite)`);
      continue;
    }

    const startSec = toSeconds(reel.start);
    const endSec = toSeconds(reel.end);

    // Get reel title from analysis (fallback to generic title)
    const reelTitle = reel.title || reel.hook || `Reel ${reel.id}`;

    // Get words in this reel's time range
    const reelWords = transcript.words.filter(w => w.start >= startSec && w.end <= endSec);
    
    // Generate subtitle file (ASS for title cards, SRT for regular)
    let subtitleContent;
    if (titleCard) {
      subtitleContent = generateASS(reelWords, startSec, reelTitle);
    } else {
      subtitleContent = generateSRT(reelWords, startSec, null);
    }

    fs.writeFileSync(subtitlePath, subtitleContent, "utf8");
    console.log(`   📝 ${subtitleExt.toUpperCase()} generated: ${subtitleContent.split("\n").filter(l => l.includes("Dialogue") || l.includes(" --> ")).length} subtitle blocks${titleCard ? ' (with 5s title card)' : ''}`);

    // Burn subtitles into video with FFmpeg
    console.log(`   🔥 Burning subtitles with ffmpeg...`);
    
    // Escape subtitle path for FFmpeg
    const escapedSubtitle = subtitlePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

    // For ASS, we don't need force_style as styles are embedded; for SRT we use force_style
    const vfFilter = titleCard 
      ? `subtitles='${escapedSubtitle}'`
      : `subtitles='${escapedSubtitle}':force_style='FontName=SomarSans-SemiBold,FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H00000000,BackColour=&H800080,BorderStyle=4,Bold=1,Alignment=2'`;

    const cmd = [
      "ffmpeg -y",
      `-i "${videoPath}"`,
      `-vf "${vfFilter}"`,
      `-c:a copy`,
      `"${subtitledPath}"`
    ].join(" ");

    const startTime = Date.now();
    try {
      execSync(cmd, { stdio: "inherit" });
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const size = (fs.statSync(subtitledPath).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ Done in ${duration}s (${size} MB)`);
    } catch (e) {
      console.error(`   ❌ Subtitle burn failed:`, e.stderr?.toString() || e.message);
    }
  }

  console.log(`\n✅ All done! Subtitled reels saved to: ${reelsDir}`);
}

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const force = args.includes("--force");
const titleCard = args.includes("--title-card");

if (!slug) {
  console.error("Usage: node subtitle.js --slug <slug> [--force] [--title-card]");
  process.exit(1);
}
subtitle(slug, force, titleCard).catch(err => { console.error("❌", err.message); process.exit(1); });
