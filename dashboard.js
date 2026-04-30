#!/usr/bin/env node
/**
 * Tajarib Pipeline Dashboard — Entry Point
 * All business logic lives in server/ modules.
 */

const fs = require("fs");
const path = require("path");
if (!fs.existsSync(path.join(__dirname, "node_modules"))) {
  console.log("Installing dependencies...");
  require("child_process").execSync("npm install", { cwd: __dirname, stdio: "inherit" });
}

const http = require("http");
const socketIo = require("socket.io");
const { formidable } = require("formidable");
const buffer = require("./buffer");

const llm = require("./llm");
const prompts = require("./prompts");

const PORT = process.env.PORT || 7430;
const WORKSPACE_DIR = __dirname;
const SHARED_DIR = path.resolve(WORKSPACE_DIR, "..");
const EPISODES_DIR = process.env.EPISODES_DIR
  ? process.env.EPISODES_DIR
  : (fs.existsSync(SHARED_DIR) && SHARED_DIR !== WORKSPACE_DIR
      ? path.join(SHARED_DIR, "episodes")
      : path.join(WORKSPACE_DIR, "episodes"));
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(WORKSPACE_DIR, "uploads");
const { GLOBAL_CONFIG_DIR, GLOBAL_GUESTS_FILE, seedIfMissing } = require("./server/global-config");
const GUESTS_FILE = GLOBAL_GUESTS_FILE;
const SHARED_GUESTS_FILE = null;
seedIfMissing(GUESTS_FILE, path.join(WORKSPACE_DIR, "guests.json"));
const BUFFER_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "buffer-config.json");

[EPISODES_DIR, UPLOADS_DIR].forEach(d => {
  try { if (fs.lstatSync(d).isSymbolicLink()) fs.unlinkSync(d); } catch (_) {}
  fs.mkdirSync(d, { recursive: true });
});

process.on("uncaughtException", (err) => { console.error("[UNCAUGHT]", err.message, err.stack?.split("\n")[1]); });
process.on("unhandledRejection", (err) => { console.error("[UNHANDLED REJECTION]", err?.message || err); });

const VENV_PYTHON = path.join(WORKSPACE_DIR, ".venv", "bin", "python3");
const PYTHON_BIN = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
const NODE_BIN = process.execPath;

// ─── Server + Shared State ───────────────────────────────────────────────────

const server = http.createServer(handler);
const io = socketIo(server, { maxHttpBufferSize: 5e9 });

const ctx = {
  io, PORT, WORKSPACE_DIR, EPISODES_DIR, UPLOADS_DIR, GUESTS_FILE, SHARED_GUESTS_FILE, BUFFER_CONFIG_FILE,
  PYTHON_BIN, NODE_BIN,
  activeProcesses: {}, activeSteps: {}, serverLogs: {}, logs: {},
  pendingManualLLM: new Map(),
  formidable, buffer, llm, prompts,
};

// ─── Initialize Modules (order matters — later modules depend on earlier ones) ─

Object.assign(ctx, require("./server/helpers")(ctx));
Object.assign(ctx, require("./server/profiles")(ctx));
Object.assign(ctx, require("./server/storage")(ctx));
Object.assign(ctx, require("./server/ai-services")(ctx));
Object.assign(ctx, require("./server/episodes")(ctx));
Object.assign(ctx, require("./server/title-gen")(ctx));
Object.assign(ctx, require("./server/transcription")(ctx));
Object.assign(ctx, require("./server/upload-state")(ctx));
Object.assign(ctx, require("./server/publishing")(ctx));
Object.assign(ctx, require("./server/pipeline")(ctx));

// ─── Route Dispatch ──────────────────────────────────────────────────────────

const routes = [
  require("./server/routes/static"),
  require("./server/routes/settings"),
  require("./server/routes/storage-routes"),
  require("./server/routes/media-routes"),
  require("./server/routes/content-routes"),
  require("./server/routes/upload-routes"),
  require("./server/routes/publish-routes"),
  require("./server/routes/episodes-routes"),
  require("./server/routes/reel-routes"),
  require("./server/routes/pipeline-routes"),
];

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    for (const route of routes) {
      if (await route(req, res, url, ctx)) return;
    }
    res.writeHead(404); res.end("Not Found");
  } catch (err) {
    console.error("[Request Error]", req.method, req.url, err.message);
    try { res.writeHead(500); res.end("Internal Server Error"); } catch (_) {}
  }
}

