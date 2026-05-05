#!/usr/bin/env node
/**
 * Step 4.5: Strip filler words and silences from cut reels.
 * Reads:  episodes/{slug}/reels/reel-NN.mp4 + transcript.json + analysis.json
 * Writes: episodes/{slug}/reels/reel-NN-cleaned.mp4
 *
 * Usage:
 *   node clean.js --slug X --reel-id 01 [--force]
 *                 [--silence-threshold 0.7]   (gap in seconds; 0 disables)
 *                 [--no-fillers]              (disable filler removal)
 *                 [--padding 0.08]            (seconds kept around each removed range)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { toSeconds, EPISODES_DIR } = require("./utils");

// Conservative filler list. "like" / "you know" intentionally excluded — too
// risky for English/Arabic mixed speech. يعني is included as an Iraqi-Arabic
// staple but can produce false cuts on dense speech; user can disable.
const FILLERS = new Set([
  // English
  "um", "umm", "ummm", "uh", "uhh", "uhhh", "uhm", "er", "erm",
  "mm", "mmm", "hmm", "hmmm", "mhm",
  // Arabic
  "اه", "آه", "إه", "أه", "يعني", "يعنى", "إيه",
]);

function normalizeWord(w) {
  if (!w) return "";
  // Strip Arabic diacritics + Western punctuation; lowercase Latin.
  return String(w)
    .replace(/[ً-ْٰ]/g, "")
    .replace(/[.,!?;:،؟"'`()\[\]{}…—–-]/g, "")
    .trim()
    .toLowerCase();
}

function isFiller(word) {
  return FILLERS.has(normalizeWord(word));
}

function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push(cur);
    }
  }
  return out;
}

async function clean(slug, reelId, opts) {
  const dir = path.join(EPISODES_DIR, slug);
  const reelsDir = path.join(dir, "reels");
  const padded = String(reelId).padStart(2, "0");
  const inputFile = path.join(reelsDir, `reel-${padded}.mp4`);
  const outputFile = path.join(reelsDir, `reel-${padded}-cleaned.mp4`);
  const transcriptPath = path.join(dir, "transcript.json");
  const analysisPath = path.join(dir, "analysis.json");

  if (!fs.existsSync(inputFile)) {
    console.error(`❌ Reel not found: ${inputFile}. Run cut step first.`);
    process.exit(1);
  }
  if (!fs.existsSync(transcriptPath)) {
    console.error(`❌ No transcript.json — clean needs word-level timestamps.`);
    process.exit(1);
  }
  if (!fs.existsSync(analysisPath)) {
    console.error(`❌ No analysis.json — clean needs reel boundaries.`);
    process.exit(1);
  }

  if (fs.existsSync(outputFile) && !opts.force) {
    console.log(`⏭️  reel-${padded}-cleaned.mp4 already exists (use --force)`);
    return;
  }

  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  const reel = (analysis.reels || []).find(r => String(r.id).padStart(2, "0") === padded);
  if (!reel) { console.error(`❌ Reel ${padded} not in analysis.json`); process.exit(1); }

  const reelStart = toSeconds(reel.start);
  const reelEnd = toSeconds(reel.end);
  const reelDuration = reelEnd - reelStart;
  if (reelDuration <= 0) { console.error(`❌ Invalid reel window`); process.exit(1); }

  // Prefer per-reel Whisper re-transcription when available — those have real
  // word-level timing instead of synthesized-from-SRT (which would always show
  // zero gaps between words and defeat silence detection).
  const reelTranscriptPath = path.join(reelsDir, `reel-${padded}-transcript.json`);
  let useReelTranscript = false;
  if (fs.existsSync(reelTranscriptPath)) {
    try {
      const reelTx = JSON.parse(fs.readFileSync(reelTranscriptPath, "utf8"));
      if (reelTx.words && reelTx.words.length > 0) {
        transcript.words = reelTx.words.map(w => ({ ...w, start: w.start + reelStart, end: w.end + reelStart }));
        useReelTranscript = true;
        console.log(`   📝 Using reel-${padded}-transcript.json (${reelTx.words.length} words)`);
      }
    } catch {}
  }
  if (!useReelTranscript) {
    console.log(`   📝 Using episode transcript.json (run Sub once for per-reel timing if silence detection misses)`);
  }

  // Words that fall inside this reel (episode time), then translate to reel-local time.
  // Account for the reel's middle cuts: words inside a cut zone are skipped, and
  // anything past a cut is shifted earlier by the cumulative cut duration.
  const reelCuts = (reel.cuts || [])
    .map(c => ({ from: toSeconds(c.from), to: toSeconds(c.to) }))
    .filter(c => c.from > reelStart && c.to < reelEnd && c.to > c.from)
    .sort((a, b) => a.from - b.from);

  function toReelLocal(t) {
    // Returns null if t is inside a cut zone
    if (t < reelStart || t > reelEnd) return null;
    let shift = 0;
    for (const c of reelCuts) {
      if (t >= c.from && t <= c.to) return null;
      if (t > c.to) shift += (c.to - c.from);
    }
    return t - reelStart - shift;
  }

  const allWords = transcript.words || [];
  const reelWords = [];
  for (const w of allWords) {
    const start = toReelLocal(w.start);
    const end = toReelLocal(w.end);
    if (start === null || end === null) continue;
    if (end <= start) continue;
    reelWords.push({ start, end, word: w.word || w.text || "" });
  }

  if (reelWords.length === 0) {
    console.error(`❌ No words found inside reel window — was the transcript already filtered?`);
    process.exit(1);
  }

  reelWords.sort((a, b) => a.start - b.start);

  // 1. Filler ranges
  const fillerRanges = [];
  if (opts.fillers) {
    for (const w of reelWords) {
      if (isFiller(w.word)) {
        fillerRanges.push({ start: w.start, end: w.end, kind: "filler", word: w.word });
      }
    }
  }

  // 2. Silence ranges via word gaps
  const silenceRanges = [];
  if (opts.silenceThreshold > 0) {
    // Treat the segment before the first word and after the last word as gaps too
    const head = reelWords[0].start;
    if (head > opts.silenceThreshold) silenceRanges.push({ start: 0, end: head, kind: "silence" });
    for (let i = 0; i < reelWords.length - 1; i++) {
      const gap = reelWords[i + 1].start - reelWords[i].end;
      if (gap > opts.silenceThreshold) {
        silenceRanges.push({ start: reelWords[i].end, end: reelWords[i + 1].start, kind: "silence" });
      }
    }
    const tailGap = reelDuration - reelWords[reelWords.length - 1].end;
    if (tailGap > opts.silenceThreshold) {
      silenceRanges.push({ start: reelWords[reelWords.length - 1].end, end: reelDuration, kind: "silence" });
    }
  }

  // 3. Apply padding (shrink each range by `padding` on each side so cuts feel natural)
  const pad = opts.padding;
  const all = [...fillerRanges, ...silenceRanges]
    .map(r => ({ ...r, start: r.start + pad, end: r.end - pad }))
    .filter(r => r.end - r.start > 0.05); // drop ranges too short to matter

  if (all.length === 0) {
    console.log(`✨ Nothing to clean — copying reel-${padded}.mp4 as-is`);
    fs.copyFileSync(inputFile, outputFile);
    console.log(`   ✅ ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(1)} MB → reel-${padded}-cleaned.mp4`);
    return;
  }

  const merged = mergeRanges(all);

  // 4. Build kept segments (inverse of removed ranges)
  const kept = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start > cursor) kept.push({ start: cursor, end: r.start });
    cursor = r.end;
  }
  if (cursor < reelDuration) kept.push({ start: cursor, end: reelDuration });

  const totalKept = kept.reduce((s, k) => s + (k.end - k.start), 0);
  const totalRemoved = reelDuration - totalKept;
  const fillerCount = fillerRanges.length;
  const silenceCount = silenceRanges.length;
  console.log(`🧹 Cleaning reel ${padded}: ${fillerCount} fillers + ${silenceCount} silences = ${merged.length} ranges, ${totalRemoved.toFixed(1)}s removed (${(reelDuration).toFixed(1)}s → ${totalKept.toFixed(1)}s)`);

  if (kept.length === 0 || totalKept < 0.5) {
    console.error(`❌ Cleaning would remove (almost) the entire reel — refusing. Loosen the silence threshold or disable fillers.`);
    process.exit(1);
  }

  // 5. ffmpeg: extract each kept segment, concat
  const tempFiles = [];
  let segFailed = false;
  for (let i = 0; i < kept.length; i++) {
    const seg = kept[i];
    const tempFile = path.join(reelsDir, `_clean-${padded}-${i}.mp4`);
    tempFiles.push(tempFile);
    const segArgs = [
      "-y",
      "-ss", seg.start.toFixed(3),
      "-i", inputFile,
      "-t", (seg.end - seg.start).toFixed(3),
      "-c:v", "libx264", "-crf", "18", "-preset", "fast",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      tempFile
    ];
    try {
      execFileSync("ffmpeg", segArgs, { stdio: "pipe" });
    } catch (e) {
      const stderr = e.stderr?.toString().slice(-200) || "";
      console.error(`   ❌ Segment ${i} failed: ${stderr || e.message}`);
      segFailed = true;
      break;
    }
  }

  if (!segFailed) {
    if (kept.length === 1) {
      // Single segment — just rename
      fs.renameSync(tempFiles[0], outputFile);
      tempFiles.length = 0;
    } else {
      const concatList = path.join(reelsDir, `_clean-concat-${padded}.txt`);
      fs.writeFileSync(concatList, tempFiles.map(f => `file '${f}'`).join("\n"));
      try {
        execFileSync("ffmpeg", [
          "-y", "-f", "concat", "-safe", "0", "-i", concatList,
          "-c", "copy", "-movflags", "+faststart", outputFile
        ], { stdio: "pipe" });
      } catch (e) {
        const stderr = e.stderr?.toString().slice(-200) || "";
        console.error(`   ❌ Concat failed: ${stderr || e.message}`);
        segFailed = true;
      }
      try { fs.unlinkSync(concatList); } catch {}
    }
  }

  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch {}
  }

  if (segFailed) {
    try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch {}
    process.exit(1);
  }

  // Clear stale downstream files — they were built from the un-cleaned cut.
  for (const suffix of ["-cropped.mp4", "-subtitled.mp4", "-final.mp4", "-transcript.json"]) {
    const stale = path.join(reelsDir, `reel-${padded}${suffix}`);
    try { if (fs.existsSync(stale)) { fs.unlinkSync(stale); console.log(`   🗑️  Removed stale reel-${padded}${suffix}`); } } catch {}
  }

  const size = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(1);
  console.log(`   ✅ ${size} MB → reel-${padded}-cleaned.mp4`);
}

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const reelId = get("--reel-id");
const force = args.includes("--force");
const fillers = !args.includes("--no-fillers");
const silenceThreshold = parseFloat(get("--silence-threshold") ?? "0.7");
const padding = parseFloat(get("--padding") ?? "0.08");

if (!slug || !reelId) {
  console.error("Usage: node clean.js --slug <slug> --reel-id NN [--force] [--silence-threshold 0.7] [--no-fillers] [--padding 0.08]");
  process.exit(1);
}

clean(slug, reelId, { force, fillers, silenceThreshold, padding })
  .catch(err => { console.error("❌", err.message); process.exit(1); });
