#!/usr/bin/env node
/**
 * Tajarib Pipeline Dashboard — Production
 * Features: Guest history, Zapier webhook integration, YouTube title = opener
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const socketIo = require("socket.io");
const { formidable } = require("formidable");

const PORT = 7430;
const WORKSPACE_DIR = "/root/.openclaw/workspace/tajarib";
const EPISODES_DIR = path.join(WORKSPACE_DIR, "episodes");
const UPLOADS_DIR = path.join(WORKSPACE_DIR, "uploads");
const GUESTS_FILE = path.join(WORKSPACE_DIR, "guests.json");
const BUFFER_CONFIG_FILE = path.join(WORKSPACE_DIR, "buffer-config.json");

// Ensure dirs exist
[EPISODES_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const PYTHON_BIN = path.join(WORKSPACE_DIR, ".venv", "bin", "python3");
const NODE_BIN = process.execPath;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadJSON(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}

function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function loadMeta(slug) {
  return loadJSON(path.join(EPISODES_DIR, slug, "meta.json")) || {};
}

function saveMeta(slug, data) {
  const p = path.join(EPISODES_DIR, slug, "meta.json");
  const existing = loadMeta(slug);
  saveJSON(p, { ...existing, ...data });
}

// Guest history management
function getGuestHistory() {
  return loadJSON(GUESTS_FILE) || [];
}

function addGuestToHistory(guest, role) {
  const guests = getGuestHistory();
  const existing = guests.find(g => g.name === guest);
  if (!existing) {
    guests.push({ name: guest, role, used: 1, lastUsed: new Date().toISOString() });
  } else {
    existing.role = role || existing.role;
    existing.used++;
    existing.lastUsed = new Date().toISOString();
  }
  saveJSON(GUESTS_FILE, guests);
}

// Buffer config
function getBufferConfig() {
  return loadJSON(BUFFER_CONFIG_FILE) || { accessToken: null, enabled: false };
}

function saveBufferConfig(config) {
  saveJSON(BUFFER_CONFIG_FILE, config);
}

// ─── Episodes Scanner ────────────────────────────────────────────────────────

function getEpisodes() {
  if (!fs.existsSync(EPISODES_DIR)) return [];

  return fs.readdirSync(EPISODES_DIR)
    .filter(f => fs.statSync(path.join(EPISODES_DIR, f)).isDirectory())
    .map(slug => {
      const dir = path.join(EPISODES_DIR, slug);
      const meta = loadMeta(slug);
      const files = fs.readdirSync(dir);
      const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi|mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && !f.includes("reel") && !f.includes("final"));

      const transcript = fs.existsSync(path.join(dir, "transcript.json"));
      const analysis = fs.existsSync(path.join(dir, "analysis.json"));
      const content = loadJSON(path.join(dir, "content.json"));

      const reelsDir = path.join(dir, "reels");
      const reelCount = fs.existsSync(reelsDir) 
        ? fs.readdirSync(reelsDir).filter(f => f.endsWith(".mp4") && !f.includes("-subtitled")).length 
        : 0;
      
      // Count final videos: subtitled reels in reels/ OR full-subtitled.mp4 in main dir
      let finalCount = fs.existsSync(reelsDir) 
        ? fs.readdirSync(reelsDir).filter(f => f.endsWith("-subtitled.mp4")).length 
        : 0;
      // Also check for full-subtitled.mp4 (when no reels, just full video)
      if (fs.existsSync(path.join(dir, "full-subtitled.mp4"))) {
        finalCount += 1;
      }

      const mediaType = meta.mediaType || "episode";
      const guest = meta.guest || "";
      const role = meta.role || "";

      let videoSize = null;
      if (rawVideo) {
        try { videoSize = fs.statSync(path.join(dir, rawVideo)).size; } catch (e) {}
      }

      return {
        slug,
        mediaType,
        rawVideo,
        videoSize,
        guest,
        role,
        steps: { 
          transcribed: transcript, 
          analyzed: analysis, 
          generated: !!content, 
          cut: reelCount > 0, 
          subtitled: finalCount > 0,
          published: meta.published || false
        },
        content,
        counts: { reels: reelCount, final: finalCount }
      };
    })
    .sort((a, b) => {
      const ma = loadMeta(a.slug).createdAt || "";
      const mb = loadMeta(b.slug).createdAt || "";
      return mb.localeCompare(ma);
    });
}

// ─── Model API for Feedback Loop ─────────────────────────────────────────────

async function callModelForRevision(originalContent, feedback, transcriptText = null) {
  const AUTH_FILE = "/root/.openclaw/agents/main/agent/models.json";
  const AUTH_FALLBACK = "/root/.openclaw/agents/main/agent/auth.json";
  const BASE_URL = "https://api.haimaker.ai/v1";
  const MODEL = "auto";

  let apiKey;
  try {
    const m = loadJSON(AUTH_FILE);
    apiKey = m?.providers?.haimaker?.apiKey;
  } catch (_) {}
  if (!apiKey) {
    const auth = loadJSON(AUTH_FALLBACK);
    apiKey = auth?.haimaker?.key || auth?.anthropic?.key;
  }

  // Build prompt with transcript context if available
  let transcriptSection = '';
  if (transcriptText) {
    transcriptSection = `

---FULL TRANSCRIPT (for context on what was actually said)---
${transcriptText.substring(0, 8000)}${transcriptText.length > 8000 ? '...' : ''}
---END TRANSCRIPT---`;
  }

  const prompt = `You generated the following Arabic content for the Tajarib podcast:

---BEGIN CONTENT---
${originalContent}
---END CONTENT---${transcriptSection}

The user has provided this feedback:
"${feedback}"

Please return a revised version that incorporates the feedback exactly, keeping the same format and language style (Iraqi white Arabic). Use the transcript as reference for what was actually said in the audio. Output only the revised content — no explanations, no extra text.`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [
        { role: "system", content: "أنت كاتب محتوى لبودكاست تجارب. راجع المحتوى بناءً على ملاحظات المستخدم." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// ─── Zapier Webhook Integration ─────────────────────────────────────────────

// ─── Chunked Upload State ────────────────────────────────────────────────────

const UPLOADS_STATE_FILE = path.join(WORKSPACE_DIR, ".uploads-state.json");
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

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
  // Clean up chunk files
  const chunkDir = path.join(UPLOADS_DIR, `.chunks-${uploadId}`);
  if (fs.existsSync(chunkDir)) {
    fs.rmSync(chunkDir, { recursive: true, force: true });
  }
}

// ─── AI Title Generation ─────────────────────────────────────────────────────

/**
 * Generate a slug/title from transcript text using AI.
 * Returns { title: "...", slug: "..." }
 */