// ─── Log Buffering ───────────────────────────────────────────────────────────

const MAX_LOG_SIZE = 100000;
function appendServerLog(slug, text) {
  if (!ctx.serverLogs[slug]) ctx.serverLogs[slug] = "";
  ctx.serverLogs[slug] += text;
  if (ctx.serverLogs[slug].length > MAX_LOG_SIZE) ctx.serverLogs[slug] = ctx.serverLogs[slug].slice(-MAX_LOG_SIZE);
}

(function patchIoEmit() {
  const origEmit = io.emit.bind(io);
  io.emit = function(event, ...args) {
    if (event === "log" && args[0] && args[0].slug && args[0].text) appendServerLog(args[0].slug, args[0].text);
    return origEmit(event, ...args);
  };
})();

// ─── Socket Handler ──────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  socket.emit("restore-state", { activeSteps: ctx.activeSteps, logs: ctx.serverLogs });

  socket.on("stop-step", ({ slug }) => {
    let stopped = false;
    for (const [key, proc] of Object.entries(ctx.activeProcesses)) {
      if (key === slug || key.startsWith(slug + ':')) {
        try { process.kill(-proc.pid, "SIGKILL"); } catch (_) { try { proc.kill("SIGKILL"); } catch (_2) {} }
        delete ctx.activeProcesses[key]; delete ctx.activeSteps[key];
        stopped = true;
      }
    }
    if (stopped) {
      io.emit("log", { slug, text: "\n🛑 Process stopped manually.\n" });
      io.emit("process-end", { slug, step: "stopped", code: -1 });
      io.emit("status-update", {});
    }
  });
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  const count = Object.keys(ctx.activeProcesses).length;
  console.log(`\n[${signal}] Shutting down, killing ${count} child process(es)...`);
  for (const [key, proc] of Object.entries(ctx.activeProcesses)) {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch (e) { try { proc.kill('SIGTERM'); } catch (_) {} }
    delete ctx.activeProcesses[key];
  }
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─── Orphaned Upload Recovery ────────────────────────────────────────────────

// If a chunked upload has all chunks on disk but the client never called
// /api/upload-complete (tab closed, network drop, container restart), the
// chunks would otherwise sit forever and the user would never see the episode.
// Auto-finalize on server startup and on a periodic sweep, using the metadata
// captured at upload-init time. Old uploads with missing chunks are pruned.
async function recoverOrphanedUploads() {
  const state = ctx.loadUploadsState ? ctx.loadUploadsState() : {};
  let finalized = 0, cleaned = 0;
  for (const [uploadId, upload] of Object.entries(state)) {
    const age = Date.now() - new Date(upload.createdAt).getTime();
    const allChunksReceived = upload.chunksReceived && upload.chunksReceived.length === upload.totalChunks;
    if (allChunksReceived && upload.status !== "finalizing" && age > 60 * 1000) {
      try {
        const slug = await ctx.finalizeUpload(uploadId, {});
        console.log(`[Recovery] Finalized orphaned upload ${uploadId} → ${slug}`);
        finalized++;
      } catch (err) {
        console.error(`[Recovery] Failed to finalize ${uploadId}: ${err.message}`);
        if (age > 24 * 60 * 60 * 1000) { ctx.cleanupUploadState(uploadId); cleaned++; }
      }
    } else if (age > 24 * 60 * 60 * 1000) {
      ctx.cleanupUploadState(uploadId); cleaned++;
    }
  }
  if (finalized > 0) console.log(`[Recovery] Finalized ${finalized} orphaned upload(s)`);
  if (cleaned > 0) console.log(`[Cleanup] Removed ${cleaned} stale upload(s)`);
}

// ─── Start Server ────────────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log("🎙️  Tajarib Dashboard DEV → http://76.13.145.146:" + PORT);
  recoverOrphanedUploads();
  setInterval(recoverOrphanedUploads, 60 * 60 * 1000);
});
