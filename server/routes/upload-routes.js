/**
 * Upload routes — simple upload, chunked upload (init/chunk/complete/status), URL download.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

module.exports = async function uploadRoutes(req, res, url, ctx) {
  const { io, WORKSPACE_DIR, EPISODES_DIR, UPLOADS_DIR, loadJSON, saveJSON, loadMeta, saveMeta, parseSrt,
    addGuestToHistory, startTranscription, tryFetchYouTubeTranscript, handlePostTranscription,
    getStorageConfig, calcDirSize, loadUploadsState, saveUploadsState, cleanupUploadState, finalizeUpload,
    CHUNK_SIZE, formidable, activeProcesses, readBody, getProfileFromReq, slugify } = ctx;
  const owner = getProfileFromReq(req);

  if (req.method === "POST" && url.pathname === "/api/upload") {
    const form = formidable({ uploadDir: UPLOADS_DIR, keepExtensions: true, maxFileSize: 25 * 1024 * 1024 * 1024 });
    form.parse(req, async (err, fields, files) => {
      if (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); return; }
      try {
        const field = (v, fallback = "") => { const val = Array.isArray(v) ? v[0] : v; return (val != null ? String(val) : fallback); };
        const rawSlug = field(fields.slug).trim();
        const cleaned = slugify(rawSlug);
        const pendingAiTitle = !cleaned;
        const slug = pendingAiTitle ? `temp-${Date.now()}-${Math.random().toString(36).substr(2,6)}` : cleaned;
        const guest = field(fields.guest), role = field(fields.role);
        const mediaType = field(fields.mediaType, "episode"), transcribeMethod = field(fields.transcribeMethod, "local");
        const multiTrack = field(fields.multiTrack) === "true";
        const videoFile = files.video?.[0] || files.video;
        const speakerFile = files.speaker?.[0] || files.speaker;
        const guestFile = files.guestTrack?.[0] || files.guestTrack;
        const srtFile = files.srt?.[0] || files.srt;

        if (!videoFile && !multiTrack) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: "No video file provided" })); return; }
        if (multiTrack && (!speakerFile || !guestFile)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: "Multi-track requires both speaker and guest video files" })); return; }

        const storageConfig = getStorageConfig();
        const quotaBytes = storageConfig.quotaGB * 1024 * 1024 * 1024;
        const uploadSize = multiTrack ? ((speakerFile?.size || 0) + (guestFile?.size || 0)) : (videoFile?.size || 0);
        if (calcDirSize(EPISODES_DIR) + uploadSize > quotaBytes) { res.writeHead(413, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: `Upload would exceed storage quota (${storageConfig.quotaGB} GB).` })); return; }

        const epDir = path.join(EPISODES_DIR, slug); fs.mkdirSync(epDir, { recursive: true });
        let finalPath, metaExtra = {};
        if (multiTrack) {
          const spkExt = path.extname(speakerFile.originalFilename || "").toLowerCase() || ".mp4";
          const gstExt = path.extname(guestFile.originalFilename || "").toLowerCase() || ".mp4";
          const speakerPath = path.join(epDir, `speaker${spkExt}`), guestPath = path.join(epDir, `guest${gstExt}`);
          moveFile(speakerFile.filepath, speakerPath); moveFile(guestFile.filepath, guestPath);
          finalPath = speakerPath; metaExtra = { multiTrack: true, tracks: { speaker: speakerPath, guest: guestPath } };
          io.emit("log", { slug, text: `\n📁 Multi-track uploaded: speaker + guest\n` });
        } else {
          const ext = path.extname(videoFile.originalFilename || videoFile.newFilename || "").toLowerCase() || ".mp4";
          finalPath = path.join(epDir, `raw${ext}`);
          moveFile(videoFile.filepath, finalPath);
          io.emit("log", { slug, text: `\n📁 Uploaded: ${videoFile.originalFilename || videoFile.newFilename}\n` });
        }

        saveMeta(slug, { mediaType, originalFilename: multiTrack ? "multi-track" : (videoFile.originalFilename || videoFile.newFilename), createdAt: new Date().toISOString(), rawVideo: finalPath, guest, role, transcribeMethod, ...(owner && { owner }), ...(pendingAiTitle && { pendingAiTitle: true }), ...metaExtra });
        if (guest) addGuestToHistory(guest, role);

        if (srtFile) {
          const srtContent = fs.readFileSync(srtFile.filepath, 'utf-8');
          const transcriptData = parseSrt(srtContent);
          transcriptData.slug = slug; transcriptData.source_file = finalPath;
          saveJSON(path.join(epDir, "transcript.json"), transcriptData);
          const srtExt = path.extname(srtFile.originalFilename || ".srt").toLowerCase();
          fs.copyFileSync(srtFile.filepath, path.join(epDir, `uploaded${srtExt}`)); fs.unlinkSync(srtFile.filepath);
          io.emit("log", { slug, text: `📄 SRT uploaded — transcription skipped (${transcriptData.segment_count} segments)\n` });
          io.emit("status-update", {}); await handlePostTranscription(slug);
        } else if (transcribeMethod === 'skip') {
          io.emit("log", { slug, text: `⏭️ Transcription skipped — you can transcribe later from the episode view\n` });
          io.emit("status-update", {});
        } else { startTranscription(slug, finalPath, transcribeMethod); }

        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, slug }));
      } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/download-url") {
    const body = await readBody(req);
    try {
      const { url: videoUrl, slug: rawSlug, guest, role, mediaType, transcribeMethod } = JSON.parse(body);
      if (!videoUrl || !/^https?:\/\/.+/.test(videoUrl)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: "Invalid URL" })); return true; }
      const cleaned = slugify(rawSlug);
      const pendingAiTitle = !cleaned;
      const slug = pendingAiTitle ? `temp-${Date.now()}-${Math.random().toString(36).substr(2,6)}` : cleaned;
      const epDir = path.join(EPISODES_DIR, slug); fs.mkdirSync(epDir, { recursive: true });
      const outPath = path.join(epDir, "raw.mp4");

      io.emit("log", { slug, text: `\n🔗 Downloading: ${videoUrl}\n` });
      io.emit("download-progress", { slug, percent: 0, status: "downloading" });
      const ytdlpArgs = ["-f", "bestvideo[height<=1080]+bestaudio/best", "--merge-output-format", "mp4", "-o", outPath, "--newline", "--no-warnings", videoUrl];
      const proc = spawn("yt-dlp", ytdlpArgs, { cwd: WORKSPACE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
      activeProcesses[slug] = proc;

      const parseProgress = (line) => { const match = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\S+)\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/); if (match) io.emit("download-progress", { slug, percent: parseFloat(match[1]), size: match[2], speed: match[3], eta: match[4], status: "downloading" }); };
      proc.stdout.on("data", d => { const text = d.toString(); io.emit("log", { slug, text }); text.split("\n").forEach(parseProgress); });
      proc.stderr.on("data", d => { const text = d.toString(); io.emit("log", { slug, text }); text.split("\n").forEach(parseProgress); });

      proc.on("close", async (code) => {
        delete activeProcesses[slug];
        if (code !== 0 || !fs.existsSync(outPath)) { io.emit("log", { slug, text: `\n❌ Download failed (exit ${code})\n` }); io.emit("download-progress", { slug, percent: 0, status: "error" }); try { fs.rmSync(epDir, { recursive: true }); } catch {} return; }
        io.emit("log", { slug, text: `\n✅ Download complete\n` }); io.emit("download-progress", { slug, percent: 100, status: "done" });
        saveMeta(slug, { mediaType: mediaType || "episode", originalFilename: videoUrl, sourceUrl: videoUrl, createdAt: new Date().toISOString(), rawVideo: outPath, guest: guest || "", role: role || "", transcribeMethod: transcribeMethod || "local", ...(owner && { owner }), ...(pendingAiTitle && { pendingAiTitle: true }) });
        if (guest) addGuestToHistory(guest, role);
        io.emit("status-update", {});
        const gotYouTubeTranscript = await tryFetchYouTubeTranscript(slug, videoUrl);
        if (gotYouTubeTranscript) { io.emit("log", { slug, text: "📝 Using YouTube transcript — skipping Whisper.\n" }); await handlePostTranscription(slug); io.emit("status-update", {}); }
        else if ((transcribeMethod || "local") === "skip") { io.emit("log", { slug, text: "⏭️ Transcription skipped — you can transcribe later from the episode view\n" }); io.emit("status-update", {}); }
        else startTranscription(slug, outPath, transcribeMethod || "local");
      });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, slug }));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/upload-init") {
    const body = await readBody(req);
    try {
      const { filename, fileSize, slug, guest, role, mediaType, transcribeMethod } = JSON.parse(body);
      const uploadId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const cleaned = slugify(slug);
      const pendingAiTitle = !cleaned;
      const safeSlug = pendingAiTitle ? `temp-${Date.now()}-${Math.random().toString(36).substr(2,6)}` : cleaned;
      const state = loadUploadsState();
      state[uploadId] = { filename, fileSize, slug: safeSlug, guest, role, mediaType: mediaType || "episode", transcribeMethod: transcribeMethod || "local", pendingAiTitle, owner: owner || null, chunksReceived: [], totalChunks: Math.ceil(fileSize / CHUNK_SIZE), createdAt: new Date().toISOString(), status: "pending" };
      saveUploadsState(state);
      fs.mkdirSync(path.join(UPLOADS_DIR, `.chunks-${uploadId}`), { recursive: true });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, uploadId, chunkSize: CHUNK_SIZE, totalChunks: state[uploadId].totalChunks }));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/upload-chunk") {
    const uploadId = url.searchParams.get("uploadId"), chunkIndex = parseInt(url.searchParams.get("chunkIndex"));
    if (!uploadId || isNaN(chunkIndex)) { res.writeHead(400); res.end("Missing uploadId or chunkIndex"); return true; }
    const state = loadUploadsState();
    if (!state[uploadId]) { res.writeHead(404); res.end("Upload not found"); return true; }
    const chunkPath = path.join(UPLOADS_DIR, `.chunks-${uploadId}`, `chunk-${chunkIndex}`);
    const writeStream = fs.createWriteStream(chunkPath); req.pipe(writeStream);
    writeStream.on("finish", () => { state[uploadId].chunksReceived.push(chunkIndex); state[uploadId].chunksReceived = [...new Set(state[uploadId].chunksReceived)]; saveUploadsState(state); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, chunkIndex, received: state[uploadId].chunksReceived.length, total: state[uploadId].totalChunks })); });
    writeStream.on("error", (err) => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/upload-complete") {
    const body = await readBody(req);
    try {
      const overrides = JSON.parse(body);
      const { uploadId } = overrides;
      const safeSlug = await finalizeUpload(uploadId, overrides);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, slug: safeSlug }));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/upload-status") {
    const uploadId = url.searchParams.get("uploadId");
    if (!uploadId) { res.writeHead(400); res.end("Missing uploadId"); return true; }
    const state = loadUploadsState();
    if (!state[uploadId]) { res.writeHead(404); res.end("Upload not found"); return true; }
    const u = state[uploadId];
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, uploadId, filename: u.filename, fileSize: u.fileSize, totalChunks: u.totalChunks, chunkSize: CHUNK_SIZE, receivedChunks: u.chunksReceived.length, receivedIndexes: u.chunksReceived, status: u.status, slug: u.slug, guest: u.guest, role: u.role, mediaType: u.mediaType, transcribeMethod: u.transcribeMethod, pendingAiTitle: u.pendingAiTitle }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/uploads-pending") {
    const state = loadUploadsState();
    const list = Object.entries(state)
      .map(([uploadId, u]) => ({
        uploadId,
        filename: u.filename,
        fileSize: u.fileSize,
        slug: u.slug || "",
        guest: u.guest || "",
        role: u.role || "",
        mediaType: u.mediaType || "episode",
        transcribeMethod: u.transcribeMethod || "local",
        pendingAiTitle: !!u.pendingAiTitle,
        totalChunks: u.totalChunks,
        chunkSize: CHUNK_SIZE,
        receivedChunks: (u.chunksReceived || []).length,
        createdAt: u.createdAt,
        status: u.status,
        owner: u.owner || null,
      }))
      .filter(u => !owner || !u.owner || u.owner === owner)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, uploads: list }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/upload-cancel") {
    const body = await readBody(req);
    try {
      const { uploadId } = JSON.parse(body);
      if (!uploadId) throw new Error("Missing uploadId");
      const state = loadUploadsState();
      if (!state[uploadId]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Upload not found" }));
        return true;
      }
      if (state[uploadId].status === "finalizing") throw new Error("Upload is finalizing — cannot cancel");
      if (owner && state[uploadId].owner && state[uploadId].owner !== owner) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Not your upload" }));
        return true;
      }
      cleanupUploadState(uploadId);
      io.emit("status-update", {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  return false;
};
