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
const { GLOBAL_TRANSCRIPTION_CONFIG } = require("./server/global-config");
const PYTHON_BIN = fs.existsSync(path.join(__dirname, ".venv", "bin", "python3"))
  ? path.join(__dirname, ".venv", "bin", "python3")
  : "python3";

// Title card duration in seconds
const TITLE_DURATION = 5;

// Transcribe a video clip using the configured method (Groq/local/API).
// Returns the words array (0-indexed relative to clip start), or null on failure.
function whisperTranscribeClip(clipPath, outputPath) {
  // Read transcription config to determine method
  let method = "local";
  try {
    const cfg = JSON.parse(fs.readFileSync(GLOBAL_TRANSCRIPTION_CONFIG, "utf8"));
    if (cfg.defaultMethod === "groq" && cfg.groqApiKey) method = "groq";
    else if (cfg.defaultMethod === "api" && cfg.apiKey) method = "api";
  } catch (_) {}

  const args = ["-u", "transcribe.py", clipPath, "--slug", "temp", "--force", "--output", outputPath];
  if (method === "groq") args.push("--groq");
  else if (method === "api") args.push("--api");

  const label = method === "groq" ? "Groq" : method === "api" ? "Haimaker API" : "local Whisper";
  console.log(`   🎙️  Transcribing clip with ${label}: ${path.basename(clipPath)}`);
  const result = spawnSync(PYTHON_BIN, args, { cwd: __dirname, stdio: "inherit", timeout: 10 * 60 * 1000 });

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

// Reconstruct a complete word list from a reel transcript, filling in any words
// that appear in segment text but are missing from segment word-level timing data
// (a known Whisper limitation: first words of segments sometimes lack timestamps).
function reelWordsFromTranscript(clipT) {
  if (!clipT.segments || !clipT.segments.length) return clipT.words || [];
  const result = [];
  for (const seg of clipT.segments) {
    const textWords = seg.text.trim().split(/\s+/).filter(Boolean);
    if (!textWords.length) continue;
    const segWords = seg.words || [];
    if (segWords.length === textWords.length) {
      result.push(...segWords);
    } else {
      // Some words in segment text are missing from seg.words — synthesize timing
      // for the missing ones using proportional distribution within the segment.
      const dur = seg.end - seg.start;
      const wordDur = textWords.length > 0 ? dur / textWords.length : dur;
      // Build a lookup for existing word timings (by position in seg.words)
      let swIdx = 0;
      textWords.forEach((w, i) => {
        if (swIdx < segWords.length && segWords[swIdx].word === w) {
          result.push(segWords[swIdx++]);
        } else {
          result.push({
            word: w,
            start: seg.start + i * wordDur,
            end: seg.start + (i + 1) * wordDur,
            probability: 0.5
          });
        }
      });
    }
  }
  return result;
}

// Close small gaps between consecutive subtitle chunks so there is no visual
// emptiness.  If the gap between two chunks is <= MAX_GAP_FILL seconds, extend
// the earlier chunk's end time to meet the next chunk's start time.
const MAX_GAP_FILL = 3; // seconds

// Shadow fade durations (ms) — smooth fade-in and fade-out
const SHADOW_FADE_IN = 300;
const SHADOW_FADE_OUT = 200;

function closeSubtitleGaps(chunks) {
  for (let i = 0; i < chunks.length - 1; i++) {
    const gap = chunks[i + 1].start - chunks[i].end;
    if (gap > 0 && gap <= MAX_GAP_FILL) {
      chunks[i].end = chunks[i + 1].start;
    } else if (gap < 0) {
      // Overlapping chunks — trim current chunk to end when the next starts,
      // otherwise libass collision detection pushes the later subtitle up
      // and the fixed \clip coordinates no longer align with the text.
      chunks[i].end = chunks[i + 1].start;
    }
  }
}

/**
 * Remap proofread subtitle chunks when reel boundaries or cuts change.
 * Converts old-video-time → episode-time → new-video-time.
 * Chunks that fall inside a new cut, outside new boundaries, or span a cut
 * boundary are dropped (their text no longer matches the audio).
 *
 * @param {Array} chunks    [{text, start, end}, ...] in old-video-relative time
 * @param {number} oldStart  previous reel start (episode seconds)
 * @param {number} oldEnd    previous reel end   (episode seconds)
 * @param {Array}  oldCuts   previous cuts [{from, to}] (episode seconds)
 * @param {number} newStart  updated reel start  (episode seconds)
 * @param {number} newEnd    updated reel end    (episode seconds)
 * @param {Array}  newCuts   updated cuts [{from, to}] (episode seconds)
 * @returns {Array} remapped chunks (fewer if some fell inside cuts / outside bounds)
 */
function remapChunksForCuts(chunks, oldStart, oldEnd, oldCuts, newStart, newEnd, newCuts) {
  if (!chunks || !chunks.length) return [];

  // Build kept-segment list: [{start, end}] in episode time
  function buildSegments(reelStart, reelEnd, cuts) {
    const sorted = (cuts || [])
      .filter(c => c.from > reelStart && c.to < reelEnd && c.to > c.from)
      .sort((a, b) => a.from - b.from);
    const segs = [];
    let cursor = reelStart;
    for (const c of sorted) {
      if (c.from > cursor) segs.push({ start: cursor, end: c.from });
      cursor = c.to;
    }
    if (cursor < reelEnd) segs.push({ start: cursor, end: reelEnd });
    return segs;
  }

  const oldSegs = buildSegments(oldStart, oldEnd, oldCuts);
  const newSegs = buildSegments(newStart, newEnd, newCuts);

  // old-video-time → episode-time
  function oldVideoToEpisode(t) {
    let offset = 0;
    for (const seg of oldSegs) {
      const dur = seg.end - seg.start;
      if (t <= offset + dur + 0.001) {
        return seg.start + (t - offset);
      }
      offset += dur;
    }
    return oldEnd;
  }

  // episode-time → { time, segIndex } in new video, or null if in cut / out of bounds
  function episodeToNewVideo(epTime) {
    let offset = 0;
    for (let i = 0; i < newSegs.length; i++) {
      const seg = newSegs[i];
      if (epTime >= seg.start - 0.001 && epTime <= seg.end + 0.001) {
        return { time: offset + Math.max(0, epTime - seg.start), segIndex: i };
      }
      offset += seg.end - seg.start;
    }
    return null;
  }

  const remapped = [];
  for (const chunk of chunks) {
    const epStart = oldVideoToEpisode(chunk.start);
    const epEnd = oldVideoToEpisode(chunk.end);

    const startInfo = episodeToNewVideo(epStart);
    const endInfo = episodeToNewVideo(epEnd);

    if (!startInfo || !endInfo) continue;              // endpoint in cut or out of bounds
    if (startInfo.segIndex !== endInfo.segIndex) continue; // spans a cut boundary
    if (endInfo.time <= startInfo.time + 0.01) continue;   // degenerate

    remapped.push({ ...chunk, start: startInfo.time, end: endInfo.time });
  }

  return remapped;
}

/**
 * Filter episode transcript words for a reel with cuts.
 * Removes words that fall inside cut zones and shifts timestamps of words
 * after each cut so that chunkWords() produces correct video-relative times.
 */
function filterWordsForCuts(words, reelStart, reelEnd, cuts) {
  if (!cuts || !cuts.length) return words;
  const sorted = cuts
    .filter(c => c.from > reelStart && c.to < reelEnd && c.to > c.from)
    .sort((a, b) => a.from - b.from);
  if (!sorted.length) return words;
  return words
    .filter(w => !sorted.some(c => w.start >= c.from - 0.05 && w.start < c.to))
    .map(w => {
      const shift = sorted.filter(c => c.to <= w.start).reduce((sum, c) => sum + (c.to - c.from), 0);
      return { ...w, start: w.start - shift, end: w.end - shift };
    });
}

// Detect time-shift between saved (proofread) chunks and a fresh transcript.
// When a reel's start boundary is extended earlier, the clip is re-cut and
// re-transcribed with 0-indexed timestamps. The old chunks still carry timestamps
// from the previous clip. This function finds where the old chunk content appears
// in the new transcript and returns the shift to apply (positive = chunks need to
// move forward because new content was prepended to the clip).
function detectChunkShift(savedChunks, reelWords, wordStartOffset) {
  if (!savedChunks || !savedChunks.length || !reelWords || !reelWords.length) return 0;

  // Collect words from the first few saved chunks
  const chunkTextWords = [];
  for (const chunk of savedChunks.slice(0, 5)) {
    const words = chunk.text.trim().split(/\s+/).filter(Boolean);
    chunkTextWords.push(...words);
    if (chunkTextWords.length >= 12) break;
  }
  if (chunkTextWords.length < 2) return 0;

  // Remove Arabic diacritics / kashida for fuzzy matching
  const norm = s => s.replace(/[\u064B-\u065F\u0670\u0640]/g, '').trim();

  // Skip the first word (Whisper often transcribes segment-initial words
  // differently between runs, e.g. "ترى" vs "درى"). Match from word 2 onward.
  const matchStart = Math.min(1, chunkTextWords.length - 1);
  const matchWords = chunkTextWords.slice(matchStart, matchStart + 8).map(norm);
  if (!matchWords.length) return 0;

  // Sliding-window search over the first portion of the new transcript
  const maxSearch = Math.min(reelWords.length, 300);
  let bestScore = 0;
  let bestPos = -1;

  for (let i = 0; i < maxSearch; i++) {
    let score = 0;
    for (let j = 0; j < matchWords.length && (i + j) < reelWords.length; j++) {
      if (norm(reelWords[i + j].word) === matchWords[j]) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPos = i;
    }
  }

  // Need at least 40% of searched words to match
  if (bestScore < Math.max(1, Math.ceil(matchWords.length * 0.4)) || bestPos < 0) return 0;

  // bestPos is where matchWords[0] was found — the first chunk's first word
  // is matchStart positions earlier in the reelWords stream.
  const firstWordPos = Math.max(0, bestPos - matchStart);
  const wordTime = reelWords[firstWordPos].start - wordStartOffset;
  const chunkTime = savedChunks[0].start;
  const shift = wordTime - chunkTime;

  return Math.abs(shift) > 0.3 ? shift : 0;
}

// Wrap text with Unicode RTL embedding when it mixes Arabic with Latin/digits.
// Libass (FFmpeg's ASS renderer) can mis-order bidirectional text because it
// doesn't inherit an RTL base direction the way a browser with dir="rtl" does.
// Pure Arabic text is unaffected; mixed text (e.g. "500 ألف") gets fixed.
const HAS_LATIN_OR_DIGIT = /[A-Za-z0-9]/;
function wrapRTLIfMixed(text) {
  if (HAS_LATIN_OR_DIGIT.test(text)) {
    // U+202B RIGHT-TO-LEFT EMBEDDING … U+202C POP DIRECTIONAL FORMATTING
    return '\u202B' + text + '\u202C';
  }
  return text;
}

// Sentence-ending punctuation — break subtitle chunks at these boundaries
const SENTENCE_END_RE = /[.!?؟…]+$/;

// Silence gap threshold — a pause this long between words signals a natural break
const PAUSE_BREAK_SEC = 0.4;

// Group words into subtitle chunks, respecting natural speech boundaries.
// Rules (in priority order):
//   1. Always break after a word that ends a sentence (. ! ? ؟ …)
//   2. Break before a word preceded by a silence gap >= PAUSE_BREAK_SEC
//   3. Break when chunk reaches 6 words or 2 seconds
function chunkWords(words, startOffset = 0) {
  const chunks = [];
  let current = { words: [], start: null, end: null };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const adjustedStart = w.start - startOffset;
    const adjustedEnd = w.end - startOffset;

    if (adjustedStart < 0) continue;

    // Check for silence gap BEFORE this word — flush previous chunk first
    if (current.words.length > 0) {
      const gap = adjustedStart - current.end;
      if (gap >= PAUSE_BREAK_SEC) {
        chunks.push({ text: current.words.join(" "), start: current.start, end: current.end });
        current = { words: [], start: null, end: null };
      }
    }

    if (current.start === null) current.start = adjustedStart;
    const trimmed = w.word.trim();
    current.words.push(trimmed);
    current.end = adjustedEnd;

    const isSentenceEnd = SENTENCE_END_RE.test(trimmed);
    const hitLimit = current.words.length >= 6 || (current.end - current.start) >= 2;

    if (isSentenceEnd || hitLimit) {
      chunks.push({ text: current.words.join(" "), start: current.start, end: current.end });
      current = { words: [], start: null, end: null };
    }
  }

  if (current.words.length > 0) {
    chunks.push({ text: current.words.join(" "), start: current.start, end: current.end });
  }

  closeSubtitleGaps(chunks);
  return chunks;
}

