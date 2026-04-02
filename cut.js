#!/usr/bin/env node
/**
 * Step 4: Cut reels using FFmpeg (precise word-level timestamps).
 * Reads:  episodes/{slug}/analysis.json + transcript.json
 * Writes: episodes/{slug}/reels/reel-01.mp4, reel-02.mp4, ...
 *
 * Usage:
 *   node cut.js --slug my-episode --video /path/to/episode.mp4 [--force]
 */

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
const { toSeconds, EPISODES_DIR } = require("./utils");

// Find the nearest word/segment boundary in transcript for accurate FFmpeg cut
function snapToWord(words, targetSec, direction = "nearest") {
  if (!words || words.length === 0) return targetSec;
  let best = words[0];
  let bestDist = Infinity;
  for (const w of words) {
    const t = direction === "start" ? w.start : w.end;
    const dist = Math.abs(t - targetSec);
    if (dist < bestDist) { bestDist = dist; best = w; }
  }
  return direction === "start" ? best.start : best.end;
}

async function cut(slug, videoPath, force = false, reelId = null) {
  const dir = path.join(EPISODES_DIR, slug);
  const reelsDir = path.join(dir, "reels");
  const analysisPath = path.join(dir, "analysis.json");
  const transcriptPath = path.join(dir, "transcript.json");

  if (!fs.existsSync(analysisPath)) {
    console.error("❌ No analysis.json. Run analyze.js first.");
    process.exit(1);
  }
  if (!videoPath || !fs.existsSync(videoPath)) {
    console.error(`❌ Video file not found: ${videoPath}`);
    process.exit(1);
  }

  // Check ffmpeg
  try { execSync("ffmpeg -version", { stdio: "pipe" }); }
  catch { console.error("❌ ffmpeg not found. Install: apt install ffmpeg"); process.exit(1); }

  const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  // Use word-level timestamps if they have good coverage, otherwise fall back to segments.
  // A valid word list should have more entries than segments (each segment contains multiple words).
  const segments = transcript.segments || [];
  const words = (transcript.words && transcript.words.length > segments.length) ? transcript.words : segments;

  fs.mkdirSync(reelsDir, { recursive: true });

  let reels = analysis.reels || [];

  // Filter to a single reel if --reel-id is specified
  if (reelId) {
    const padded = String(reelId).padStart(2, "0");
    reels = reels.filter(r => String(r.id).padStart(2, "0") === padded);
    if (reels.length === 0) {
      console.error(`❌ Reel ${reelId} not found in analysis.json`);
      process.exit(1);
    }
    console.log(`🎯 Single reel mode: cutting reel ${padded} only`);
  }

  // Probe video stream duration to skip reels beyond it
  let videoDuration = Infinity;
  try {
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=duration", "-of", "json", videoPath
    ], { encoding: "utf8" }));
    const streamDur = parseFloat(probe.streams?.[0]?.duration);
    if (streamDur > 0) videoDuration = streamDur;
  } catch {}

  console.log(`✂️  Cutting ${reels.length} reels from: ${videoPath}`);
  if (videoDuration < Infinity) console.log(`   Video stream duration: ${(videoDuration / 60).toFixed(1)} min`);

  for (const reel of reels) {
    const outFile = path.join(reelsDir, `reel-${String(reel.id).padStart(2, "0")}.mp4`);

    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0 && !force) {
      console.log(`⏭️  Reel ${reel.id} already cut: ${outFile}`);
      continue;
    }

    // Clean up stale downstream files from previous cuts
    const reelPrefix = `reel-${String(reel.id).padStart(2, "0")}`;
    for (const suffix of ["-cropped.mp4", "-subtitled.mp4", "-final.mp4", ".ass", "-transcript.json"]) {
      const stale = path.join(reelsDir, reelPrefix + suffix);
      try { if (fs.existsSync(stale)) { fs.unlinkSync(stale); console.log(`   🗑️  Removed stale ${reelPrefix}${suffix}`); } } catch {}
    }

    const rawStart = toSeconds(reel.start);
    const rawEnd = toSeconds(reel.end);
    let startSec = snapToWord(words, rawStart, "start");
    let endSec = snapToWord(words, rawEnd, "end");
    let duration = endSec - startSec;

    // Safety: if snapping collapsed the duration (e.g. coarse SRT segments with no word
    // timestamps), fall back to raw timestamps so FFmpeg still gets a valid range.
    if (duration <= 0) {
      startSec = rawStart;
      endSec = rawEnd;
      duration = endSec - startSec;
    }

    if (startSec >= videoDuration) {
      console.log(`   ⏭️  Reel ${reel.id}: ${reel.start} is beyond video duration (${(videoDuration / 60).toFixed(1)} min), skipping`);
      continue;
    }

    // Build segments: if reel has middle cuts, split into kept segments
    const cuts = (reel.cuts || [])
      .map(c => ({ from: snapToWord(words, toSeconds(c.from), "end"), to: snapToWord(words, toSeconds(c.to), "start") }))
      .filter(c => c.from > startSec && c.to < endSec && c.to > c.from)
      .sort((a, b) => a.from - b.from);

    if (cuts.length === 0) {
      // Simple single-segment cut
      console.log(`   ✂️  Reel ${reel.id}: ${reel.start}→${reel.end} (${duration.toFixed(1)}s) → ${path.basename(outFile)}`);

      const ffmpegArgs = [
        "-y",
        "-ss", startSec.toFixed(3),
        "-i", videoPath,
        "-t", duration.toFixed(3),
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        outFile
      ];

      try {
        execFileSync("ffmpeg", ffmpegArgs, { stdio: "pipe" });
        const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
        console.log(`   ✅ ${size} MB`);
      } catch (e) {
        const stderr = e.stderr?.toString().slice(-200) || "";
        console.error(`   ❌ Reel ${reel.id} failed: ${stderr || e.message}`);
        try { if (fs.existsSync(outFile) && fs.statSync(outFile).size === 0) fs.unlinkSync(outFile); } catch {}
      }
    } else {
      // Multi-segment cut: extract kept segments, then concat
      const segments = [];
      let segStart = startSec;
      for (const c of cuts) {
        if (c.from > segStart) segments.push({ start: segStart, end: c.from });
        segStart = c.to;
      }
      if (segStart < endSec) segments.push({ start: segStart, end: endSec });

      const totalKept = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
      const totalRemoved = duration - totalKept;
      console.log(`   ✂️  Reel ${reel.id}: ${reel.start}→${reel.end} with ${cuts.length} cut(s) removed (${totalRemoved.toFixed(1)}s cut, ${totalKept.toFixed(1)}s kept) → ${path.basename(outFile)}`);

      const tempFiles = [];
      let segFailed = false;

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const tempFile = path.join(reelsDir, `_seg-${reel.id}-${i}.mp4`);
        tempFiles.push(tempFile);

        const segArgs = [
          "-y",
          "-ss", seg.start.toFixed(3),
          "-i", videoPath,
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
          console.error(`   ❌ Reel ${reel.id} segment ${i} failed: ${stderr || e.message}`);
          segFailed = true;
          break;
        }
      }

      if (!segFailed) {
        // Write concat list and merge
        const concatList = path.join(reelsDir, `_concat-${reel.id}.txt`);
        fs.writeFileSync(concatList, tempFiles.map(f => `file '${f}'`).join("\n"));

        try {
          execFileSync("ffmpeg", [
            "-y", "-f", "concat", "-safe", "0", "-i", concatList,
            "-c", "copy", "-movflags", "+faststart", outFile
          ], { stdio: "pipe" });
          const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
          console.log(`   ✅ ${size} MB (${segments.length} segments joined)`);
        } catch (e) {
          const stderr = e.stderr?.toString().slice(-200) || "";
          console.error(`   ❌ Reel ${reel.id} concat failed: ${stderr || e.message}`);
          try { if (fs.existsSync(outFile) && fs.statSync(outFile).size === 0) fs.unlinkSync(outFile); } catch {}
        }

        // Clean up temp files
        try { fs.unlinkSync(concatList); } catch {}
      }

      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  }

  console.log(`\n✅ Reels saved to: ${reelsDir}`);
}

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const video = get("--video");
const force = args.includes("--force");
const reelId = get("--reel-id");

if (!slug || !video) {
  console.error("Usage: node cut.js --slug <slug> --video /path/to/episode.mp4 [--force] [--reel-id NN]");
  process.exit(1);
}
cut(slug, video, force, reelId).catch(err => { console.error("❌", err.message); process.exit(1); });
