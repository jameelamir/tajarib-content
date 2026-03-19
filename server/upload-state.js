/**
 * Chunked upload state management — tracks in-progress multi-chunk uploads.
 */
const fs = require("fs");
const path = require("path");

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

module.exports = function init(ctx) {
  const { WORKSPACE_DIR, UPLOADS_DIR, loadJSON, saveJSON } = ctx;
  const UPLOADS_STATE_FILE = path.join(WORKSPACE_DIR, ".uploads-state.json");

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

  return { CHUNK_SIZE, loadUploadsState, saveUploadsState, cleanupUploadState };
};