// Generate ASS format subtitles
// style: "animated" — highlight sweeps right-to-left beneath text (two layers)
//        "static"   — plain purple box behind text (single layer)
function generateASS(words, startOffset = 0, titleCard = null, videoDimensions = null, style = "animated", precomputedChunks = null) {
  const chunks = precomputedChunks || chunkWords(words, startOffset);

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
    const glowBlur = Math.max(50, Math.round(90 * scale));
    const glowPad = Math.max(15, Math.round(35 * scale));

    // Clip Y range: only show the bottom ~50% of the text area (highlighter effect)
    // With Alignment=2 (bottom-center), text bottom ≈ H - marginV
    const defBottom = H - defaultMarginV;
    const defClipTop = defBottom - Math.round(defaultSize * 0.55);
    const defClipBot = defBottom + Math.round(defaultSize * 0.15);

    const titleBottom = H - titleMarginV;
    const titleClipTop = titleBottom - Math.round(titleSize * 0.55);
    const titleClipBot = titleBottom + Math.round(titleSize * 0.15);

    // ── Shadow: one persistent glow per continuous subtitle run ──
    // Merge consecutive chunks into runs (chunks are already gap-filled),
    // then emit a single drawn rectangle per run instead of per-chunk text shadows.
    const runs = [];
    if (titleCard) runs.push({ start: 0, end: TITLE_DURATION });
    for (const chunk of chunks) {
      const last = runs[runs.length - 1];
      if (last && chunk.start <= last.end + 0.05) {
        last.end = Math.max(last.end, chunk.end);
      } else {
        runs.push({ start: chunk.start, end: chunk.end });
      }
    }
    // Shadow is handled via ffmpeg gradient overlay, not ASS

    // ── Title card ──
    if (titleCard) {
      const animMs = Math.round(Math.min(5, TITLE_DURATION) * 1000);
      const tc = wrapRTLIfMixed(titleCard);
      dialogueLines.push(
        `Dialogue: 1,${formatASSTime(0)},${formatASSTime(TITLE_DURATION)},TitleHighlight,,0,0,0,,{\\clip(${W},${titleClipTop},${W},${titleClipBot})\\t(0,${animMs},0.5,\\clip(0,${titleClipTop},${W},${titleClipBot}))}${tc}`,
        `Dialogue: 2,${formatASSTime(0)},${formatASSTime(TITLE_DURATION)},TitleText,,0,0,0,,${tc}`
      );
    }

    // ── Subtitle chunks: highlight + text only (no per-chunk shadow) ──
    for (const chunk of chunks) {
      const chunkDur = chunk.end - chunk.start;
      const animMs = Math.round(Math.min(5, chunkDur) * 1000);
      const ct = wrapRTLIfMixed(chunk.text);
      dialogueLines.push(
        `Dialogue: 1,${formatASSTime(chunk.start)},${formatASSTime(chunk.end)},Highlight,,0,0,0,,{\\clip(${W},${defClipTop},${W},${defClipBot})\\t(0,${animMs},0.5,\\clip(0,${defClipTop},${W},${defClipBot}))}${ct}`,
        `Dialogue: 2,${formatASSTime(chunk.start)},${formatASSTime(chunk.end)},Text,,0,0,0,,${ct}`
      );
    }

    return `[Script Info]
Title: Reel Subtitles
ScriptType: v4.00+
PlayResX: ${vd.width}
PlayResY: ${vd.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TitleText,SomarSans-Bold,${titleSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,2,${marginLR},${marginLR},${titleMarginV},1
Style: TitleHighlight,SomarSans-Bold,${titleSize},&HFF000000,&H000000FF,&H00BE2F7B,&H00BE2F7B,1,0,0,0,100,100,0,0,3,${highlightPad},0,2,${marginLR},${marginLR},${titleMarginV},1
Style: Text,SomarSans-Bold,${defaultSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,2,${marginLR},${marginLR},${defaultMarginV},1
Style: Highlight,SomarSans-Bold,${defaultSize},&HFF000000,&H000000FF,&H00BE2F7B,&H00BE2F7B,1,0,0,0,100,100,0,0,3,${highlightPad},0,2,${marginLR},${marginLR},${defaultMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogueLines.join("\n")}`;
  }

  // Static style — single layer, purple outline around text
  if (titleCard) {
    dialogueLines.push(`Dialogue: 0,${formatASSTime(0)},${formatASSTime(TITLE_DURATION)},Title,,0,0,0,,${wrapRTLIfMixed(titleCard)}`);
  }

  for (const chunk of chunks) {
    dialogueLines.push(`Dialogue: 0,${formatASSTime(chunk.start)},${formatASSTime(chunk.end)},Default,,0,0,0,,${wrapRTLIfMixed(chunk.text)}`);
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
  const chunks = chunkWords(words, startOffset);

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

function generateSRTFromChunks(chunks) {
  const entries = [];
  for (let i = 0; i < chunks.length; i++) {
    entries.push(`${i + 1}\n${formatSRTTime(chunks[i].start)} --> ${formatSRTTime(chunks[i].end)}\n${chunks[i].text}\n`);
  }
  return entries.join("\n");
}

async function subtitle(slug, force = false, titleCard = false, reelId = null, burnOnly = false, subtitleStyle = "animated", noTranscribe = false) {
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

  // Resolve source video. meta.rawVideo can carry a stale absolute path baked
  // in by an older container layout (e.g. /app/episodes/... before EPISODES_DIR
  // moved to /data/episodes/...), so only honor it when the file actually
  // exists; otherwise re-resolve the basename inside the current episode dir,
  // and finally scan for any raw.* file.
  let sourceVideo = null;
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.rawVideo && fs.existsSync(meta.rawVideo)) {
      sourceVideo = meta.rawVideo;
    } else if (meta.rawVideo) {
      const candidate = path.join(dir, path.basename(meta.rawVideo));
      if (fs.existsSync(candidate)) sourceVideo = candidate;
    }
  }
  if (!sourceVideo && fs.existsSync(dir)) {
    const raw = fs.readdirSync(dir).find(f => /^raw\.(mp4|mkv|mov|avi)$/i.test(f));
    if (raw) sourceVideo = path.join(dir, raw);
  }
  if (!sourceVideo) sourceVideo = path.join(dir, "raw.mp4");

  if (reels.length === 0) {
    // No reels from analysis — treat the full video as a single reel
    // and use the same ASS subtitle rendering as per-reel subtitles
    console.log("\n⚠️  No reels found in analysis. Subtitling full video with ASS (same as per-reel).\n");

    if (!fs.existsSync(sourceVideo)) {
      console.error(`❌ Source video not found: ${sourceVideo}`);
      fs.readdirSync(dir).forEach(f => console.log(`      - ${f}`));
      process.exit(1);
    }

    const subtitledPath = path.join(dir, "full-subtitled.mp4");
    const subtitlePath = path.join(dir, "full.ass");

    if (fs.existsSync(subtitledPath) && !force) {
      console.log(`⏭️  Subtitled video already exists: ${subtitledPath}`);
      console.log(`   Use --force to overwrite.`);
      return;
    }

    // Retranscribe with Whisper if transcript is from YouTube
    if (isYouTubeTranscript && fs.existsSync(sourceVideo)) {
      const fullTranscriptPath = path.join(dir, "whisper-transcript.json");
      const whisperWords = whisperTranscribeClip(sourceVideo, fullTranscriptPath);
      if (whisperWords && whisperWords.length > 0) {
        transcript.words = whisperWords;
      }
    }

    // Check for saved (proofread) subtitle chunks
    const fullChunksPath = path.join(dir, "full-chunks.json");
    let savedChunks = null;
    if (fs.existsSync(fullChunksPath)) {
      savedChunks = JSON.parse(fs.readFileSync(fullChunksPath, "utf8"));
      console.log(`   📝 Using ${savedChunks.length} saved subtitle chunks`);
    }

    // Detect video dimensions for proper ASS scaling
    const videoDims = getVideoDimensions(sourceVideo);
    console.log(`   📐 Video dimensions: ${videoDims.width}x${videoDims.height}`);

    // Generate ASS subtitles (same as per-reel path)
    const reelWords = transcript.words || [];
    const subtitleContent = generateASS(reelWords, 0, null, videoDims, subtitleStyle, savedChunks);
    fs.writeFileSync(subtitlePath, subtitleContent, "utf8");
    const blockCount = subtitleContent.split("\n").filter(l => l.includes("Dialogue")).length;
    console.log(`   📝 ASS generated: ${blockCount} subtitle blocks`);

    // Also write SRT for reference/download
    const srtContent = savedChunks ? generateSRTFromChunks(savedChunks) : generateSRT(reelWords, 0);
    fs.writeFileSync(path.join(dir, "full.srt"), srtContent, "utf8");

    // Burn subtitles with gradient overlay (same as per-reel)
    console.log(`   🔥 Burning subtitles with ffmpeg...`);
    const tmpSub = path.join(os.tmpdir(), `tajarib-sub-full.ass`);
    const tmpOut = path.join(os.tmpdir(), `tajarib-subtitled-full.mp4`);
    fs.copyFileSync(subtitlePath, tmpSub);
    const escapedSubtitle = tmpSub.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

    // Generate gradient overlay (same as per-reel)
    const gradW = videoDims.width;
    const gradH = videoDims.height;
    const tmpGrad = path.join(os.tmpdir(), `tajarib-grad-full.png`);
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i",
      `color=black:size=${gradW}x${gradH}:d=1,format=rgba,geq=r=0:g=0:b=0:a='if(gt(Y,H*0.4),min(166,(Y-H*0.4)/(H*0.6)*166),0)'`,
      "-frames:v", "1", tmpGrad
    ], { stdio: "pipe" });

    const ffmpegArgs = [
      "-y",
      "-i", sourceVideo,
      "-i", tmpGrad,
      "-filter_complex", `[0:v][1:v]overlay=format=auto,ass='${escapedSubtitle}'`,
      "-c:a", "copy",
      tmpOut
    ];

    const startTime = Date.now();
    try {
      execFileSync("ffmpeg", ffmpegArgs, { stdio: "inherit" });
      fs.copyFileSync(tmpOut, subtitledPath);
      fs.unlinkSync(tmpOut);
      fs.unlinkSync(tmpSub);
      if (fs.existsSync(tmpGrad)) fs.unlinkSync(tmpGrad);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const size = (fs.statSync(subtitledPath).size / 1024 / 1024).toFixed(1);
      console.log(`\n✅ Done in ${duration}s`);
      console.log(`   📁 ${size} MB → ${subtitledPath}`);
      // Remove stale full-final.mp4 since subtitles changed
      const finalPath = path.join(dir, "full-final.mp4");
      if (fs.existsSync(finalPath)) {
        fs.unlinkSync(finalPath);
        console.log(`   🗑️  Removed stale overlay: full-final.mp4`);
      }
    } catch (e) {
      try { fs.unlinkSync(tmpSub); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
      if (fs.existsSync(tmpGrad)) try { fs.unlinkSync(tmpGrad); } catch {}
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

      // Get words for this reel — retranscribe the clip
      // when force is set (re-clicking Sub) or when transcript is from YouTube
      let reelWords;
      let wordStartOffset = startSec;
      let savedChunks = null;

      // Check for saved (proofread) subtitle chunks up front — used for merging below
      const clipChunksPath = path.join(reelsDir, `reel-${reelId}-chunks.json`);
      if (fs.existsSync(clipChunksPath)) {
        savedChunks = JSON.parse(fs.readFileSync(clipChunksPath, "utf8"));
      }

      // Check if saved chunks are out of sync with the reel's current cuts/boundaries.
      // We track what state the chunks were last synced to in a companion state file.
      if (savedChunks && savedChunks.length) {
        const stateFilePath = path.join(reelsDir, `reel-${reelId}-chunks-state.json`);
        const currentCuts = (reel.cuts || [])
          .map(c => ({ from: toSeconds(c.from), to: toSeconds(c.to) }))
          .filter(c => c.from > startSec && c.to < endSec && c.to > c.from);
        const currentState = { start: startSec, end: endSec, cuts: currentCuts };

        let needsRemap = false;
        let oldStart = startSec, oldEnd = endSec, oldCuts = [];

        if (fs.existsSync(stateFilePath)) {
          const stored = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
          if (JSON.stringify(stored) !== JSON.stringify(currentState)) {
            needsRemap = true;
            oldStart = stored.start; oldEnd = stored.end; oldCuts = stored.cuts || [];
          }
        } else if (currentCuts.length) {
          // No state file but reel has cuts — chunks are from before cuts were tracked
          needsRemap = true;
          oldCuts = [];
        }

        if (needsRemap) {
          console.log(`   ⚠️  Chunks out of sync with reel cuts/boundaries — remapping`);
          savedChunks = remapChunksForCuts(savedChunks, oldStart, oldEnd, oldCuts, startSec, endSec, currentCuts);
          if (savedChunks.length) {
            closeSubtitleGaps(savedChunks);
            fs.writeFileSync(clipChunksPath, JSON.stringify(savedChunks, null, 2));
            fs.writeFileSync(stateFilePath, JSON.stringify(currentState));
            console.log(`   📝 Remapped: ${savedChunks.length} chunks adjusted for ${currentCuts.length} cut(s)`);
          } else {
            savedChunks = null;
            try { fs.unlinkSync(clipChunksPath); } catch {}
            try { fs.unlinkSync(stateFilePath); } catch {}
            console.log(`   ⚠️  All proofread chunks fell inside cuts — regenerating from scratch`);
          }
        }
      }

      // Pre-compute reel cuts in seconds for word filtering
      const reelCutsSec = (reel.cuts || [])
        .map(c => ({ from: toSeconds(c.from), to: toSeconds(c.to) }))
        .filter(c => c.from > startSec && c.to < endSec && c.to > c.from);

      // Helper: get episode words for this reel, filtered for cuts with adjusted timestamps
      function getEpisodeWords() {
        let words = transcript.words.filter(w => w.start >= startSec && w.end <= endSec);
        if (reelCutsSec.length) words = filterWordsForCuts(words, startSec, endSec, reelCutsSec);
        return words;
      }

      if (noTranscribe) {
        // Use saved subtitle chunks if the user edited them in the transcript editor.
        // Also load words for the merge step below (clip transcript → episode fallback)
        // so that extended boundaries get fresh subtitles stitched in.
        const clipTranscriptPath = path.join(reelsDir, `reel-${reelId}-transcript.json`);
        if (savedChunks) {
          // Get words for potential merge — prefer clip transcript, fall back to episode
          if (fs.existsSync(clipTranscriptPath)) {
            const clipT = JSON.parse(fs.readFileSync(clipTranscriptPath, "utf8"));
            reelWords = reelWordsFromTranscript(clipT);
            wordStartOffset = 0;
          } else {
            reelWords = getEpisodeWords();
          }
          console.log(`   📝 Using ${savedChunks.length} saved subtitle chunks`);
        } else if (fs.existsSync(clipTranscriptPath)) {
          const clipT = JSON.parse(fs.readFileSync(clipTranscriptPath, "utf8"));
          // Reconstruct from segments so words missing from Whisper word-level
          // timing (e.g. first word of a segment) are filled in from segment text.
          reelWords = reelWordsFromTranscript(clipT);
          wordStartOffset = 0;
          console.log(`   📝 Using edited reel transcript: ${reelWords.length} words`);
        } else {
          console.log(`   ⚠️  No reel transcript found, falling back to episode transcript`);
          reelWords = getEpisodeWords();
        }
      } else if (force || isYouTubeTranscript) {
        const clipTranscriptPath = path.join(reelsDir, `reel-${reelId}-transcript.json`);
        // Skip retranscription if the cut file hasn't changed since last transcription
        // (e.g., only a crop happened — same audio, different visuals)
        const cutMtime = fs.existsSync(rawReelPath) ? fs.statSync(rawReelPath).mtimeMs : 0;
        const txMtime = fs.existsSync(clipTranscriptPath) ? fs.statSync(clipTranscriptPath).mtimeMs : 0;
        if (txMtime > cutMtime && fs.existsSync(clipTranscriptPath)) {
          const clipT = JSON.parse(fs.readFileSync(clipTranscriptPath, "utf8"));
          const cachedWords = reelWordsFromTranscript(clipT);
          if (cachedWords.length > 0) {
            console.log(`   ♻️  Reusing reel transcript (cut unchanged): ${cachedWords.length} words`);
            reelWords = cachedWords;
            wordStartOffset = 0;
          }
        }
        if (!reelWords) {
          console.log(`   🎙️  Re-transcribing reel clip (force=${force})...`);
          const whisperWords = whisperTranscribeClip(videoPath, clipTranscriptPath);
          if (whisperWords && whisperWords.length > 0) {
            reelWords = whisperWords;
            wordStartOffset = 0; // clip timestamps are already 0-indexed
          } else {
            console.log(`   ⚠️  Falling back to episode transcript words`);
            reelWords = getEpisodeWords();
          }
        }
      } else {
        reelWords = getEpisodeWords();
      }

      // Merge: if proofread chunks exist AND we have fresh words (from any source),
      // keep the proofread chunks and only generate new chunks for uncovered portions.
      // This handles the case where a user proofreads subtitles, then extends the reel.
      if (savedChunks && savedChunks.length && reelWords && reelWords.length) {
        // When a reel is re-cut with a different start boundary, the clip is
        // re-transcribed with fresh 0-indexed timestamps. The saved chunks still
        // carry timestamps from the OLD clip. Detect the misalignment by matching
        // chunk text against the new transcript and shift chunk times accordingly.
        const shift = detectChunkShift(savedChunks, reelWords, wordStartOffset);
        if (shift !== 0) {
          console.log(`   🔄 Chunks misaligned by ${shift > 0 ? '+' : ''}${shift.toFixed(1)}s — shifting timestamps`);
          savedChunks.forEach(c => { c.start += shift; c.end += shift; });

          // Trim chunks that now fall outside the clip (e.g. reel was also
          // shortened from the end, or a cut was added)
          const clipEnd = Math.max(...reelWords.map(w => w.end - wordStartOffset));
          savedChunks = savedChunks.filter(c => c.start < clipEnd && c.end > 0);
          if (savedChunks.length) {
            savedChunks[0].start = Math.max(0, savedChunks[0].start);
            savedChunks[savedChunks.length - 1].end = Math.min(
              savedChunks[savedChunks.length - 1].end, clipEnd
            );
          }
        }

        // Account for internal cuts when computing actual video duration
        const mergeReelCuts = (reel.cuts || [])
          .map(c => ({ from: toSeconds(c.from), to: toSeconds(c.to) }))
          .filter(c => c.from > startSec && c.to < endSec && c.to > c.from);
        const mergeCutDuration = mergeReelCuts.reduce((sum, c) => sum + (c.to - c.from), 0);
        const reelDuration = endSec - startSec - mergeCutDuration;
        const chunksEnd = savedChunks.length ? Math.max(...savedChunks.map(c => c.end)) : 0;
        const chunksStart = savedChunks.length ? Math.min(...savedChunks.map(c => c.start)) : 0;

        let prependChunks = [];
        let appendChunks = [];

        // Fresh words before proofread chunks (user extended start earlier)
        if (chunksStart > 0.5) {
          const earlyWords = reelWords.filter(w => (w.start - wordStartOffset) >= 0 && (w.end - wordStartOffset) < chunksStart);
          if (earlyWords.length) {
            prependChunks = chunkWords(earlyWords, wordStartOffset);
            if (prependChunks.length) {
              const last = prependChunks[prependChunks.length - 1];
              if (last.end > chunksStart) last.end = chunksStart;
            }
            console.log(`   📝 Prepending ${prependChunks.length} chunks for extended start`);
          }
        }

        // Fresh words after proofread chunks (user extended end later)
        if (reelDuration - chunksEnd > 0.5) {
          const lateWords = reelWords.filter(w => (w.start - wordStartOffset) >= chunksEnd);
          if (lateWords.length) {
            appendChunks = chunkWords(lateWords, wordStartOffset);
            console.log(`   📝 Appending ${appendChunks.length} chunks for extended end`);
          }
        }

        if (prependChunks.length || appendChunks.length) {
          savedChunks = [...prependChunks, ...savedChunks, ...appendChunks];
          closeSubtitleGaps(savedChunks);
          reelWords = []; // proofread + new are all in savedChunks now
          // Persist merged chunks so the transcript editor sees them too
          fs.writeFileSync(clipChunksPath, JSON.stringify(savedChunks, null, 2));
          // Update state file so future runs know chunks match current reel state
          const mergeStatePath = path.join(reelsDir, `reel-${reelId}-chunks-state.json`);
          const mergeCutsForState = (reel.cuts || [])
            .map(c => ({ from: toSeconds(c.from), to: toSeconds(c.to) }))
            .filter(c => c.from > startSec && c.to < endSec && c.to > c.from);
          fs.writeFileSync(mergeStatePath, JSON.stringify({ start: startSec, end: endSec, cuts: mergeCutsForState }));
          console.log(`   📝 Merged: ${savedChunks.length} total chunks (proofread + new)`);
        }
      }

      // Detect actual video dimensions so ASS PlayRes matches
      const videoDims = getVideoDimensions(videoPath);
      console.log(`   📐 Video dimensions: ${videoDims.width}x${videoDims.height}`);

      // Always use ASS format — embedded styles avoid force_style FFmpeg parsing issues
      const subtitleContent = generateASS(reelWords, wordStartOffset, titleCard ? reelTitle : null, videoDims, subtitleStyle, savedChunks);

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

    // Generate a bottom gradient overlay (transparent top → semi-dark bottom)
    // This gives a smooth gaussian vignette behind subtitles that ASS blur can't achieve.
    const videoDimsForGrad = getVideoDimensions(videoPath);
    const gradW = videoDimsForGrad.width;
    const gradH = videoDimsForGrad.height;
    const tmpGrad = path.join(os.tmpdir(), `tajarib-grad-${reelId}.png`);
    // Alpha ramps from 0 at 40% height to ~130 (out of 255) at bottom = ~50% darken
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i",
      `color=black:size=${gradW}x${gradH}:d=1,format=rgba,geq=r=0:g=0:b=0:a='if(gt(Y,H*0.4),min(166,(Y-H*0.4)/(H*0.6)*166),0)'`,
      "-frames:v", "1", tmpGrad
    ], { stdio: "pipe" });

    // Overlay gradient then burn ASS subtitles
    const ffmpegArgs = [
      "-y",
      "-i", videoPath,
      "-i", tmpGrad,
      "-filter_complex", `[0:v][1:v]overlay=format=auto,ass='${escapedSubtitle}'`,
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
      if (fs.existsSync(tmpGrad)) fs.unlinkSync(tmpGrad);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const size = (fs.statSync(subtitledPath).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ Done in ${duration}s (${size} MB)`);
      // Remove stale -final.mp4 (overlay) since subtitles changed — overlay needs re-run
      const finalPath = path.join(reelsDir, `reel-${reelId}-final.mp4`);
      if (fs.existsSync(finalPath)) {
        fs.unlinkSync(finalPath);
        console.log(`   🗑️  Removed stale overlay: reel-${reelId}-final.mp4`);
      }
    } catch (e) {
      // Clean up temp files on error
      try { fs.unlinkSync(tmpSub); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
      console.error(`   ❌ Subtitle burn failed:`, e.stderr?.toString() || e.message);
    }
  }

  console.log(`\n✅ All done! Subtitled reels saved to: ${reelsDir}`);
}

module.exports = { formatSRTTime, formatASSTime, closeSubtitleGaps, remapChunksForCuts, filterWordsForCuts, chunkWords, generateSRT, generateASS, reelWordsFromTranscript, MAX_GAP_FILL, TITLE_DURATION };

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const slug = get("--slug");
  const force = args.includes("--force");
  const titleCard = args.includes("--title-card");
  const burnOnly = args.includes("--burn-only");
  const noTranscribe = args.includes("--no-transcribe");
  const reelId = get("--reel-id");
  const subtitleStyle = get("--subtitle-style") || "animated"; // "animated" or "static"

  if (!slug) {
    console.error("Usage: node subtitle.js --slug <slug> [--force] [--title-card] [--burn-only] [--no-transcribe] [--subtitle-style animated|static]");
    process.exit(1);
  }
  if (!["animated", "static"].includes(subtitleStyle)) {
    console.error(`❌ Invalid --subtitle-style "${subtitleStyle}". Use "animated" or "static".`);
    process.exit(1);
  }
  subtitle(slug, force, titleCard, reelId, burnOnly, subtitleStyle, noTranscribe).catch(err => { console.error("❌", err.message); process.exit(1); });
}
