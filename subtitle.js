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
const os = require("os");
const { execSync, execFileSync, spawnSync } = require("child_process");
const { toSeconds, EPISODES_DIR } = require("./utils");
const PYTHON_BIN = fs.existsSync(path.join(__dirname, ".venv", "bin", "python3"))
  ? path.join(__dirname, ".venv", "bin", "python3")
  : "python3";

// Title card duration in seconds
const TITLE_DURATION = 5;

// Transcribe a video clip with local Whisper and return word-level timestamps.
// Returns the words array (0-indexed relative to clip start), or null on failure.
function whisperTranscribeClip(clipPath, outputPath) {
  console.log(`   🎙️  Transcribing clip with local Whisper: ${path.basename(clipPath)}`);
  const result = spawnSync(PYTHON_BIN, [
    "-u", "transcribe.py", clipPath, "--slug", "temp", "--force", "--output", outputPath
  ], { cwd: __dirname, stdio: "inherit", timeout: 10 * 60 * 1000 });

  if (result.status !== 0) {
    console.error(`   ⚠️  Whisper transcription failed (exit ${result.status})`);
    return null;
  }

  try {
    const t = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    console.log(`   ✅ Whisper: ${t.words?.length || 0} words with word-level timestamps`);
    return t.words || [];
  } catch (e) {
    console.error(`   ⚠️  Failed to parse Whisper output: ${e.message}`);
    return null;
  }
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

// Probe video dimensions using ffprobe
function getVideoDimensions(videoPath) {
  try {
    const result = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`,
      { encoding: "utf8" }
    ).trim();
    const [width, height] = result.split(",").map(Number);
    if (width && height) return { width, height };
  } catch (e) {
    console.log(`   ⚠️  Could not probe video dimensions, defaulting to 1080x1920`);
  }
  return { width: 1080, height: 1920 };
}

// Close small gaps between consecutive subtitle chunks so there is no visual
// emptiness.  If the gap between two chunks is <= MAX_GAP_FILL seconds, extend
// the earlier chunk's end time to meet the next chunk's start time.
const MAX_GAP_FILL = 3; // seconds

function closeSubtitleGaps(chunks) {
  for (let i = 0; i < chunks.length - 1; i++) {
    const gap = chunks[i + 1].start - chunks[i].end;
    if (gap > 0 && gap <= MAX_GAP_FILL) {
      chunks[i].end = chunks[i + 1].start;
    }
  }
}

// Generate ASS format subtitles
// style: "animated" — highlight sweeps right-to-left beneath text (two layers)
//        "static"   — plain purple box behind text (single layer)
function generateASS(words, startOffset = 0, titleCard = null, videoDimensions = null, style = "animated") {
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

  closeSubtitleGaps(chunks);

  // Scale font sizes and margins relative to actual video dimensions
  const vd = videoDimensions || { width: 1080, height: 1920 };
  const scale = vd.height / 1920;
  const titleSize = Math.round(100 * scale);
  const defaultSize = Math.round(80 * scale);
  const marginLR = Math.round(60 * scale);
  const titleMarginV = Math.round(550 * scale);
  const defaultMarginV = Math.round(500 * scale);
  const highlightPad = Math.max(5, Math.round(12 * scale));
  const outline = Math.max(3, Math.round(5 * scale));

  const dialogueLines = [];

  if (style === "animated") {
    // Three layers per subtitle:
    //   Layer 0 — HighlightGlow: blurred dark box (same shape as highlight), soft shadow from the highlight
    //   Layer 1 — Highlight: purple box clipped to bottom half of text, animated RTL
    //   Layer 2 — Text: clean white text on top
    const W = vd.width;
    const H = vd.height;
    const glowBlur = Math.max(10, Math.round(25 * scale));
    const glowPad = Math.max(10, Math.round(25 * scale));

    // Clip Y range: only show the bottom ~50% of the text area (highlighter effect)
    // With Alignment=2 (bottom-center), text bottom ≈ H - marginV
    const defBottom = H - defaultMarginV;
    const defClipTop = defBottom - Math.round(defaultSize * 0.55);
    const defClipBot = defBottom + Math.round(defaultSize * 0.15);

    const titleBottom = H - titleMarginV;
    const titleClipTop = titleBottom - Math.round(titleSize * 0.55);
    const titleClipBot = titleBottom + Math.round(titleSize * 0.15);

    if (titleCard) {
      const animMs = Math.round(Math.min(5, TITLE_DURATION) * 1000);
      dialogueLines.push(
        `Dialogue: 0,${formatASSTime(0)},${formatASSTime(TITLE_DURATION)},TitleHighlightGlow,,0,0,0,,{\\blur${glowBlur}}${titleCard}`,
        `Dialogue: 1,${formatASSTime(0)},${formatASSTime(TITLE_DURATION)},TitleHighlight,,0,0,0,,{\\clip(${W},${titleClipTop},${W},${titleClipBot})\\t(0,${animMs},0.5,\\clip(0,${titleClipTop},${W},${titleClipBot}))}${titleCard}`,
        `Dialogue: 2,${formatASSTime(0)},${formatASSTime(TITLE_DURATION)},TitleText,,0,0,0,,${titleCard}`
      );
    }

    for (const chunk of chunks) {
      const chunkDur = chunk.end - chunk.start;
      const animMs = Math.round(Math.min(5, chunkDur) * 1000);
      dialogueLines.push(
        `Dialogue: 0,${formatASSTime(chunk.start)},${formatASSTime(chunk.end)},HighlightGlow,,0,0,0,,{\\blur${glowBlur}}${chunk.text}`,
        `Dialogue: 1,${formatASSTime(chunk.start)},${formatASSTime(chunk.end)},Highlight,,0,0,0,,{\\clip(${W},${defClipTop},${W},${defClipBot})\\t(0,${animMs},0.5,\\clip(0,${defClipTop},${W},${defClipBot}))}${chunk.text}`,
        `Dialogue: 2,${formatASSTime(chunk.start)},${formatASSTime(chunk.end)},Text,,0,0,0,,${chunk.text}`
      );
    }

    return `[Script Info]
Title: Reel Subtitles
ScriptType: v4.00+
PlayResX: ${vd.width}
PlayResY: ${vd.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TitleHighlightGlow,SomarSans-Bold,${titleSize},&HFF000000,&H000000FF,&H80000000,&H80000000,1,0,0,0,100,100,0,0,3,${glowPad},0,2,${marginLR},${marginLR},${titleMarginV},1
Style: TitleText,SomarSans-Bold,${titleSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,2,${marginLR},${marginLR},${titleMarginV},1
Style: TitleHighlight,SomarSans-Bold,${titleSize},&HFF000000,&H000000FF,&H00BE2F7B,&H00BE2F7B,1,0,0,0,100,100,0,0,3,${highlightPad},0,2,${marginLR},${marginLR},${titleMarginV},1
Style: HighlightGlow,SomarSans-Bold,${defaultSize},&HFF000000,&H000000FF,&H80000000,&H80000000,1,0,0,0,100,100,0,0,3,${glowPad},0,2,${marginLR},${marginLR},${defaultMarginV},1
Style: Text,SomarSans-Bold,${defaultSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,2,${marginLR},${marginLR},${defaultMarginV},1
Style: Highlight,SomarSans-Bold,${defaultSize},&HFF000000,&H000000FF,&H00BE2F7B,&H00BE2F7B,1,0,0,0,100,100,0,0,3,${highlightPad},0,2,${marginLR},${marginLR},${defaultMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogueLines.join("\n")}`;
  }

  // Static style — single layer, purple outline around text
  if (titleCard) {
    dialogueLines.push(`Dialogue: 0,${formatASSTime(0)},${formatASSTime(TITLE_DURATION)},Title,,0,0,0,,${titleCard}`);
  }

  for (const chunk of chunks) {
    dialogueLines.push(`Dialogue: 0,${formatASSTime(chunk.start)},${formatASSTime(chunk.end)},Default,,0,0,0,,${chunk.text}`);
  }

  return `[Script Info]
Title: Reel Subtitles
ScriptType: v4.00+
PlayResX: ${vd.width}
PlayResY: ${vd.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,SomarSans-Bold,${titleSize},&H00FFFFFF,&H000000FF,&H00BE2F7B,&H00BE2F7B,1,0,0,0,100,100,0,0,3,${outline},0,2,${marginLR},${marginLR},${titleMarginV},1
Style: Default,SomarSans-Bold,${defaultSize},&H00FFFFFF,&H000000FF,&H00BE2F7B,&H00BE2F7B,1,0,0,0,100,100,0,0,3,${outline},0,2,${marginLR},${marginLR},${defaultMarginV},1

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

  closeSubtitleGaps(chunks);

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

async function subtitle(slug, force = false, titleCard = false, reelId = null, burnOnly = false, subtitleStyle = "animated") {
  console.log(`\n🎬 Subtitle Generator — ${slug} (style: ${subtitleStyle})\n`);
  
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

  let transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  const isYouTubeTranscript = transcript.api_provider === "youtube" || transcript.model === "youtube-transcript";

  if (isYouTubeTranscript) {
    console.log(`   ⚠️  Transcript is from YouTube — will retranscribe each reel clip with local Whisper for accurate word-level timestamps`);
  }

  // Ensure word-level timestamps exist.
  // If transcript was imported from SRT (no words array), synthesize from segments.
  if (!transcript.words && transcript.segments && transcript.segments.length > 0) {
    console.log(`   ⚠️  No word-level timestamps — synthesizing from ${transcript.segments.length} segments`);
    transcript.words = [];
    for (const seg of transcript.segments) {
      const text = (seg.text || "").trim();
      if (!text) continue;
      const tokens = text.split(/\s+/);
      const segDur = (seg.end || 0) - (seg.start || 0);
      const wordDur = tokens.length > 0 ? segDur / tokens.length : segDur;
      for (let i = 0; i < tokens.length; i++) {
        transcript.words.push({
          word: tokens[i],
          start: seg.start + i * wordDur,
          end: seg.start + (i + 1) * wordDur,
          probability: 0.5
        });
      }
    }
    console.log(`   ✅ Synthesized ${transcript.words.length} word timestamps from segments`);
  }

  console.log(`   📊 Found ${transcript.words?.length || 0} words in transcript`);

  const analysis = fs.existsSync(analysisPath) ? JSON.parse(fs.readFileSync(analysisPath, "utf8")) : null;
  let reels = analysis?.reels || [];

  console.log(`   📊 Found ${reels.length} reels to subtitle`);

  // Per-reel filter
  if (reelId) {
    const targetId = parseInt(reelId, 10);
    reels = reels.filter(r => r.id === targetId);
    if (reels.length === 0) {
      // Fallback: if no analysis entry but reel file exists, create a synthetic entry
      const padded = String(reelId).padStart(2, "0");
      const reelPath = path.join(reelsDir, `reel-${padded}.mp4`);
      const croppedPath = path.join(reelsDir, `reel-${padded}-cropped.mp4`);
      if (fs.existsSync(reelPath) || fs.existsSync(croppedPath)) {
        console.log(`   ⚠️  Reel ${reelId} not in analysis, using full-length subtitles`);
        reels = [{ id: targetId, start: "0:00", end: "99:59" }];
      } else {
        console.error(`❌ Reel ${reelId} not found (no analysis entry, no reel file).`);
        process.exit(1);
      }
    }
    console.log(`📝 Per-reel mode: processing only reel ${targetId}`);
  }

  // Get source video path
  let sourceVideo = path.join(dir, "raw.mov");
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.rawVideo) sourceVideo = meta.rawVideo;
  }

  if (reels.length === 0) {
    console.log("\n⚠️  No reels found in analysis. Will generate full-video subtitles.\n");

    // Retranscribe full video with Whisper if transcript is from YouTube
    if (isYouTubeTranscript && fs.existsSync(sourceVideo)) {
      const fullTranscriptPath = path.join(dir, "whisper-transcript.json");
      const whisperWords = whisperTranscribeClip(sourceVideo, fullTranscriptPath);
      if (whisperWords && whisperWords.length > 0) {
        transcript.words = whisperWords;
      }
    }

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
    
    // Copy SRT to /tmp to avoid special characters in path (!, spaces, etc.)
    const tmpSRT = path.join(os.tmpdir(), `tajarib-full-sub.srt`);
    const tmpFullOut = path.join(os.tmpdir(), `tajarib-full-subtitled.mp4`);
    fs.copyFileSync(srtPath, tmpSRT);
    const escapedSRT = tmpSRT.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

    const ffmpegArgs = [
      "-y",
      "-i", sourceVideo,
      "-vf", `subtitles='${escapedSRT}':force_style='FontName=SomarSans-Bold,FontSize=52,PrimaryColour=&H00FFFFFF,OutlineColour=&H00BE2F7B,BackColour=&H00BE2F7B,BorderStyle=3,Outline=12,Shadow=0,Bold=1,Alignment=2,MarginV=100'`,
      "-c:a", "copy",
      tmpFullOut
    ];

    console.log(`\n⏳ Running ffmpeg (this may take a while)...`);
    const startTime = Date.now();

    try {
      execFileSync("ffmpeg", ffmpegArgs, { stdio: "inherit" });
      fs.copyFileSync(tmpFullOut, subtitledPath);
      fs.unlinkSync(tmpFullOut);
      fs.unlinkSync(tmpSRT);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const size = (fs.statSync(subtitledPath).size / 1024 / 1024).toFixed(1);
      console.log(`\n✅ Done in ${duration}s`);
      console.log(`   📁 ${size} MB → ${subtitledPath}`);
    } catch (e) {
      try { fs.unlinkSync(tmpSRT); } catch {}
      try { fs.unlinkSync(tmpFullOut); } catch {}
      console.error(`\n❌ Subtitle burn failed:`, e.stderr?.toString() || e.message);
      process.exit(1);
    }
    return;
  }

  fs.mkdirSync(reelsDir, { recursive: true });

  console.log(`\n📝 Processing ${reels.length} reels...\n`);

  for (const reel of reels) {
    const reelId = String(reel.id).padStart(2, "0");
    const subtitlePath = path.join(reelsDir, `reel-${reelId}.ass`);
    // Prefer cropped reel as input, fall back to raw cut
    const croppedPath = path.join(reelsDir, `reel-${reelId}-cropped.mp4`);
    const rawReelPath = path.join(reelsDir, `reel-${reelId}.mp4`);
    const videoPath = fs.existsSync(croppedPath) ? croppedPath : rawReelPath;
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

    // Burn-only mode: skip ASS generation, use existing file for re-burning
    if (burnOnly) {
      if (!fs.existsSync(subtitlePath)) {
        console.log(`   ❌ No existing subtitle file to burn: ${subtitlePath}`);
        continue;
      }
      const blockCount = fs.readFileSync(subtitlePath, "utf8").split("\n").filter(l => l.includes("Dialogue")).length;
      console.log(`   📝 Using existing ASS file: ${blockCount} subtitle blocks (burn-only mode)`);
    } else {
      // Get reel title from analysis (fallback to generic title)
      const reelTitle = reel.title || reel.hook || `Reel ${reel.id}`;

      // Get words for this reel — if YouTube transcript, retranscribe the clip
      // with local Whisper for accurate word-level timestamps
      let reelWords;
      let wordStartOffset = startSec;

      if (isYouTubeTranscript) {
        const clipTranscriptPath = path.join(reelsDir, `reel-${reelId}-transcript.json`);
        const whisperWords = whisperTranscribeClip(videoPath, clipTranscriptPath);
        if (whisperWords && whisperWords.length > 0) {
          reelWords = whisperWords;
          wordStartOffset = 0; // clip timestamps are already 0-indexed
        } else {
          console.log(`   ⚠️  Falling back to YouTube transcript words`);
          reelWords = transcript.words.filter(w => w.start >= startSec && w.end <= endSec);
        }
      } else {
        reelWords = transcript.words.filter(w => w.start >= startSec && w.end <= endSec);
      }

      // Detect actual video dimensions so ASS PlayRes matches
      const videoDims = getVideoDimensions(videoPath);
      console.log(`   📐 Video dimensions: ${videoDims.width}x${videoDims.height}`);

      // Always use ASS format — embedded styles avoid force_style FFmpeg parsing issues
      const subtitleContent = generateASS(reelWords, wordStartOffset, titleCard ? reelTitle : null, videoDims, subtitleStyle);

      fs.writeFileSync(subtitlePath, subtitleContent, "utf8");
      const blockCount = subtitleContent.split("\n").filter(l => l.includes("Dialogue")).length;
      console.log(`   📝 ASS generated: ${blockCount} subtitle blocks${titleCard ? ' (with 5s title card)' : ''}`);
    }

    // Burn subtitles into video with FFmpeg
    console.log(`   🔥 Burning subtitles with ffmpeg...`);

    // Copy subtitle file to /tmp to avoid special characters in path (!, spaces, etc.)
    const tmpSub = path.join(os.tmpdir(), `tajarib-sub-${reelId}.ass`);
    const tmpOut = path.join(os.tmpdir(), `tajarib-subtitled-${reelId}.mp4`);
    fs.copyFileSync(subtitlePath, tmpSub);

    // Escape temp subtitle path for FFmpeg (only : and \ need escaping)
    const escapedSubtitle = tmpSub.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

    // ASS has embedded styles — no force_style needed, avoids FFmpeg filter parsing issues
    const ffmpegArgs = [
      "-y",
      "-i", videoPath,
      "-vf", `ass='${escapedSubtitle}'`,
      "-c:a", "copy",
      tmpOut
    ];

    const startTime = Date.now();
    try {
      execFileSync("ffmpeg", ffmpegArgs, { stdio: "inherit" });
      // Move result back to the real output path
      fs.copyFileSync(tmpOut, subtitledPath);
      fs.unlinkSync(tmpOut);
      fs.unlinkSync(tmpSub);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const size = (fs.statSync(subtitledPath).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ Done in ${duration}s (${size} MB)`);
    } catch (e) {
      // Clean up temp files on error
      try { fs.unlinkSync(tmpSub); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
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
const burnOnly = args.includes("--burn-only");
const reelId = get("--reel-id");
const subtitleStyle = get("--subtitle-style") || "animated"; // "animated" or "static"

if (!slug) {
  console.error("Usage: node subtitle.js --slug <slug> [--force] [--title-card] [--burn-only] [--subtitle-style animated|static]");
  process.exit(1);
}
if (!["animated", "static"].includes(subtitleStyle)) {
  console.error(`❌ Invalid --subtitle-style "${subtitleStyle}". Use "animated" or "static".`);
  process.exit(1);
}
subtitle(slug, force, titleCard, reelId, burnOnly, subtitleStyle).catch(err => { console.error("❌", err.message); process.exit(1); });
