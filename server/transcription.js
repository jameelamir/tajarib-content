/**
 * Transcription services — local Whisper, YouTube transcript fetch, JSON3 conversion.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

module.exports = function init(ctx) {
  const { io, WORKSPACE_DIR, EPISODES_DIR, PYTHON_BIN, activeProcesses, handlePostTranscription } = ctx;

  function startTranscription(slug, finalPath, transcribeMethod) {
    io.emit("log", { slug, text: `▶ Starting transcription (${transcribeMethod})...\n` });
    const args = ["-u", "transcribe.py", finalPath, "--slug", slug];
    if (transcribeMethod === "api") args.push("--api");

    const proc = spawn(PYTHON_BIN, args, { cwd: WORKSPACE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcesses[slug] = proc;
    proc.stdout.on("data", d => io.emit("log", { slug, text: d.toString() }));
    proc.stderr.on("data", d => io.emit("log", { slug, text: d.toString() }));
    proc.on("close", async (code) => {
      delete activeProcesses[slug];
      io.emit("log", { slug, text: `\nTranscription complete. Exit: ${code}\n` });
      io.emit("status-update", {});
      if (code === 0) await handlePostTranscription(slug);
    });
  }

  function tryFetchYouTubeTranscript(slug, videoUrl) {
    return new Promise((resolve) => {
      const epDir = path.join(EPISODES_DIR, slug);
      io.emit("log", { slug, text: "\n📝 Checking for YouTube transcript...\n" });

      const args = ["--write-subs", "--write-auto-subs", "--sub-langs", "ar.*,ar,en.*,en",
        "--sub-format", "json3", "--skip-download", "-o", path.join(epDir, "yt-subs"),
        "--no-warnings", videoUrl];

      const proc = spawn("yt-dlp", args, { cwd: WORKSPACE_DIR, stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", d => io.emit("log", { slug, text: d.toString() }));
      proc.stderr.on("data", d => io.emit("log", { slug, text: d.toString() }));

      proc.on("close", () => {
        let files;
        try { files = fs.readdirSync(epDir).filter(f => f.startsWith("yt-subs") && f.endsWith(".json3")); }
        catch { files = []; }

        if (files.length === 0) {
          io.emit("log", { slug, text: "⚠️ No YouTube transcript found. Will use Whisper.\n" });
          return resolve(false);
        }

        const arFile = files.find(f => f.includes(".ar"));
        const enFile = files.find(f => f.includes(".en"));
        const selectedFile = arFile || enFile || files[0];
        const lang = selectedFile.includes(".ar") ? "ar" : (selectedFile.includes(".en") ? "en" : "unknown");

        io.emit("log", { slug, text: `✅ Found YouTube transcript: ${selectedFile} (${lang})\n` });

        try {
          const raw = JSON.parse(fs.readFileSync(path.join(epDir, selectedFile), "utf-8"));
          const transcript = convertYouTubeJson3(raw, slug, videoUrl, lang);
          if (transcript.segment_count === 0) {
            io.emit("log", { slug, text: "⚠️ YouTube transcript was empty. Will use Whisper.\n" });
            return resolve(false);
          }
          fs.writeFileSync(path.join(epDir, "transcript.json"), JSON.stringify(transcript, null, 2), "utf-8");
          io.emit("log", { slug, text: `✅ YouTube transcript saved: ${transcript.segment_count} segments, ${transcript.word_count} words\n` });
          files.forEach(f => { try { fs.unlinkSync(path.join(epDir, f)); } catch {} });
          resolve(true);
        } catch (err) {
          io.emit("log", { slug, text: `⚠️ Failed to parse YouTube transcript: ${err.message}. Will use Whisper.\n` });
          resolve(false);
        }
      });
    });
  }

  function convertYouTubeJson3(raw, slug, sourceUrl, language) {
    const events = raw.events || [];
    const segments = [], wordsAll = [], fullTextParts = [];

    for (const event of events) {
      if (!event.segs || event.segs.length === 0) continue;
      const startMs = event.tStartMs || 0;
      const durationMs = event.dDurationMs || 0;
      const startSec = startMs / 1000;
      const endSec = (startMs + durationMs) / 1000;
      const segWords = [];
      let segText = "";

      for (const seg of event.segs) {
        const text = (seg.utf8 || "").replace(/\n/g, " ").trim();
        if (!text) continue;
        const wordStart = startSec + (seg.tOffsetMs || 0) / 1000;
        segText += (segText ? " " : "") + text;
        for (const word of text.split(/\s+/).filter(Boolean)) {
          const wordObj = { word, start: Math.round(wordStart * 1000) / 1000, end: Math.round(endSec * 1000) / 1000, probability: 1.0 };
          segWords.push(wordObj);
          wordsAll.push(wordObj);
        }
      }
      if (!segText.trim()) continue;
      segments.push({ id: segments.length, start: Math.round(startSec * 1000) / 1000, end: Math.round(endSec * 1000) / 1000, text: segText.trim(), words: segWords });
      fullTextParts.push(segText.trim());
    }

    const duration = segments.length > 0 ? segments[segments.length - 1].end : 0;
    return {
      slug, source_file: sourceUrl, language, language_probability: 1.0,
      duration_seconds: Math.round(duration * 1000) / 1000, model: "youtube-transcript",
      word_count: wordsAll.length, segment_count: segments.length,
      full_text: fullTextParts.join(" "), segments, words: wordsAll, api_provider: "youtube"
    };
  }

  return { startTranscription, tryFetchYouTubeTranscript, convertYouTubeJson3 };
};
