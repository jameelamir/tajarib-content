/**
 * Chunked upload state management — tracks in-progress multi-chunk uploads.
 */
const fs = require("fs");
const path = require("path");

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

module.exports = function init(ctx) {
  const { UPLOADS_DIR, EPISODES_DIR, loadJSON, saveJSON } = ctx;
  const { GLOBAL_CONFIG_DIR } = require("./global-config");
  const UPLOADS_STATE_FILE = path.join(GLOBAL_CONFIG_DIR, ".uploads-state.json");

  function loadUploadsState() {
    return loadJSON(UPLOADS_STATE_FILE) || {};
  }

  function saveUploadsState(state) {
    saveJSON(UPLOADS_STATE_FILE, state);
  }

  function cleanupUploadState(uploadId) {
    const state = loadUploadsState();
    delete state[uploadId];
    saveUploadsState(state);
    const chunkDir = path.join(UPLOADS_DIR, `.chunks-${uploadId}`);
    if (fs.existsSync(chunkDir)) {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    }
  }

  /**
   * Assemble a chunked upload into an episode directory and kick off transcription.
   * Used by the /api/upload-complete handler and the orphan-recovery sweep, so the
   * same state-machine and side effects run regardless of trigger.
   * Sets state[uploadId].status = "finalizing" first to prevent racing with another
   * caller (e.g. client retry colliding with the periodic sweep).
   */
  async function finalizeUpload(uploadId, overrides = {}) {
    const initialState = loadUploadsState();
    if (!initialState[uploadId]) throw new Error("Upload not found");
    const upload = initialState[uploadId];
    if (upload.status === "finalizing") throw new Error("Upload already finalizing");
    const missing = Array.from({ length: upload.totalChunks }, (_, i) => i)
      .filter(i => !upload.chunksReceived.includes(i));
    if (missing.length > 0) throw new Error(`Missing chunks: ${missing.join(", ")}`);

    initialState[uploadId].status = "finalizing";
    saveUploadsState(initialState);

    try {
      const rawSlugOverride = typeof overrides.slug === "string" ? overrides.slug.trim() : "";
      const overrideSlug = rawSlugOverride ? ctx.slugify(rawSlugOverride) : "";
      const safeSlug = overrideSlug || upload.slug;
      const pendingAiTitle = overrideSlug ? false : !!upload.pendingAiTitle;
      const guest = overrides.guest != null ? String(overrides.guest) : (upload.guest || "");
      const role = overrides.role != null ? String(overrides.role) : (upload.role || "");
      const mediaType = overrides.mediaType || upload.mediaType || "episode";
      const transcribeMethod = overrides.transcribeMethod || upload.transcribeMethod || "local";

      const epDir = path.join(EPISODES_DIR, safeSlug);
      fs.mkdirSync(epDir, { recursive: true });
      const ext = path.extname(upload.filename) || ".mp4";
      const dest = path.join(epDir, `raw${ext}`);
      const chunkDir = path.join(UPLOADS_DIR, `.chunks-${uploadId}`);
      const ws = fs.createWriteStream(dest);
      for (let i = 0; i < upload.totalChunks; i++) {
        const chunkData = fs.readFileSync(path.join(chunkDir, `chunk-${i}`));
        if (!ws.write(chunkData)) await new Promise(resolve => ws.once("drain", resolve));
      }
      ws.end();
      await new Promise((resolve, reject) => { ws.on("finish", resolve); ws.on("error", reject); });

      if (guest) ctx.addGuestToHistory(guest, role);
      ctx.saveMeta(safeSlug, {
        mediaType, originalFilename: upload.filename, createdAt: new Date().toISOString(),
        rawVideo: dest, transcribeMethod,
        ...(guest && { guest }), ...(role && { role }),
        ...(upload.owner && { owner: upload.owner }),
        ...(pendingAiTitle && { pendingAiTitle: true }),
      });
      ctx.io.emit("log", { slug: safeSlug, text: `\n📁 Uploaded: ${upload.filename}\n` });
      cleanupUploadState(uploadId);
      if (transcribeMethod === "skip") {
        ctx.io.emit("log", { slug: safeSlug, text: `⏭️ Transcription skipped — you can transcribe later from the episode view\n` });
      } else {
        ctx.startTranscription(safeSlug, dest, transcribeMethod);
      }
      ctx.io.emit("toast", { type: "success", message: `Upload complete → ${safeSlug}` });
      ctx.io.emit("status-update", {});
      return safeSlug;
    } catch (err) {
      const reverted = loadUploadsState();
      if (reverted[uploadId]) { reverted[uploadId].status = "pending"; saveUploadsState(reverted); }
      throw err;
    }
  }

  return { CHUNK_SIZE, loadUploadsState, saveUploadsState, cleanupUploadState, finalizeUpload };
};