async function generateTitleFromTranscript(transcriptText, guest, role) {
  const AUTH_FILE = "/root/.openclaw/agents/main/agent/models.json";
  const AUTH_FALLBACK = "/root/.openclaw/agents/main/agent/auth.json";
  const BASE_URL = "https://api.haimaker.ai/v1";
  const MODEL = "auto";

  let apiKey;
  try {
    const m = loadJSON(AUTH_FILE);
    apiKey = m?.providers?.haimaker?.apiKey;
  } catch (_) {}
  if (!apiKey) {
    const auth = loadJSON(AUTH_FALLBACK);
    apiKey = auth?.haimaker?.key || auth?.anthropic?.key;
  }
  if (!apiKey) throw new Error("No API key available for title generation");

  const snippet = transcriptText.substring(0, 4000);
  const guestInfo = guest ? `Guest: ${guest}${role ? ' (' + role + ')' : ''}` : '';

  const prompt = `You are a slug generator for a podcast called "Tajarib" (تجارب). Based on this transcript snippet, generate a short, descriptive slug for the episode directory name.

${guestInfo ? guestInfo + '\n' : ''}Transcript:
${snippet}

Rules:
- The slug should be in English transliteration (lowercase, hyphens only, no special chars)
- Keep it short: 2-4 words max (e.g. "muhannad-siemens", "energy-crisis-iraq", "startup-journey")  
- If a guest name is provided, include a transliteration of their first name
- Focus on the main topic discussed
- Output ONLY the slug, nothing else — no quotes, no explanation`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 100,
      temperature: 0.3,
      messages: [
        { role: "system", content: "You generate short URL-safe slugs for podcast episodes. Output only the slug." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Title generation API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const rawSlug = (data.choices?.[0]?.message?.content || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  
  return rawSlug || "untitled-episode";
}

/**
 * Deduplicate a slug: if "my-slug" exists, try "my-slug-v2", "my-slug-v3", etc.
 */
function deduplicateSlug(baseSlug) {
  if (!fs.existsSync(path.join(EPISODES_DIR, baseSlug))) return baseSlug;
  
  // Check if the existing episode has the same or similar transcript (recurring content)
  let version = 2;
  while (fs.existsSync(path.join(EPISODES_DIR, `${baseSlug}-v${version}`))) {
    version++;
  }
  return `${baseSlug}-v${version}`;
}

/**
 * Rename an episode directory and update all references.
 * Returns the new slug.
 */
function renameEpisode(oldSlug, newSlug) {
  const oldDir = path.join(EPISODES_DIR, oldSlug);
  const newDir = path.join(EPISODES_DIR, newSlug);
  
  if (!fs.existsSync(oldDir)) throw new Error(`Episode ${oldSlug} not found`);
  if (fs.existsSync(newDir)) throw new Error(`Episode ${newSlug} already exists`);
  
  // Update meta.json rawVideo path before moving
  const meta = loadMeta(oldSlug);
  if (meta.rawVideo) {
    meta.rawVideo = meta.rawVideo.replace(oldSlug, newSlug);
  }
  
  // Rename the directory
  fs.renameSync(oldDir, newDir);
  
  // Save updated meta
  saveMeta(newSlug, meta);
  
  // Update logs if any
  if (logs[oldSlug]) {
    logs[newSlug] = logs[oldSlug];
    delete logs[oldSlug];
  }
  
  // Transfer active process reference
  if (activeProcesses[oldSlug]) {
    activeProcesses[newSlug] = activeProcesses[oldSlug];
    delete activeProcesses[oldSlug];
  }
  
  return newSlug;
}

/**
 * Post-transcription hook: generate AI title and rename if episode was auto-named.
 */
async function handlePostTranscription(slug) {
  const meta = loadMeta(slug);
  
  // Only auto-rename if the episode was marked for AI title generation
  if (!meta.pendingAiTitle) return slug;
  
  try {
    const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
    if (!fs.existsSync(transcriptPath)) return slug;
    
    const transcript = loadJSON(transcriptPath);
    const fullText = transcript.full_text || transcript.segments?.map(s => s.text).join(' ') || '';
    if (!fullText) return slug;
    
    io.emit("log", { slug, text: "\n🤖 Generating AI title from transcript...\n" });
    
    const aiSlug = await generateTitleFromTranscript(fullText, meta.guest, meta.role);
    const finalSlug = deduplicateSlug(aiSlug);
    
    io.emit("log", { slug, text: `📝 AI suggested: ${aiSlug}${finalSlug !== aiSlug ? ` → ${finalSlug} (deduplicated)` : ''}\n` });
    
    // Rename the episode
    const newSlug = renameEpisode(slug, finalSlug);
    
    // Clear the pending flag
    const newMeta = loadMeta(newSlug);
    delete newMeta.pendingAiTitle;
    saveMeta(newSlug, newMeta);
    
    io.emit("log", { slug: newSlug, text: `✅ Episode renamed: ${slug} → ${newSlug}\n` });
    io.emit("episode-renamed", { oldSlug: slug, newSlug });
    io.emit("status-update", {});
    io.emit("toast", { type: "success", message: `AI titled: ${newSlug}` });
    
    return newSlug;
  } catch (err) {
    console.error(`[AI Title] Error for ${slug}:`, err.message);
    io.emit("log", { slug, text: `\n⚠️ AI title generation failed: ${err.message}. Keeping current name.\n` });
    // Clear the flag so it doesn't retry
    const meta2 = loadMeta(slug);
    delete meta2.pendingAiTitle;
    saveMeta(slug, meta2);
    return slug;
  }
}

// In-memory logs store (referenced by rename logic)
const logs = {};

const ZAPIER_WEBHOOK_URL = "https://hooks.zapier.com/hooks/catch/25372282/uc0sion/";
const TRANSCRIPTION_CONFIG_FILE = path.join(WORKSPACE_DIR, "transcription-config.json");

// Transcription config - reads from main agent's config
function getTranscriptionConfig() {
  // First check if user has a transcription-specific override
  const localConfig = loadJSON(TRANSCRIPTION_CONFIG_FILE);
  
  // Then check main agent's models.json for the Haimaker key
  const mainAgentConfig = loadJSON("/root/.openclaw/agents/main/agent/models.json");
  const apiKey = mainAgentConfig?.providers?.haimaker?.apiKey;
  
  return {
    apiKey: apiKey || localConfig?.apiKey || null,
    defaultMethod: localConfig?.defaultMethod || "local"
  };
}

function saveTranscriptionConfig(config) {
  // Only save defaultMethod locally, don't duplicate the API key
  const existing = loadJSON(TRANSCRIPTION_CONFIG_FILE) || {};
  if (config.defaultMethod) existing.defaultMethod = config.defaultMethod;
  saveJSON(TRANSCRIPTION_CONFIG_FILE, existing);
}

const MAX_PUBLISH_SIZE = 95 * 1024 * 1024; // 95MB — leave headroom under Buffer's 100MB Instagram limit

/**
 * Compress a video to fit under MAX_PUBLISH_SIZE using ffmpeg two-pass or CRF.
 * Returns the path to the compressed file (or original if already small enough).
 */
function compressForPublish(videoPath, slug) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(videoPath);
    if (stat.size <= MAX_PUBLISH_SIZE) {
      console.log(`[Compress] ${slug}: ${(stat.size/1024/1024).toFixed(1)}MB — already under limit, skipping`);
      return resolve(videoPath);
    }

    const dir = path.dirname(videoPath);
    const compressedPath = path.join(dir, "publish-compressed.mp4");

    // If we already have a compressed version that's small enough, reuse it
    if (fs.existsSync(compressedPath)) {
      const cStat = fs.statSync(compressedPath);
      if (cStat.size <= MAX_PUBLISH_SIZE && cStat.size > 0) {
        console.log(`[Compress] ${slug}: reusing existing compressed file (${(cStat.size/1024/1024).toFixed(1)}MB)`);
        return resolve(compressedPath);
      }
      fs.unlinkSync(compressedPath); // stale, redo
    }

    // Get duration to calculate target bitrate
    const { execSync } = require("child_process");
    let duration;
    try {
      const probe = execSync(
        `ffprobe -v quiet -print_format json -show_format "${videoPath}"`,
        { encoding: "utf8" }
      );
      duration = parseFloat(JSON.parse(probe).format.duration);
    } catch (e) {
      return reject(new Error("Could not probe video duration"));
    }

    // Target ~90MB to leave margin
    const targetBytes = 90 * 1024 * 1024;
    const targetBitrate = Math.floor((targetBytes * 8) / duration / 1000); // kbps
    const audioBitrate = 128; // kbps
    const videoBitrate = Math.max(500, targetBitrate - audioBitrate); // at least 500kbps

    console.log(`[Compress] ${slug}: ${(stat.size/1024/1024).toFixed(1)}MB → target ${videoBitrate}k video + ${audioBitrate}k audio (${duration.toFixed(1)}s)`);
    io.emit("log", { slug, text: `\n🗜️ Compressing for publish: ${(stat.size/1024/1024).toFixed(0)}MB → ~90MB target...\n` });

    const ffArgs = [
      "-i", videoPath,
      "-c:v", "libx264",
      "-b:v", `${videoBitrate}k`,
      "-maxrate", `${Math.floor(videoBitrate * 1.5)}k`,
      "-bufsize", `${videoBitrate * 2}k`,
      "-preset", "fast",
      "-c:a", "aac",
      "-b:a", `${audioBitrate}k`,
      "-movflags", "+faststart",
      "-y",
      compressedPath
    ];

    const proc = spawn("ffmpeg", ffArgs, { cwd: dir });

    proc.stderr.on("data", d => {
      const line = d.toString();
      // Only emit progress lines (frame=...) to avoid log spam
      if (line.includes("frame=") || line.includes("time=")) {
        io.emit("log", { slug, text: line });
      }
    });

    proc.on("error", err => reject(new Error(`ffmpeg failed to start: ${err.message}`)));

    proc.on("close", code => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }
      const finalStat = fs.statSync(compressedPath);
      const finalMB = (finalStat.size / 1024 / 1024).toFixed(1);
      console.log(`[Compress] ${slug}: compressed to ${finalMB}MB`);
      io.emit("log", { slug, text: `\n✅ Compressed: ${finalMB}MB\n` });
      resolve(compressedPath);
    });
  });
}

