#!/usr/bin/env node
/**
 * Webhook receiver — auto-deploy on push to main.
 *
 * Verifies GitHub's X-Hub-Signature-256 (HMAC-SHA256 with WEBHOOK_SECRET)
 * and runs `git pull && docker compose up -d --build` when a push to the
 * configured branch arrives.
 *
 * Runs inside its own container (Dockerfile.webhook). The container has
 * docker-cli, git, and bind-mounts the repo at /repo and the host's
 * docker socket so it can rebuild the app container in place.
 */
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.WEBHOOK_LISTEN_PORT || "9000", 10);
const SECRET = process.env.WEBHOOK_SECRET || "";
const BRANCH = process.env.WEBHOOK_BRANCH || "main";
const REPO_DIR = "/repo";

if (!SECRET) {
  console.error("[webhook] FATAL: WEBHOOK_SECRET is not set. Refusing to start.");
  process.exit(1);
}

let deploying = false;

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verify(rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
  return timingSafeEqualStr(expected, signatureHeader);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: REPO_DIR, stdio: "inherit", ...opts });
    p.on("close", (code) => resolve(code));
    p.on("error", (err) => { console.error("[webhook] spawn error:", err.message); resolve(1); });
  });
}

function capture(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: REPO_DIR });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
}

async function deploy() {
  if (deploying) { console.log("[webhook] deploy already in progress, skipping"); return; }
  deploying = true;
  try {
    console.log(`[webhook] deploying ${BRANCH}…`);
    let code = await run("git", ["fetch", "--all", "--prune"]);
    if (code !== 0) throw new Error("git fetch failed");
    code = await run("git", ["reset", "--hard", `origin/${BRANCH}`]);
    if (code !== 0) throw new Error("git reset failed");
    // Capture SHA + build time so the dashboard version chip reflects what's
    // actually running.
    const sha = await capture("git", ["rev-parse", "--short", "HEAD"]);
    const buildTime = new Date().toISOString();
    const buildEnv = { ...process.env, GIT_SHA: sha || "dev", BUILD_TIME: buildTime };
    // Build all images, but only recreate the app container — recreating
    // ourselves would kill this script mid-deploy. Webhook updates require
    // a manual `docker compose up -d --build webhook` from the host.
    code = await run("docker", ["compose", "build", "app"], { env: buildEnv });
    if (code !== 0) throw new Error("docker compose build failed");
    code = await run("docker", ["compose", "up", "-d", "--no-deps", "app"], { env: buildEnv });
    if (code !== 0) throw new Error("docker compose up failed");
    console.log("[webhook] deploy complete");
  } catch (err) {
    console.error("[webhook] deploy failed:", err.message);
  } finally {
    deploying = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); return;
  }
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404); res.end(); return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    if (!verify(raw, req.headers["x-hub-signature-256"])) {
      console.warn("[webhook] invalid signature");
      res.writeHead(401); res.end("invalid signature"); return;
    }

    const event = req.headers["x-github-event"];
    if (event === "ping") { res.writeHead(200); res.end("pong"); return; }
    if (event !== "push") { res.writeHead(200); res.end("ignored"); return; }

    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); }
    catch (_) { res.writeHead(400); res.end("invalid json"); return; }

    const ref = payload.ref || "";
    if (ref !== `refs/heads/${BRANCH}`) {
      res.writeHead(200); res.end(`ignored (ref=${ref})`); return;
    }

    res.writeHead(202); res.end("deploying");
    deploy();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[webhook] listening on :${PORT}, branch=${BRANCH}`);
});
