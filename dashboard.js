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
const EPISODES_DIR = path.join(WORKSPACE_DIR, "episodes");
const UPLOADS_DIR = path.join(WORKSPACE_DIR, "uploads");
const GUESTS_FILE = path.join(WORKSPACE_DIR, "guests.json");
const BUFFER_CONFIG_FILE = path.join(WORKSPACE_DIR, "buffer-config.json");

[EPISODES_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

process.on("uncaughtException", (err) => { console.error("[UNCAUGHT]", err.message, err.stack?.split("\n")[1]); });
process.on("unhandledRejection", (err) => { console.error("[UNHANDLED REJECTION]", err?.message || err); });

const PYTHON_BIN = path.join(WORKSPACE_DIR, ".venv", "bin", "python3");
const NODE_BIN = process.execPath;

// ─── Server + Shared State ───────────────────────────────────────────────────

const server = http.createServer(handler);
const io = socketIo(server, { maxHttpBufferSize: 5e9 });

const ctx = {
  io, PORT, WORKSPACE_DIR, EPISODES_DIR, UPLOADS_DIR, GUESTS_FILE, BUFFER_CONFIG_FILE,
  PYTHON_BIN, NODE_BIN,
  activeProcesses: {}, activeSteps: {}, serverLogs: {}, logs: {},
  pendingManualLLM: new Map(),
  formidable, buffer, llm, prompts,
};

// ─── Initialize Modules (order matters — later modules depend on earlier ones) ─

Object.assign(ctx, require("./server/helpers")(ctx));
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
    if (ctx.activeProcesses[slug]) {
      const proc = ctx.activeProcesses[slug];
      try { process.kill(-proc.pid, "SIGKILL"); } catch (_) { try { proc.kill("SIGKILL"); } catch (_2) {} }
      delete ctx.activeProcesses[slug]; delete ctx.activeSteps[slug];
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
  for (const [slug, proc] of Object.entries(ctx.activeProcesses)) {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch (e) { try { proc.kill('SIGTERM'); } catch (_) {} }
    delete ctx.activeProcesses[slug];
  }
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─── Orphaned Upload Cleanup ─────────────────────────────────────────────────

function cleanupOrphanedUploads() {
  const state = ctx.loadUploadsState ? ctx.loadUploadsState() : {};
  let cleaned = 0;
  for (const [uploadId, upload] of Object.entries(state)) {
    const age = Date.now() - new Date(upload.createdAt).getTime();
    if (age > 24 * 60 * 60 * 1000) { ctx.cleanupUploadState(uploadId); cleaned++; }
  }
  if (cleaned > 0) console.log(`[Cleanup] Removed ${cleaned} orphaned uploads`);
}

// ─── Start Server ────────────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log("🎙️  Tajarib Dashboard DEV → http://76.13.145.146:" + PORT);
  cleanupOrphanedUploads();
  setInterval(cleanupOrphanedUploads, 60 * 60 * 1000);
});