async function publishViaZapier(slug, caption, videoPath) {
  // Send webhook to Zapier with caption and video URL
  const meta = loadMeta(slug);

  // Determine which video type to serve (compressed takes priority)
  const dir = path.join(EPISODES_DIR, slug);
  const compressedPath = path.join(dir, "publish-compressed.mp4");
  let videoType;
  if (fs.existsSync(compressedPath)) {
    videoType = "compressed";
  } else {
    const isReelFull = meta.mediaType === "reel_full";
    videoType = isReelFull ? "raw" : "subtitled";
  }
  const videoUrl = `http://76.13.145.146:7430/api/video?slug=${slug}&type=${videoType}`;
  
  const payload = {
    slug,
    caption,
    videoUrl,
    videoFilename: path.basename(videoPath),
    timestamp: new Date().toISOString(),
    source: "tajarib-dashboard"
  };

  const res = await fetch(ZAPIER_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  
  if (!res.ok) {
    throw new Error(`Zapier webhook failed: ${res.status}`);
  }
  
  return { success: true, service: "zapier" };
}

// ─── Server Setup ────────────────────────────────────────────────────────────

const server = http.createServer(handler);
const io = socketIo(server, { maxHttpBufferSize: 5e9 });
const activeProcesses = {};

async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // ── Main page ─────────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/") {
    const indexPath = path.join(__dirname, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(indexPath, "utf8"));
    } else {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("index.html not found");
    }
    return;
  }

  // ── Static files (favicon, etc) ───────────────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/")) {
    const filePath = path.join(__dirname, "public", url.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = {
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.ico': 'image/x-icon',
        '.css': 'text/css',
        '.js': 'application/javascript'
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { "Content-Type": contentType });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }

  // ── Guest History API ─────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/guests") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getGuestHistory()));
    return;
  }

  // ── Transcription Config API ───────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/transcription-config") {
    const config = getTranscriptionConfig();
    // Don't return the full API key, just whether it exists
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      hasApiKey: !!config.apiKey,
      defaultMethod: config.defaultMethod || "local"
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/transcription-config") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { apiKey, defaultMethod } = JSON.parse(body);
        const config = getTranscriptionConfig();
        if (apiKey !== undefined) config.apiKey = apiKey || null;
        if (defaultMethod) config.defaultMethod = defaultMethod;
        saveTranscriptionConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, hasApiKey: !!config.apiKey }));
        io.emit("toast", { type: "success", message: "Transcription settings saved" });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Video Serving API ──────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/video") {
    const slug = url.searchParams.get("slug");
    const type = url.searchParams.get("type"); // 'raw' or 'subtitled'
    console.log(`[Video API] slug=${slug}, type=${type}`);
    if (!slug) { res.writeHead(400); res.end("Missing slug"); return; }
    
    const dir = path.join(EPISODES_DIR, slug);
    console.log(`[Video API] dir=${dir}, exists=${fs.existsSync(dir)}`);
    let videoPath;
    
    if (type === 'compressed') {
      // Serve the publish-compressed version
      videoPath = path.join(dir, "publish-compressed.mp4");
      console.log(`[Video API] Using publish-compressed.mp4`);
    } else if (type === 'subtitled') {
      // Look for subtitled reel file (could be reel-01-subtitled.mp4 or reel-001-subtitled.mp4)
      // OR full-subtitled.mp4 when there's no reels folder (full video case)
      const reelsDir = path.join(dir, "reels");
      console.log(`[Video API] reelsDir=${reelsDir}, exists=${fs.existsSync(reelsDir)}`);
      
      // First check for full-subtitled.mp4 (full video case, no reels)
      const fullSubtitled = path.join(dir, "full-subtitled.mp4");
      if (fs.existsSync(fullSubtitled)) {
        videoPath = fullSubtitled;
        console.log(`[Video API] Using full-subtitled.mp4`);
      } else if (fs.existsSync(reelsDir)) {
        const files = fs.readdirSync(reelsDir);
        console.log(`[Video API] files in reels:`, files);
        const subtitled = files.find(f => f.includes("subtitled") && f.endsWith(".mp4"));
        videoPath = subtitled ? path.join(reelsDir, subtitled) : path.join(reelsDir, "reel-001-subtitled.mp4");
      } else {
        videoPath = path.join(dir, "reels", "reel-001-subtitled.mp4");
      }
    } else {
      // Find raw video/audio
      const files = fs.readdirSync(dir);
      const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi|mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && !f.includes("reel") && !f.includes("final"));
      videoPath = path.join(dir, rawVideo || "raw.mp4");
    }
    
    console.log(`[Video API] videoPath=${videoPath}, exists=${fs.existsSync(videoPath)}`);
    if (!fs.existsSync(videoPath)) {
      res.writeHead(404); res.end("Video not found"); return;
    }
    
    // Stream the video
    const stat = fs.statSync(videoPath);
    const range = req.headers.range;
    
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": "video/mp4"
      });
      fs.createReadStream(videoPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": "video/mp4"
      });
      fs.createReadStream(videoPath).pipe(res);
    }
    return;
  }

  // ── Generate Topic Clip API ────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/generate-topic-clip") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { slug, topic, guest, role } = JSON.parse(body);
        if (!slug || !topic) throw new Error("slug and topic required");
        
        // Load transcript
        const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
        if (!fs.existsSync(transcriptPath)) {
          throw new Error("Transcript not found");
        }
        
        const transcript = loadJSON(transcriptPath);
        
        // Call AI to find relevant segments for the topic
        const AUTH_FILE = "/root/.openclaw/agents/main/agent/models.json";
        const AUTH_FALLBACK = "/root/.openclaw/agents/main/agent/auth.json";
        const BASE_URL = "https://api.haimaker.ai/v1";
        const MODEL = "auto";

        let apiKey;
        try {
          const m = loadJSON(AUTH_FILE);
          apiKey = m?.providers?.haimaker?.apiKey;
        } catch (_) {}
        if (!apiKey) {
          const auth = loadJSON(AUTH_FALLBACK);
          apiKey = auth?.haimaker?.key || auth?.anthropic?.key;
        }

        const prompt = `I have a podcast transcript and I want to extract a clip about: "${topic}"

Transcript:
${transcript.full_text || transcript.segments.map(s => s.text).join(' ')}

Find the most relevant continuous segment (30-90 seconds) that discusses "${topic}". 
Return ONLY a JSON object with this format:
{
  "start_time": <seconds>,
  "end_time": <seconds>,
  "hook": "<engaging one-sentence hook>",
  "caption": "<arabic caption for social media with emojis and hashtags>"
}

The hook should be attention-grabbing and the caption should be ready for Instagram/TikTok.`;

        const aiRes = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 1024,
            messages: [
              { role: "system", content: "You are a video editor for the Tajarib podcast. Extract the best clips based on topics." },
              { role: "user", content: prompt },
            ],
          }),
        });

        if (!aiRes.ok) throw new Error("AI request failed");
        const data = await aiRes.json();
        const clipData = JSON.parse(data.choices[0].message.content);
        
        // Create content.json for this topic clip
        const content = {
          guest,
          role,
          opener: clipData.hook,
          reels: [{
            id: "topic-" + Date.now(),
            hook: clipData.hook,
            caption: clipData.caption,
            start_time: clipData.start_time,
            end_time: clipData.end_time,
            duration: clipData.end_time - clipData.start_time,
            purpose: "Topic: " + topic
          }],
          createdAt: new Date().toISOString()
        };
        
        // Save as a new reel episode
        const reelSlug = slug + "-" + topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 30);
        const reelDir = path.join(EPISODES_DIR, reelSlug);
        fs.mkdirSync(reelDir, { recursive: true });
        
        // Copy video and create symlink/reference
        const meta = loadMeta(slug);
        const videoFile = meta.rawVideo || path.join(EPISODES_DIR, slug, "raw.mp4");
        
        saveMeta(reelSlug, {
          mediaType: "reel_full",
          originalFilename: meta.originalFilename,
          createdAt: new Date().toISOString(),
          rawVideo: videoFile,
          guest,
          role,
          sourceEpisode: slug,
          topic
        });
        
        // Copy transcript for reference
        fs.copyFileSync(transcriptPath, path.join(reelDir, "transcript.json"));
        
        // Save content
        saveJSON(path.join(reelDir, "content.json"), content);
        
        // Run cut for this specific segment
        io.emit("log", { slug: reelSlug, text: `\n▶ Cutting topic clip: ${topic}\n` });
        
        const cutProc = spawn(NODE_BIN, [
          "cut.js", 
          "--slug", reelSlug, 
          "--video", videoFile,
          "--start", String(clipData.start_time),
          "--end", String(clipData.end_time)
        ], { cwd: WORKSPACE_DIR });
        
        cutProc.stdout.on("data", d => io.emit("log", { slug: reelSlug, text: d.toString() }));
        cutProc.stderr.on("data", d => io.emit("log", { slug: reelSlug, text: d.toString() }));
        
        cutProc.on("close", (code) => {
          io.emit("log", { slug: reelSlug, text: `\nClip cut complete. Exit: ${code}\n` });
          io.emit("status-update", {});
        });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, slug: reelSlug }));
        
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Analyze Clips API (MP3 → Suggestions) ────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/analyze-clips") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { slug, guest, role } = JSON.parse(body);
        if (!slug) throw new Error("slug required");
        
        // Load transcript
        const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
        if (!fs.existsSync(transcriptPath)) {
          throw new Error("Transcript not found. Upload MP3 first.");
        }
        
        const transcript = loadJSON(transcriptPath);
        
        // Get API key
        const AUTH_FILE = "/root/.openclaw/agents/main/agent/models.json";
        const AUTH_FALLBACK = "/root/.openclaw/agents/main/agent/auth.json";
        const BASE_URL = "https://api.haimaker.ai/v1";
        
        let apiKey;
        try {
          const m = loadJSON(AUTH_FILE);
          apiKey = m?.providers?.haimaker?.apiKey;
        } catch (_) {}
        if (!apiKey) {
          const auth = loadJSON(AUTH_FALLBACK);
          apiKey = auth?.haimaker?.key || auth?.anthropic?.key;
        }
        
        const prompt = `You are a video editor for the Tajarib podcast. Analyze this transcript and identify the 3-5 best clips for social media reels.

Guest: ${guest || "Unknown"}
Role: ${role || "Unknown"}

Transcript segments with timestamps:
${transcript.segments.map(s => `[${formatTime(s.start)} - ${formatTime(s.end)}] ${s.text}`).slice(0, 100).join('\n')}

For each clip, provide exact timestamps and details:
1. A short, memorable hook (why this clip works)
2. Start and end timestamps (HH:MM:SS format)
3. Duration in seconds
4. A social media caption (Arabic, with emojis)
5. Whether this is a short (30-45s), medium (45-90s), or long (90-180s) clip

Return ONLY valid JSON in this exact format:
{
  "clips": [
    {
      "id": 1,
      "start": "00:02:15",
      "end": "00:02:52",
      "startSeconds": 135,
      "endSeconds": 172,
      "durationSeconds": 37,
      "type": "short",
      "hook": "One sentence explaining why this clip is attention-grabbing",
      "caption": "Arabic caption with emojis for TikTok/Instagram",
      "keyQuote": "Short quote from the clip"
    }
  ],
  "analysis": "Brief analysis of why these clips were chosen"
}

Choose clips that:
- Have strong hooks in first 3 seconds
- Stand alone without context
- Have emotional impact or valuable insights
- Have natural speech boundaries`;

        const aiRes = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: "auto",
            max_tokens: 2048,
            messages: [
              { role: "system", content: "You are an expert video editor and social media strategist for the Tajarib Arabic podcast." },
              { role: "user", content: prompt }
            ]
          })
        });
        
        if (!aiRes.ok) throw new Error("AI analysis failed");
        
        const data = await aiRes.json();
        const content = data.choices[0].message.content;
        
        // Extract JSON
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Could not parse AI response");
        
        const result = JSON.parse(jsonMatch[0]);
        
        // Save suggestions
        saveJSON(path.join(EPISODES_DIR, slug, "clip-suggestions.json"), {
          createdAt: new Date().toISOString(),
          guest,
          role,
          clips: result.clips
        });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, clips: result.clips, analysis: result.analysis }));
        
      } catch (err) {
        console.error("[Analyze Clips Error]", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Delete Video API ──────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/delete-video") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { slug, fileType } = JSON.parse(body);
        if (!slug) throw new Error("slug required");
        
        const dir = path.join(EPISODES_DIR, slug);
        if (!fs.existsSync(dir)) {
          throw new Error("Episode not found");
        }
        
        let deleted = [];
        let freedBytes = 0;
        
        if (fileType === "raw" || fileType === "all") {
          // Delete raw video/audio
          const files = fs.readdirSync(dir);
          const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi|mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && !f.includes("reel") && !f.includes("final") && !f.includes("subtitled"));
          if (rawVideo) {
            const rawPath = path.join(dir, rawVideo);
            const stats = fs.statSync(rawPath);
            fs.unlinkSync(rawPath);
            deleted.push(rawVideo);
            freedBytes += stats.size;
            
            // Update meta to remove rawVideo reference
            const meta = loadMeta(slug);
            if (meta.rawVideo) {
              delete meta.rawVideo;
              saveMeta(slug, meta);
            }
          }
        }
        
        if (fileType === "processed" || fileType === "all") {
          // Delete processed videos (reels, subtitled files)
          const reelsDir = path.join(dir, "reels");
          if (fs.existsSync(reelsDir)) {
            const reelFiles = fs.readdirSync(reelsDir).filter(f => f.endsWith(".mp4"));
            for (const f of reelFiles) {
              const fpath = path.join(reelsDir, f);
              const stats = fs.statSync(fpath);
              fs.unlinkSync(fpath);
              deleted.push(`reels/${f}`);
              freedBytes += stats.size;
            }
          }
          
          // Delete full-subtitled.mp4
          const fullSubtitled = path.join(dir, "full-subtitled.mp4");
          if (fs.existsSync(fullSubtitled)) {
            const stats = fs.statSync(fullSubtitled);
            fs.unlinkSync(fullSubtitled);
            deleted.push("full-subtitled.mp4");
            freedBytes += stats.size;
          }
        }
        
        if (fileType === "transcript" || fileType === "all") {
          // Delete transcript
          const transcriptPath = path.join(dir, "transcript.json");
          if (fs.existsSync(transcriptPath)) {
            const stats = fs.statSync(transcriptPath);
            fs.unlinkSync(transcriptPath);
            deleted.push("transcript.json");
            freedBytes += stats.size;
          }
        }
        
        const freedMb = (freedBytes / 1024 / 1024).toFixed(1);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          success: true, 
          deleted, 
          freedBytes, 
          freedMb: parseFloat(freedMb)
        }));
        io.emit("toast", { type: "success", message: `Deleted ${deleted.length} files, freed ${freedMb} MB` });
        io.emit("status-update", {});
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Simple Upload API (for direct file uploads) ────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/upload") {
    const form = formidable({
      uploadDir: UPLOADS_DIR,
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB max
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
        return;
      }

      try {
        const rawSlug = (fields.slug?.[0] || fields.slug || "").trim();
        const pendingAiTitle = !rawSlug; // empty slug = AI will generate title after transcription
        const slug = pendingAiTitle
          ? `temp-${Date.now()}-${Math.random().toString(36).substr(2,6)}`
          : rawSlug.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
        const guest = fields.guest?.[0] || fields.guest || "";
        const role = fields.role?.[0] || fields.role || "";
        const mediaType = fields.mediaType?.[0] || fields.mediaType || "episode";
        const transcribeMethod = fields.transcribeMethod?.[0] || fields.transcribeMethod || "local";
        const videoFile = files.video?.[0] || files.video;

        if (!videoFile) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "No video file provided" }));
          return;
        }

        const epDir = path.join(EPISODES_DIR, slug);
        fs.mkdirSync(epDir, { recursive: true });

        // Determine file extension
        const ext = path.extname(videoFile.originalFilename || videoFile.newFilename || "").toLowerCase() || ".mp4";
        const finalPath = path.join(epDir, `raw${ext}`);

        // Move uploaded file to episode directory
        fs.renameSync(videoFile.filepath, finalPath);

        // Save metadata
        saveMeta(slug, {
          mediaType,
          originalFilename: videoFile.originalFilename || videoFile.newFilename,
          createdAt: new Date().toISOString(),
          rawVideo: finalPath,
          guest,
          role,
          transcribeMethod,
          ...(pendingAiTitle && { pendingAiTitle: true })
        });

        // Add guest to history
        if (guest) addGuestToHistory(guest, role);

        // Start transcription automatically
        io.emit("log", { slug, text: `\n📁 Uploaded: ${videoFile.originalFilename || videoFile.newFilename}\n` });
        io.emit("log", { slug, text: `▶ Starting transcription (${transcribeMethod})...\n` });

        const args = ["transcribe.py", "--input", finalPath, "--output", path.join(epDir, "transcript.json")];
        if (transcribeMethod === "api") args.push("--api");

        const proc = spawn(PYTHON_BIN, args, { cwd: WORKSPACE_DIR });
        activeProcesses[slug] = proc;

        proc.stdout.on("data", d => io.emit("log", { slug, text: d.toString() }));
        proc.stderr.on("data", d => io.emit("log", { slug, text: d.toString() }));

        proc.on("close", async (code) => {
          delete activeProcesses[slug];
          io.emit("log", { slug, text: `\nTranscription complete. Exit: ${code}\n` });
          io.emit("status-update", {});
          // Post-transcription: AI title generation if pending
          if (code === 0) {
            await handlePostTranscription(slug);
          }
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, slug }));

      } catch (err) {
        console.error("[Upload Error]", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Chunked Upload Init ────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/upload-init") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { filename, fileSize, slug, guest, role, mediaType, transcribeMethod } = JSON.parse(body);
        const uploadId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const rawSlug = (slug || "").trim();
        const pendingAiTitle = !rawSlug;
        const safeSlug = pendingAiTitle
          ? `temp-${Date.now()}-${Math.random().toString(36).substr(2,6)}`
          : rawSlug.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
        
        const state = loadUploadsState();
        state[uploadId] = {
          filename,
          fileSize,
          slug: safeSlug,
          guest,
          role,
          mediaType: mediaType || "episode",
          transcribeMethod: transcribeMethod || "local",
          pendingAiTitle,
          chunksReceived: [],
          totalChunks: Math.ceil(fileSize / CHUNK_SIZE),
          createdAt: new Date().toISOString(),
          status: "pending"
        };
        saveUploadsState(state);
        
        // Create chunk directory
        const chunkDir = path.join(UPLOADS_DIR, `.chunks-${uploadId}`);
        fs.mkdirSync(chunkDir, { recursive: true });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          success: true, 
          uploadId, 
          chunkSize: CHUNK_SIZE,
          totalChunks: state[uploadId].totalChunks 
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Chunked Upload Chunk ───────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/upload-chunk") {
    const uploadId = url.searchParams.get("uploadId");
    const chunkIndex = parseInt(url.searchParams.get("chunkIndex"));
    
    if (!uploadId || isNaN(chunkIndex)) {
      res.writeHead(400); res.end("Missing uploadId or chunkIndex"); return;
    }
    
    const state = loadUploadsState();
    if (!state[uploadId]) {
      res.writeHead(404); res.end("Upload not found"); return;
    }
    
    // Stream the chunk to disk
    const chunkDir = path.join(UPLOADS_DIR, `.chunks-${uploadId}`);
    const chunkPath = path.join(chunkDir, `chunk-${chunkIndex}`);
    
    const writeStream = fs.createWriteStream(chunkPath);
    req.pipe(writeStream);
    
    writeStream.on("finish", () => {
      // Mark chunk as received
      state[uploadId].chunksReceived.push(chunkIndex);
      state[uploadId].chunksReceived = [...new Set(state[uploadId].chunksReceived)]; // dedupe
      saveUploadsState(state);
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        success: true, 
        chunkIndex,
        received: state[uploadId].chunksReceived.length,
        total: state[uploadId].totalChunks
      }));
    });
    
    writeStream.on("error", (err) => {
      res.writeHead(500); 
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── Chunked Upload Complete ────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/upload-complete") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { uploadId } = JSON.parse(body);
        const state = loadUploadsState();
        
        if (!state[uploadId]) throw new Error("Upload not found");
        
        const upload = state[uploadId];
        const chunkDir = path.join(UPLOADS_DIR, `.chunks-${uploadId}`);
        
        // Verify all chunks received
        const expectedChunks = Array.from({length: upload.totalChunks}, (_, i) => i);
        const missing = expectedChunks.filter(i => !upload.chunksReceived.includes(i));
        if (missing.length > 0) {
          throw new Error(`Missing chunks: ${missing.join(", ")}`);
        }
        
        // Assemble file
        const safeSlug = upload.slug;
        const epDir = path.join(EPISODES_DIR, safeSlug);
        fs.mkdirSync(epDir, { recursive: true });
        
        const ext = path.extname(upload.filename) || ".mp4";
        const dest = path.join(epDir, `raw${ext}`);
        
        // Write chunks in order
        const writeStream = fs.createWriteStream(dest);
        for (let i = 0; i < upload.totalChunks; i++) {
          const chunkPath = path.join(chunkDir, `chunk-${i}`);
          const chunkData = fs.readFileSync(chunkPath);
          writeStream.write(chunkData);
        }
        writeStream.end();
        
        await new Promise((resolve, reject) => {
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });
        
        // Add to guest history
        if (upload.guest) {
          addGuestToHistory(upload.guest, upload.role || "");
        }
        
        // Save meta
        saveMeta(safeSlug, {
          mediaType: upload.mediaType,
          originalFilename: upload.filename,
          createdAt: new Date().toISOString(),
          rawVideo: dest,
          transcribeMethod: upload.transcribeMethod,
          ...(upload.guest && { guest: upload.guest }),
          ...(upload.role && { role: upload.role }),
          ...(upload.pendingAiTitle && { pendingAiTitle: true })
        });
        
        // Cleanup
        cleanupUploadState(uploadId);
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, slug: safeSlug }));
        io.emit("toast", { type: "success", message: `Upload complete → ${safeSlug}` });
        io.emit("status-update", {});
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Server Storage Status ─────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/server-status") {
    try {
      const { execSync } = require("child_process");
      // Get disk usage for the workspace filesystem
      const dfOutput = execSync(`df -B1 "${WORKSPACE_DIR}" | tail -1`, { encoding: "utf8" }).trim();
      const parts = dfOutput.split(/\s+/);
      const total = parseInt(parts[1]);
      const used = parseInt(parts[2]);
      const available = parseInt(parts[3]);
      const percentUsed = Math.round((used / total) * 100);
      
      // Calculate episodes storage
      let episodesSize = 0;
      if (fs.existsSync(EPISODES_DIR)) {
        const calcSize = (dir) => {
          let size = 0;
          try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
              const itemPath = path.join(dir, item);
              const stats = fs.statSync(itemPath);
              if (stats.isDirectory()) {
                size += calcSize(itemPath);
              } else {
                size += stats.size;
              }
            }
          } catch (e) {}
          return size;
        };
        episodesSize = calcSize(EPISODES_DIR);
      }
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        disk: {
          total,
          used,
          available,
          percentUsed,
          totalGb: (total / 1024 / 1024 / 1024).toFixed(1),
          usedGb: (used / 1024 / 1024 / 1024).toFixed(1),
          availableGb: (available / 1024 / 1024 / 1024).toFixed(1)
        },
        episodesSize,
        episodesSizeGb: (episodesSize / 1024 / 1024 / 1024).toFixed(1)
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ── Upload Status Check ────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/upload-status") {
    const uploadId = url.searchParams.get("uploadId");
    if (!uploadId) { res.writeHead(400); res.end("Missing uploadId"); return; }
    
    const state = loadUploadsState();
    const upload = state[uploadId];
    
    if (!upload) { res.writeHead(404); res.end("Upload not found"); return; }
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      uploadId,
      filename: upload.filename,
      fileSize: upload.fileSize,
      totalChunks: upload.totalChunks,
      receivedChunks: upload.chunksReceived.length,
      receivedIndexes: upload.chunksReceived,
      status: upload.status
    }));
    return;
  }

  // ── Publish via Zapier Webhook ────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/publish") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { slug } = JSON.parse(body);
        const meta = loadMeta(slug);
        const content = loadJSON(path.join(EPISODES_DIR, slug, "content.json"));
        
        // Get caption from content.json if available, otherwise use a default
        let caption;
        if (content && content.reels && content.reels.length > 0) {
          caption = content.reels[0].caption;
        } else {
          // Generate a basic caption from metadata
          const guest = meta.guest || "ضيف تاجرب";
          const role = meta.role || "";
          caption = `🎙️ ${guest}${role ? " - " + role : ""}\n\n#تجارب #بودكاست #ريادة_الأعمال`;
        }
        
        // For reel_full, use the raw video (already subtitled)
        // For reel_cut, use the subtitled reel from reels folder
        // For full video (no reels), use full-subtitled.mp4
        let videoPath;
        const dir = path.join(EPISODES_DIR, slug);
        
        // First check for full-subtitled.mp4 (handles both reel_cut with no reels and reel_full)
        const fullSubtitled = path.join(dir, "full-subtitled.mp4");
        if (fs.existsSync(fullSubtitled)) {
          videoPath = fullSubtitled;
        } else if (meta.mediaType === "reel_full") {
          const files = fs.readdirSync(dir);
          const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi)$/i.test(f) && !f.includes("reel") && !f.includes("final"));
          videoPath = path.join(dir, rawVideo || "raw.mp4");
        } else {
          const reelsDir = path.join(dir, "reels");
          if (fs.existsSync(reelsDir)) {
            const files = fs.readdirSync(reelsDir);
            const subtitled = files.find(f => f.includes("subtitled") && f.endsWith(".mp4"));
            videoPath = subtitled ? path.join(reelsDir, subtitled) : path.join(reelsDir, "reel-001-subtitled.mp4");
          } else {
            videoPath = path.join(dir, "reels", "reel-001-subtitled.mp4");
          }
        }
        
        // Compress if needed (Buffer/Instagram limit ~100MB)
        io.emit("toast", { type: "success", message: "Preparing video for publish..." });
        const publishVideoPath = await compressForPublish(videoPath, slug);
        
        const result = await publishViaZapier(slug, caption, publishVideoPath);
        
        // Mark as published
        saveMeta(slug, { published: true, publishedAt: new Date().toISOString() });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, result }));
        io.emit("status-update", {});
        io.emit("toast", { type: "success", message: "Sent to Zapier!" });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Episodes API ──────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/episodes") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getEpisodes()));
    return;
  }

  // ── File read API ─────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/file") {
    const slug = url.searchParams.get("slug");
    const file = url.searchParams.get("file");
    if (!slug || !file) { res.writeHead(400); res.end("Missing params"); return; }
    const filePath = path.join(EPISODES_DIR, slug, file);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(fs.readFileSync(filePath, "utf8"));
    } else {
      res.writeHead(404); res.end("");
    }
    return;
  }

  // ── File write API ────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/file") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { slug, file, content } = JSON.parse(body);
        const filePath = path.join(EPISODES_DIR, slug, file);
        if (!fs.existsSync(path.dirname(filePath))) throw new Error("Directory missing");
        fs.writeFileSync(filePath, content, "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        io.emit("toast", { type: "success", message: `Saved ${file}` });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Save content API ──────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/save-content") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { slug, field, value } = JSON.parse(body);
        const contentPath = path.join(EPISODES_DIR, slug, "content.json");
        const content = loadJSON(contentPath);
        if (!content) throw new Error("No content.json found");

        const parts = field.split(".");
        let ref = content;
        for (let i = 0; i < parts.length - 1; i++) {
          ref = ref[parts[i]];
          if (ref === undefined) throw new Error(`Field path not found: ${field}`);
        }
        ref[parts[parts.length - 1]] = value;

        saveJSON(contentPath, content);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        io.emit("toast", { type: "success", message: "Content saved" });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Manual Caption API (skip generate, write content.json directly) ────────
  if (req.method === "POST" && url.pathname === "/api/manual-caption") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { slug, caption } = JSON.parse(body);
        if (!slug || !caption) throw new Error("slug and caption required");

        const meta = loadMeta(slug);
        const contentPath = path.join(EPISODES_DIR, slug, "content.json");
        const existing = loadJSON(contentPath);

        if (existing) {
          // Update first reel caption or add one
          if (existing.reels && existing.reels.length > 0) {
            existing.reels[0].caption = caption;
          } else {
            existing.reels = [{ id: "reel-01", caption }];
          }
          existing.manual = true;
          existing.updated_at = new Date().toISOString();
          saveJSON(contentPath, existing);
        } else {
          // Create fresh content.json
          saveJSON(contentPath, {
            slug,
            generated_at: new Date().toISOString(),
            guest: meta.guest || "",
            role: meta.role || "",
            manual: true,
            reel_only: true,
            reels: [{ id: "reel-01", caption }],
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        io.emit("toast", { type: "success", message: "Caption saved" });
        io.emit("status-update", {});
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Feedback/revision API ─────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/feedback") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { slug, field, currentContent, feedback } = JSON.parse(body);
        if (!slug || !field || !currentContent || !feedback) {
          throw new Error("slug, field, currentContent, feedback all required");
        }

        // Load transcript for context if available
        let transcriptText = null;
        const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
        if (fs.existsSync(transcriptPath)) {
          try {
            const transcript = loadJSON(transcriptPath);
            transcriptText = transcript.full_text || transcript.segments?.map(s => s.text).join(' ') || null;
          } catch (_) {}
        }

        const revised = await callModelForRevision(currentContent, feedback, transcriptText);

        const contentPath = path.join(EPISODES_DIR, slug, "content.json");
        const content = loadJSON(contentPath);
        if (content) {
          const parts = field.split(".");
          let ref = content;
          for (let i = 0; i < parts.length - 1; i++) ref = ref[parts[i]];
          ref[parts[parts.length - 1]] = revised;
          saveJSON(contentPath, content);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, revised }));
        io.emit("toast", { type: "success", message: "Content revised by AI" });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Set meta API ──────────────────────────────────────────────────────────
  // ── AI Title Generation API ──────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/generate-title") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { slug } = JSON.parse(body);
        if (!slug) throw new Error("slug required");
        
        const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
        if (!fs.existsSync(transcriptPath)) {
          throw new Error("No transcript found — transcribe first");
        }
        
        const transcript = loadJSON(transcriptPath);
        const fullText = transcript.full_text || transcript.segments?.map(s => s.text).join(' ') || '';
        if (!fullText) throw new Error("Transcript is empty");
        
        const meta = loadMeta(slug);
        
        io.emit("log", { slug, text: "\n🤖 Generating AI title from transcript...\n" });
        
        const aiSlug = await generateTitleFromTranscript(fullText, meta.guest, meta.role);
        const finalSlug = deduplicateSlug(aiSlug);
        
        io.emit("log", { slug, text: `📝 AI suggested: ${aiSlug}${finalSlug !== aiSlug ? ` → ${finalSlug} (deduplicated)` : ''}\n` });
        
        // Rename the episode
        const newSlug = renameEpisode(slug, finalSlug);
        
        // Clear any pending flag
        const newMeta = loadMeta(newSlug);
        delete newMeta.pendingAiTitle;
        saveMeta(newSlug, newMeta);
        
        io.emit("log", { slug: newSlug, text: `✅ Episode renamed: ${slug} → ${newSlug}\n` });
        io.emit("episode-renamed", { oldSlug: slug, newSlug });
        io.emit("status-update", {});
        io.emit("toast", { type: "success", message: `AI titled: ${newSlug}` });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, oldSlug: slug, newSlug }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Validate Model API (for generate step) ───────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/validate-model") {
    const model = url.searchParams.get("model");
    if (!model) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: false, error: "No model specified" }));
      return;
    }

    // Known valid aliases (same as frontend)
    const knownAliases = {
      'auto': 'Auto (HAI Maker picks best)',
      'claude': 'Claude (Anthropic)',
      'claude-sonnet': 'Claude 3.5 Sonnet',
      'claude-opus': 'Claude 3 Opus',
      'claude-haiku': 'Claude 3 Haiku',
      'openai': 'OpenAI',
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o Mini',
      'gpt-4': 'GPT-4',
      'gpt-4-turbo': 'GPT-4 Turbo',
      'gemini': 'Gemini (Google)',
      'gemini-1.5-pro': 'Gemini 1.5 Pro',
      'gemini-1.5-flash': 'Gemini 1.5 Flash',
      'haimaker/auto': 'HAI Maker Auto',
      'haimaker/claude-sonnet': 'HAI Maker Claude Sonnet',
      'haimaker/gpt-4o': 'HAI Maker GPT-4o',
      'openrouter/auto': 'OpenRouter Auto',
      'openrouter/anthropic/claude-3.5-sonnet': 'OpenRouter Claude 3.5 Sonnet',
      'openrouter/openai/gpt-4o': 'OpenRouter GPT-4o'
    };

    const normalized = model.toLowerCase().trim();
    if (knownAliases[normalized]) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: true, displayName: knownAliases[normalized] }));
      return;
    }

    // Try to validate against Haimaker API by checking models endpoint
    try {
      const AUTH_FILE = "/root/.openclaw/agents/main/agent/models.json";
      const AUTH_FALLBACK = "/root/.openclaw/agents/main/agent/auth.json";
      let apiKey;
      try {
        const m = loadJSON(AUTH_FILE);
        apiKey = m?.providers?.haimaker?.apiKey;
      } catch (_) {}
      if (!apiKey) {
        const auth = loadJSON(AUTH_FALLBACK);
        apiKey = auth?.haimaker?.key;
      }

      if (apiKey) {
        const apiRes = await fetch("https://api.haimaker.ai/v1/models", {
          headers: { "Authorization": `Bearer ${apiKey}` }
        });
        if (apiRes.ok) {
          const data = await apiRes.json();
          const models = data.data || [];
          const match = models.find(m => m.id === model || m.id === normalized);
          if (match) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ valid: true, displayName: match.id }));
            return;
          }
        }
      }
    } catch (e) {
      // Fall through to pattern validation
    }

    // Pattern-based validation for anything that looks like a valid model ID
    const validPattern = /^[a-z0-9]+([\/:._-][a-z0-9-]+)*$/i;
    if (validPattern.test(model)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: true, displayName: model, note: "Custom model" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ valid: false, error: "Invalid model format" }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/set-meta") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { slug, guest, role, mediaType } = JSON.parse(body);
        if (!slug) throw new Error("slug required");
        
        // Add to guest history if guest provided
        if (guest) {
          addGuestToHistory(guest, role || "");
        }
        
        saveMeta(slug, { ...(guest && { guest }), ...(role && { role }), ...(mediaType && { mediaType }) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        io.emit("status-update", {});
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Upload API ────────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/upload") {
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024 * 1024,
      uploadDir: UPLOADS_DIR,
      keepExtensions: true,
      multiples: false,
    });

    form.parse(req, (err, fields, files) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const rawSlug = (Array.isArray(fields.slug) ? fields.slug[0] : fields.slug) || "";
      const guest = Array.isArray(fields.guest) ? fields.guest[0] : fields.guest;
      const role = Array.isArray(fields.role) ? fields.role[0] : fields.role;
      const mediaType = (Array.isArray(fields.mediaType) ? fields.mediaType[0] : fields.mediaType) || "episode";
      const transcribeMethod = (Array.isArray(fields.transcribeMethod) ? fields.transcribeMethod[0] : fields.transcribeMethod) || "local";
      const file = Array.isArray(files.video) ? files.video[0] : files.video;

      if (!file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "video file required" }));
        return;
      }

      const pendingAiTitle = !rawSlug.trim();
      const safeSlug = pendingAiTitle
        ? `temp-${Date.now()}-${Math.random().toString(36).substr(2,6)}`
        : rawSlug.trim().replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
      const epDir = path.join(EPISODES_DIR, safeSlug);
      fs.mkdirSync(epDir, { recursive: true });

      const ext = path.extname(file.originalFilename || file.newFilename || ".mp4");
      const dest = path.join(epDir, `raw${ext}`);
      fs.renameSync(file.filepath, dest);

      // Add to guest history
      if (guest) {
        addGuestToHistory(guest, role || "");
      }

      saveMeta(safeSlug, {
        mediaType,
        originalFilename: file.originalFilename || file.newFilename,
        createdAt: new Date().toISOString(),
        rawVideo: dest,
        transcribeMethod,
        ...(guest && { guest }),
        ...(role && { role }),
        ...(pendingAiTitle && { pendingAiTitle: true })
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, slug: safeSlug, mediaType }));
      io.emit("toast", { type: "success", message: `Uploaded → ${safeSlug} (${mediaType})` });
      io.emit("status-update", {});
    });
    return;
  }

  // ── Run step API ──────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/run-step") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { slug, step, force, model } = JSON.parse(body);
        if (!slug || !step) throw new Error("slug + step required");

        const meta = loadMeta(slug);
        const mediaType = meta.mediaType || "episode";

        if (mediaType === "reel_full" && !['generate', 'transcribe'].includes(step)) {
          throw new Error(`Step '${step}' not applicable for fully-produced reel. Only transcribe and generate are available.`);
        }
        if (mediaType === "reel_cut" && step === "cut") {
          throw new Error("Cut step not applicable — reel is already cut");
        }
        if (mediaType === "reel_cut" && step === "analyze") {
          throw new Error("Analyze step not applicable for pre-cut reels");
        }
        if (step === "generate" && (!meta.guest || !meta.role)) {
          throw new Error("Guest name and role required for generation");
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));

        runStep({ slug, step, force, mediaType, guest: meta.guest, role: meta.role, model });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); 
  res.end("Not Found");
}

// ─── Run Pipeline Step ───────────────────────────────────────────────────────

function runStep({ slug, step, force, mediaType, guest, role, model }) {
  if (activeProcesses[slug]) {
    io.emit("toast", { type: "error", message: `${slug} is already running` });
    return;
  }

  const dir = path.join(EPISODES_DIR, slug);
  let cmd, args;

  let videoFile = "raw.mp4";
  const found = fs.readdirSync(dir).find(f => /\.(mp4|mkv|mov|avi|mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && !f.includes("reel") && !f.includes("final"));
  if (found) videoFile = found;

  switch (step) {
    case "transcribe":
      if (!found) { io.emit("toast", { type: "error", message: `No video/audio in ${slug}/` }); return; }
      cmd = PYTHON_BIN;
      args = ["-u", "transcribe.py", path.join("episodes", slug, videoFile), "--slug", slug];
      if (force) args.push("--force");
      // Use API if configured in meta or if no meta, check default config
      const epMeta = loadMeta(slug);
      if (epMeta.transcribeMethod === "api") {
        args.push("--api");
        io.emit("log", { slug, text: "Using Haimaker API for transcription...\n" });
      }
      break;
    case "analyze":
      cmd = NODE_BIN; 
      args = ["analyze.js", "--slug", slug];
      if (force) args.push("--force");
      break;
    case "generate":
      cmd = NODE_BIN;
      const extraArgs = (mediaType !== "episode") ? ["--reel-only"] : [];
      const modelArgs = model ? ["--model", model] : [];
      args = ["generate.js", "--slug", slug, "--guest", guest, "--role", role, ...extraArgs, ...modelArgs];
      if (force) args.push("--force");
      break;
    case "cut":
      if (!found) { io.emit("toast", { type: "error", message: `No video in ${slug}/` }); return; }
      cmd = NODE_BIN; 
      args = ["cut.js", "--slug", slug, "--video", path.join(dir, videoFile)];
      if (force) args.push("--force");
      break;
    case "subtitle":
      cmd = NODE_BIN; 
      args = ["subtitle.js", "--slug", slug];
      if (force) args.push("--force");
      break;
    default:
      io.emit("toast", { type: "error", message: `Unknown step: ${step}` });
      return;
  }

  io.emit("log", { slug, text: `\n▶ Running: ${step}\n` });
  io.emit("log", { slug, text: `   Command: ${cmd} ${args.join(" ")}\n` });
  io.emit("log", { slug, text: `   Working dir: ${WORKSPACE_DIR}\n` });
  io.emit("log", { slug, text: `   Starting process...\n\n` });
  io.emit("process-start", { slug, step });

  console.log(`[Spawning] ${cmd} ${args.join(" ")} in ${WORKSPACE_DIR}`);
  console.log(`[DEBUG] slug=${slug}, step=${step}, io.connected sockets=${io.engine?.clientsCount || 'unknown'}`);
  
  const proc = spawn(cmd, args, { 
    cwd: WORKSPACE_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  activeProcesses[slug] = proc;
  
  // Buffer for output in case process exits quickly
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let outputSent = false;
  
  proc.on("error", (err) => {
    console.error(`[Spawn Error] ${err.message}`);
    io.emit("log", { slug, text: `\n❌ Failed to start process: ${err.message}\n` });
    io.emit("log", { slug, text: `   Command attempted: ${cmd} ${args.join(" ")}\n` });
    io.emit("log", { slug, text: `   Working directory: ${WORKSPACE_DIR}\n` });
    io.emit("log", { slug, text: `   Check that the script exists and is executable.\n\n` });
    io.emit("process-end", { slug, step, code: -1 });
    delete activeProcesses[slug];
  });

  let heartbeatTimer = null;
  let gotFirstOutput = false;
  if (step === "transcribe") {
    heartbeatTimer = setInterval(() => {
      if (!gotFirstOutput) {
        io.emit("log", { slug, text: `⏳ Loading Whisper model... (this can take up to a minute)\n` });
      }
    }, 10000);
  }

  proc.stdout.on("data", d => {
    gotFirstOutput = true;
    outputSent = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    const text = d.toString();
    stdoutBuffer += text;
    console.log(`[DEBUG stdout ${slug}] ${text.substring(0, 100)}...`);
    io.emit("log", { slug, text });
  });
  proc.stderr.on("data", d => {
    gotFirstOutput = true;
    outputSent = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    const text = d.toString();
    stderrBuffer += text;
    io.emit("log", { slug, text });
  });
  
  // Also listen for stdout/stderr end to capture any remaining data
  proc.stdout.on("end", () => {
    if (stdoutBuffer && !outputSent) {
      io.emit("log", { slug, text: stdoutBuffer });
    }
  });
  proc.stderr.on("end", () => {
    if (stderrBuffer && !outputSent) {
      io.emit("log", { slug, text: stderrBuffer });
    }
  });

  proc.on("close", async (code) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    delete activeProcesses[slug];
    io.emit("log", { slug, text: `\nExit code: ${code}\n${"─".repeat(40)}\n` });
    io.emit("process-end", { slug, step, code });
    io.emit("status-update", {});
    // Post-transcription: AI title generation if pending
    if (step === "transcribe" && code === 0) {
      await handlePostTranscription(slug);
    }
  });
}

// ─── Socket Handler ──────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  socket.on("stop-step", ({ slug }) => {
    if (activeProcesses[slug]) {
      activeProcesses[slug].kill();
      delete activeProcesses[slug];
      io.emit("log", { slug, text: "\n🛑 Process stopped manually.\n" });
      io.emit("status-update", {});
    }
  });

  socket.on("update-meta", ({ slug, guest, role }) => {
    if (guest) addGuestToHistory(guest, role || "");
    saveMeta(slug, { guest, role });
    io.emit("status-update", {});
  });
});

// Cleanup orphaned uploads older than 24 hours
function cleanupOrphanedUploads() {
  const state = loadUploadsState();
  const now = new Date();
  let cleaned = 0;
  for (const [uploadId, upload] of Object.entries(state)) {
    const created = new Date(upload.createdAt);
    const hoursOld = (now - created) / (1000 * 60 * 60);
    if (hoursOld > 24) {
      cleanupUploadState(uploadId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Cleanup] Removed ${cleaned} orphaned uploads`);
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("🎙️  Tajarib Dashboard DEV → http://76.13.145.146:" + PORT);
  cleanupOrphanedUploads();
  // Run cleanup every hour
  setInterval(cleanupOrphanedUploads, 60 * 60 * 1000);
});
