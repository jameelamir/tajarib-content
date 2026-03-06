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
// Anthropic SDK now loaded via llm.js only when needed
const buffer = require("./buffer");

const PORT = process.env.PORT || 7430;
const WORKSPACE_DIR = __dirname;
const EPISODES_DIR = path.join(WORKSPACE_DIR, "episodes");
const UPLOADS_DIR = path.join(WORKSPACE_DIR, "uploads");
const GUESTS_FILE = path.join(WORKSPACE_DIR, "guests.json");
const BUFFER_CONFIG_FILE = path.join(WORKSPACE_DIR, "buffer-config.json");

// Ensure dirs exist
[EPISODES_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// Prevent server crashes from uncaught errors
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT]", err.message, err.stack?.split("\n")[1]);
});
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err?.message || err);
});

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

function parseSrt(srtContent) {
  const blocks = srtContent.trim().split(/\n\n+/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 2) continue;
    // Find the timestamp line (could be line 0 or 1 depending on whether cue number is present)
    let timeLine = -1;
    for (let i = 0; i < Math.min(lines.length, 2); i++) {
      if (lines[i].includes('-->')) { timeLine = i; break; }
    }
    if (timeLine < 0) continue;
    const timeMatch = lines[timeLine].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!timeMatch) continue;
    const start = +timeMatch[1]*3600 + +timeMatch[2]*60 + +timeMatch[3] + +timeMatch[4]/1000;
    const end = +timeMatch[5]*3600 + +timeMatch[6]*60 + +timeMatch[7] + +timeMatch[8]/1000;
    const text = lines.slice(timeLine + 1).join(' ').replace(/<[^>]*>/g, '').trim();
    if (text) segments.push({ id: segments.length, start, end, text });
  }
  const full_text = segments.map(s => s.text).join(' ');
  return {
    model: 'uploaded-srt',
    full_text,
    segments,
    segment_count: segments.length,
    word_count: full_text.split(/\s+/).filter(Boolean).length,
    duration_seconds: segments.length ? segments[segments.length - 1].end : 0,
  };
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

// ─── LLM Helper (supports Haimaker / OpenAI-compatible + direct Anthropic) ──

const llm = require("./llm");

async function callClaude(systemPrompt, userMessage, maxTokens = 4096) {
  const result = await llm.chat({ system: systemPrompt, user: userMessage, maxTokens });
  if (!result) throw new Error("No API key configured. Set up your LLM provider in the Generation settings.");

  // Reasoning models (e.g. DeepSeek R1 via haimaker/auto) may exhaust tokens on
  // internal thinking and return empty content. Detect and report this clearly.
  if (!result.text && result.reasoning) {
    console.error(`[callClaude] Reasoning model returned empty content (used ${result.usage?.output || '?'} output tokens on reasoning).`);
    throw new Error("The AI model spent all its capacity on internal reasoning and produced no output. Try again — this is intermittent with reasoning models.");
  }
  if (!result.text) {
    console.error(`[callClaude] LLM returned empty text. Usage: ${JSON.stringify(result.usage)}`);
    throw new Error("The AI returned an empty response. Please try again.");
  }

  return result.text;
}

function hasApiKey() {
  return llm.hasKey();
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
      const selectedReels = loadJSON(path.join(dir, "selected-reels.json"));

      const reelsDir = path.join(dir, "reels");
      const reelFiles = fs.existsSync(reelsDir) ? fs.readdirSync(reelsDir) : [];
      const reelCount = reelFiles.filter(f => /^reel-\d+\.mp4$/.test(f)).length;
      
      // Count final videos: subtitled reels in reels/ OR full-subtitled.mp4 in main dir
      let finalCount = reelFiles.filter(f => f.endsWith("-subtitled.mp4")).length;
      // Also check for full-subtitled.mp4 (when no reels, just full video)
      if (fs.existsSync(path.join(dir, "full-subtitled.mp4"))) {
        finalCount += 1;
      }

      const mediaType = meta.mediaType || "episode";
      const guest = meta.guest || "";
      const role = meta.role || "";
      const multiTrack = meta.multiTrack || false;

      let videoSize = null;
      if (rawVideo) {
        try { videoSize = fs.statSync(path.join(dir, rawVideo)).size; } catch (e) {}
      }

      // Check for overlay/final videos
      const hasOverlay = fs.existsSync(path.join(dir, "full-final.mp4")) ||
        reelFiles.some(f => f.endsWith("-final.mp4"));

      // Check for composed video (multi-track)
      const hasComposed = fs.existsSync(path.join(dir, "composed.mp4"));

      // Check for cropped reels (per-reel crop)
      const hasCropped = reelFiles.some(f => f.includes("-cropped") && f.endsWith(".mp4"));

      // Per-reel status data
      const reelStatuses = [];
      const reelIds = reelFiles.filter(f => /^reel-\d+\.mp4$/.test(f)).sort().map(f => f.match(/reel-(\d+)\.mp4/)[1]);
      const analysisData = loadJSON(path.join(dir, "analysis.json"));
      const contentData = loadJSON(path.join(dir, "content.json"));
      const generatedReelIds = new Set((contentData?.reels || []).map(r => String(r.id).padStart(2, "0")));
      for (const id of reelIds) {
        const reelInfo = analysisData?.reels?.find(r => String(r.id).padStart(2, "0") === id) || {};
        reelStatuses.push({
          id,
          cut: true,
          generated: generatedReelIds.has(id),
          cropped: reelFiles.includes(`reel-${id}-cropped.mp4`),
          subtitled: reelFiles.includes(`reel-${id}-subtitled.mp4`),
          final: reelFiles.includes(`reel-${id}-final.mp4`),
          hook: reelInfo.hook || reelInfo.title || "",
          duration: reelInfo.duration || null
        });
      }

      return {
        slug,
        mediaType,
        rawVideo,
        videoSize,
        guest,
        role,
        multiTrack,
        steps: {
          transcribed: transcript,
          analyzed: analysis,
          reelsSelected: !!selectedReels,
          generated: !!content,
          cut: reelCount > 0,
          subtitled: finalCount > 0,
          overlaid: hasOverlay,
          composed: hasComposed,
          cropped: hasCropped,
          published: meta.published || false
        },
        selectedReels: selectedReels ? selectedReels.reels : null,
        reelStatuses,
        content,
        counts: { reels: reelCount, final: finalCount },
        cropRatio: meta.cropRatio || null
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
  let transcriptSection = '';
  if (transcriptText) {
    transcriptSection = `\n\n---FULL TRANSCRIPT (for context on what was actually said)---\n${transcriptText.substring(0, 8000)}${transcriptText.length > 8000 ? '...' : ''}\n---END TRANSCRIPT---`;
  }

  const prompt = `You generated the following Arabic content for the Tajarib podcast:

---BEGIN CONTENT---
${originalContent}
---END CONTENT---${transcriptSection}

The user has provided this feedback:
"${feedback}"

Please return a revised version that incorporates the feedback exactly, keeping the same format and language style (Iraqi white Arabic). Use the transcript as reference for what was actually said in the audio. Output only the revised content — no explanations, no extra text.`;

  // Use 4096 max_tokens — reasoning models (DeepSeek R1 via haimaker/auto) need
  // extra budget for internal thinking before producing the actual revised content.
  return callClaude("أنت كاتب محتوى لبودكاست تجارب. راجع المحتوى بناءً على ملاحظات المستخدم.", prompt, 4096);
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

  const result = await callClaude("You generate short URL-safe slugs for podcast episodes. Output only the slug.", prompt, 100);
  const rawSlug = result.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
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

async function publishViaBuffer(slug, caption, videoPath) {
  // Upload video to temp public host so Buffer can access it
  io.emit("log", { slug, text: `\n📤 Uploading video for Buffer...\n` });
  io.emit("toast", { type: "success", message: "Uploading video to public host..." });

  const publicVideoUrl = await buffer.uploadToTempHost(videoPath);
  console.log(`[Buffer] Uploaded to: ${publicVideoUrl}`);
  io.emit("log", { slug, text: `✅ Uploaded: ${publicVideoUrl}\n` });

  const results = await buffer.publish({ caption, videoUrl: publicVideoUrl });

  const failed = results.filter(r => !r.success);
  if (failed.length > 0 && failed.length === results.length) {
    throw new Error(`All Buffer posts failed: ${failed.map(f => `${f.service}: ${f.error}`).join("; ")}`);
  }

  return { success: true, service: "buffer", results };
}

// ─── Server Setup ────────────────────────────────────────────────────────────

const server = http.createServer(handler);
const io = socketIo(server, { maxHttpBufferSize: 5e9 });
const activeProcesses = {};
const activeSteps = {};     // slug -> step name currently running
const serverLogs = {};      // slug -> buffered log text (persists across client refreshes)
const MAX_LOG_SIZE = 100000; // Keep last ~100KB of logs per episode

function appendServerLog(slug, text) {
  if (!serverLogs[slug]) serverLogs[slug] = "";
  serverLogs[slug] += text;
  // Trim if too large (keep tail)
  if (serverLogs[slug].length > MAX_LOG_SIZE) {
    serverLogs[slug] = serverLogs[slug].slice(-MAX_LOG_SIZE);
  }
}

// Monkey-patch io.emit to also buffer log messages server-side
const _origIoEmit = null; // will be set after io is used
function patchIoEmit() {
  const origEmit = io.emit.bind(io);
  io.emit = function(event, ...args) {
    if (event === "log" && args[0] && args[0].slug && args[0].text) {
      appendServerLog(args[0].slug, args[0].text);
    }
    return origEmit(event, ...args);
  };
}

async function handler(req, res) {
  try {
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

  // ── LLM Config (API key + base URL + model) ─────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/llm-config") {
    const config = llm.getConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      hasKey: !!config.key,
      baseUrl: config.baseUrl || "",
      model: config.model || "",
    }));
    return;
  }

  // Keep old endpoint as alias for backwards compat
  if (req.method === "GET" && url.pathname === "/api/gen-key-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasKey: hasApiKey() }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/llm-config") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { apiKey, baseUrl, model } = JSON.parse(body);
        if (apiKey !== undefined && apiKey && apiKey.length < 10) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Invalid key — too short" }));
          return;
        }
        const authPath = path.join(WORKSPACE_DIR, "auth.json");
        const existing = loadJSON(authPath) || {};
        existing.llm = existing.llm || {};
        if (apiKey !== undefined) existing.llm.key = apiKey || "";
        if (baseUrl !== undefined) existing.llm.baseUrl = baseUrl || "";
        if (model !== undefined) existing.llm.model = model || "";
        // Clean up old format
        if (existing.anthropic) delete existing.anthropic;
        saveJSON(authPath, existing);
        console.log("[LLM] Config saved:", { hasKey: !!existing.llm.key, baseUrl: existing.llm.baseUrl, model: existing.llm.model });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        io.emit("toast", { type: "success", message: "LLM settings saved" });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Keep old endpoint as alias
  if (req.method === "POST" && url.pathname === "/api/gen-key") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { apiKey } = JSON.parse(body);
        if (!apiKey || apiKey.length < 10) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Invalid key — too short" }));
          return;
        }
        const authPath = path.join(WORKSPACE_DIR, "auth.json");
        const existing = loadJSON(authPath) || {};
        existing.llm = existing.llm || {};
        existing.llm.key = apiKey;
        if (existing.anthropic) delete existing.anthropic;
        saveJSON(authPath, existing);
        console.log("[LLM] API key saved via legacy endpoint");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        io.emit("toast", { type: "success", message: "API key saved" });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Reel Version Info API ─────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/reel-versions") {
    const slug = url.searchParams.get("slug");
    if (!slug) { res.writeHead(400); res.end("Missing slug"); return; }
    const reelsDir = path.join(EPISODES_DIR, slug, "reels");
    if (!fs.existsSync(reelsDir)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reels: [] }));
      return;
    }
    const files = fs.readdirSync(reelsDir);
    const reelIdSet = new Set();
    files.forEach(f => { const m = f.match(/^reel-(\d+)/); if (m) reelIdSet.add(m[1]); });
    const reels = [...reelIdSet].sort().map(id => {
      const hasCut = files.includes(`reel-${id}.mp4`);
      const hasCropped = files.includes(`reel-${id}-cropped.mp4`);
      const hasSubtitled = files.includes(`reel-${id}-subtitled.mp4`);
      const serving = hasCropped ? "cropped" : hasSubtitled ? "subtitled" : "cut";
      return { id, hasCut, hasCropped, hasSubtitled, serving };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reels }));
    return;
  }

  // ── Video Serving API ──────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/video") {
    const slug = url.searchParams.get("slug");
    const type = url.searchParams.get("type"); // 'raw' or 'subtitled'
    const reelParam = url.searchParams.get("reel"); // e.g. "01", "02"
    console.log(`[Video API] slug=${slug}, type=${type}, reel=${reelParam}`);
    if (!slug) { res.writeHead(400); res.end("Missing slug"); return; }

    const dir = path.join(EPISODES_DIR, slug);
    console.log(`[Video API] dir=${dir}, exists=${fs.existsSync(dir)}`);
    let videoPath;

    if (reelParam) {
      // Serve individual reel: prefer final, then subtitled, then cropped, then raw cut
      const reelsDir = path.join(dir, "reels");
      const finalPath = path.join(reelsDir, `reel-${reelParam}-final.mp4`);
      const subtitledPath = path.join(reelsDir, `reel-${reelParam}-subtitled.mp4`);
      const croppedPath = path.join(reelsDir, `reel-${reelParam}-cropped.mp4`);
      const cutPath = path.join(reelsDir, `reel-${reelParam}.mp4`);
      videoPath = fs.existsSync(finalPath) ? finalPath :
                  fs.existsSync(subtitledPath) ? subtitledPath :
                  fs.existsSync(croppedPath) ? croppedPath : cutPath;
    } else if (type === 'compressed') {
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
    if (stat.size === 0) {
      res.writeHead(204); res.end(); return;
    }
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

        const aiResult = await callClaude("You are a video editor for the Tajarib podcast. Extract the best clips based on topics.", prompt, 1024);
        const clipData = JSON.parse(aiResult.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());
        
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
        
        // Create a synthetic analysis.json so cut.js can find the reel
        const startMin = Math.floor(clipData.start_time / 60);
        const startSec = Math.floor(clipData.start_time % 60);
        const endMin = Math.floor(clipData.end_time / 60);
        const endSec = Math.floor(clipData.end_time % 60);
        const analysisForClip = {
          reels: [{
            id: 1,
            title: clipData.hook,
            hook: clipData.hook,
            start: `${startMin}:${String(startSec).padStart(2, '0')}`,
            end: `${endMin}:${String(endSec).padStart(2, '0')}`,
            duration: Math.round(clipData.end_time - clipData.start_time)
          }]
        };
        saveJSON(path.join(reelDir, "analysis.json"), analysisForClip);

        // Run cut for this specific segment
        io.emit("log", { slug: reelSlug, text: `\n▶ Cutting topic clip: ${topic}\n` });

        const cutProc = spawn(NODE_BIN, [
          "cut.js",
          "--slug", reelSlug,
          "--video", videoFile
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
        
        // Call Claude for reel suggestions
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

        const aiContent = await callClaude("You are an expert video editor and social media strategist for the Tajarib Arabic podcast.", prompt, 2048);

        // Extract JSON
        const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
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

  // ── Assets API (overlay files: sponsor.mov, logo.mov) ──────────────────────
  const ASSETS_DIR = path.join(WORKSPACE_DIR, "assets");
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  if (req.method === "GET" && url.pathname === "/api/assets") {
    const assets = {};
    for (const name of ["sponsor.mov", "logo.mov"]) {
      const p = path.join(ASSETS_DIR, name);
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        assets[name.replace(".mov", "")] = { file: name, size: stat.size, sizeMb: (stat.size / 1024 / 1024).toFixed(1) };
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(assets));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload-asset") {
    const form = formidable({ uploadDir: UPLOADS_DIR, keepExtensions: true, maxFileSize: 500 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
      try {
        const assetType = Array.isArray(fields.type) ? fields.type[0] : (fields.type || ""); // "sponsor" or "logo"
        const file = files.file?.[0] || files.file;
        if (!assetType || !file) throw new Error("type and file required");
        if (!["sponsor", "logo", "cta"].includes(assetType)) throw new Error("type must be 'sponsor', 'logo', or 'cta'");

        const ext = assetType === "cta" ? path.extname(file.originalFilename || ".png") : ".mov";
        const destPath = path.join(ASSETS_DIR, `${assetType}${ext}`);
        fs.renameSync(file.filepath, destPath);

        const sizeMb = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1);
        const fileName = path.basename(destPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, file: fileName, sizeMb }));
        io.emit("toast", { type: "success", message: `${assetType} overlay uploaded (${sizeMb} MB)` });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── Overlay Config API ─────────────────────────────────────────────────────
  const overlayConfigMatch = url.pathname.match(/^\/api\/overlay-config\/(.+)$/);
  if (overlayConfigMatch) {
    const slug = decodeURIComponent(overlayConfigMatch[1]);
    const dir = path.join(EPISODES_DIR, slug);
    const configPath = path.join(dir, "overlay-config.json");

    if (req.method === "GET") {
      const defaults = {
        sponsor: { enabled: true, x: 1.3, y: 1.2, scale: 180 },
        logo: { enabled: true, x: 92.3, y: 1.2, scale: 140 },
        lowerThird: { enabled: true, startTime: 2, endTime: 8 },
        cta: { enabled: false, mode: "text", text: "www.tajarib.show", fontSize: 28, fontColor: "#ffffff", imagePath: "", x: 50, y: 85, scale: 200, startTime: 50, endTime: 58 }
      };
      const saved = loadJSON(configPath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(saved || defaults));
      return;
    }

    if (req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const config = JSON.parse(body);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          io.emit("toast", { type: "success", message: "Overlay config saved" });
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }
  }

  // ── Reel Thumbnail API ────────────────────────────────────────────────────
  const thumbMatch = url.pathname.match(/^\/api\/reel-thumbnail\/(.+?)\/(.+)$/);
  if (req.method === "GET" && thumbMatch) {
    const slug = decodeURIComponent(thumbMatch[1]);
    const reelId = thumbMatch[2];
    const dir = path.join(EPISODES_DIR, slug, "reels");
    const reelFile = path.join(dir, `reel-${reelId}.mp4`);
    const thumbFile = path.join(dir, `reel-${reelId}-thumb.jpg`);

    if (!fs.existsSync(reelFile)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Reel not found" }));
      return;
    }

    // Cache: only regenerate if thumb doesn't exist or is older than source
    if (!fs.existsSync(thumbFile) || fs.statSync(thumbFile).mtimeMs < fs.statSync(reelFile).mtimeMs) {
      try {
        const { execSync } = require("child_process");
        execSync(`ffmpeg -y -i "${reelFile}" -ss 3 -frames:v 1 -q:v 4 "${thumbFile}"`, { stdio: "pipe" });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Thumbnail generation failed" }));
        return;
      }
    }

    const data = fs.readFileSync(thumbFile);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" });
    res.end(data);
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
        // Helper: formidable v3 returns fields as arrays, safely extract string
        const field = (v, fallback = "") => {
          const val = Array.isArray(v) ? v[0] : v;
          return (val != null ? String(val) : fallback);
        };
        const rawSlug = field(fields.slug).trim();
        const pendingAiTitle = !rawSlug; // empty slug = AI will generate title after transcription
        const slug = pendingAiTitle
          ? `temp-${Date.now()}-${Math.random().toString(36).substr(2,6)}`
          : rawSlug.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
        const guest = field(fields.guest);
        const role = field(fields.role);
        const mediaType = field(fields.mediaType, "episode");
        const transcribeMethod = field(fields.transcribeMethod, "local");
        const multiTrack = field(fields.multiTrack) === "true";
        const videoFile = files.video?.[0] || files.video;
        const speakerFile = files.speaker?.[0] || files.speaker;
        const guestFile = files.guestTrack?.[0] || files.guestTrack;
        const srtFile = files.srt?.[0] || files.srt;

        if (!videoFile && !multiTrack) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "No video file provided" }));
          return;
        }

        if (multiTrack && (!speakerFile || !guestFile)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Multi-track requires both speaker and guest video files" }));
          return;
        }

        const epDir = path.join(EPISODES_DIR, slug);
        fs.mkdirSync(epDir, { recursive: true });

        let finalPath;
        let metaExtra = {};

        if (multiTrack) {
          // Multi-track: save both files
          const spkExt = path.extname(speakerFile.originalFilename || "").toLowerCase() || ".mp4";
          const gstExt = path.extname(guestFile.originalFilename || "").toLowerCase() || ".mp4";
          const speakerPath = path.join(epDir, `speaker${spkExt}`);
          const guestPath = path.join(epDir, `guest${gstExt}`);

          fs.renameSync(speakerFile.filepath, speakerPath);
          fs.renameSync(guestFile.filepath, guestPath);

          finalPath = speakerPath; // Use speaker track as primary for transcription
          metaExtra = {
            multiTrack: true,
            tracks: { speaker: speakerPath, guest: guestPath }
          };
          io.emit("log", { slug, text: `\n📁 Multi-track uploaded: speaker + guest\n` });
        } else {
          // Single file upload
          const ext = path.extname(videoFile.originalFilename || videoFile.newFilename || "").toLowerCase() || ".mp4";
          finalPath = path.join(epDir, `raw${ext}`);
          fs.renameSync(videoFile.filepath, finalPath);
          io.emit("log", { slug, text: `\n📁 Uploaded: ${videoFile.originalFilename || videoFile.newFilename}\n` });
        }

        // Save metadata
        saveMeta(slug, {
          mediaType,
          originalFilename: multiTrack ? "multi-track" : (videoFile.originalFilename || videoFile.newFilename),
          createdAt: new Date().toISOString(),
          rawVideo: finalPath,
          guest,
          role,
          transcribeMethod,
          ...(pendingAiTitle && { pendingAiTitle: true }),
          ...metaExtra
        });

        // Add guest to history
        if (guest) addGuestToHistory(guest, role);

        console.log("[Upload] srtFile:", srtFile ? `yes (${srtFile.originalFilename})` : "none");
        console.log("[Upload] files keys:", Object.keys(files));

        if (srtFile) {
          // SRT uploaded — parse it and skip transcription
          const srtContent = fs.readFileSync(srtFile.filepath, 'utf-8');
          const transcriptData = parseSrt(srtContent);
          transcriptData.slug = slug;
          transcriptData.source_file = finalPath;
          const transcriptPath = path.join(epDir, "transcript.json");
          saveJSON(transcriptPath, transcriptData);
          // Save raw SRT as backup
          const srtExt = path.extname(srtFile.originalFilename || ".srt").toLowerCase();
          fs.copyFileSync(srtFile.filepath, path.join(epDir, `uploaded${srtExt}`));
          fs.unlinkSync(srtFile.filepath);
          io.emit("log", { slug, text: `📄 SRT uploaded — transcription skipped (${transcriptData.segment_count} segments)\n` });
          io.emit("status-update", {});
          // Still handle post-transcription (AI title etc.)
          await handlePostTranscription(slug);
        } else {
          // No SRT — run transcription as usual
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
            if (code === 0) {
              await handlePostTranscription(slug);
            }
          });
        }

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

  // ── Publish (Zapier or Buffer) ───────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/publish") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { slug, service } = JSON.parse(body);
        const useBuffer = service === "buffer";
        const meta = loadMeta(slug);
        const content = loadJSON(path.join(EPISODES_DIR, slug, "content.json"));

        // Get caption from content.json if available, otherwise use a default
        let caption;
        if (content && content.reels && content.reels.length > 0) {
          caption = content.reels[0].caption;
        } else {
          const guest = meta.guest || "ضيف تاجرب";
          const role = meta.role || "";
          caption = `🎙️ ${guest}${role ? " - " + role : ""}\n\n#تجارب #بودكاست #ريادة_الأعمال`;
        }

        let videoPath;
        const dir = path.join(EPISODES_DIR, slug);

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
        io.emit("toast", { type: "success", message: `Preparing video for ${useBuffer ? "Buffer" : "Zapier"}...` });
        const publishVideoPath = await compressForPublish(videoPath, slug);

        let result;
        if (useBuffer) {
          result = await publishViaBuffer(slug, caption, publishVideoPath);
          const successCount = result.results.filter(r => r.success).length;
          const failCount = result.results.filter(r => !r.success).length;
          let toastMsg = `Buffer: ${successCount} channel(s) posted`;
          if (failCount > 0) toastMsg += `, ${failCount} failed`;
          io.emit("toast", { type: failCount > 0 ? "warning" : "success", message: toastMsg });
        } else {
          result = await publishViaZapier(slug, caption, publishVideoPath);
          io.emit("toast", { type: "success", message: "Sent to Zapier!" });
        }

        // Mark as published
        saveMeta(slug, { published: true, publishedAt: new Date().toISOString() });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, result }));
        io.emit("status-update", {});
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Buffer Config API ────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/buffer-config") {
    const config = buffer.loadConfig();
    // Don't expose full token to frontend
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      hasToken: !!config.accessToken,
      tokenPreview: config.accessToken ? "..." + config.accessToken.slice(-6) : null,
      enabled: config.enabled || false,
      channels: config.channels || {},
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/buffer-config") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { accessToken, enabled } = JSON.parse(body);
        const config = buffer.loadConfig();
        if (accessToken !== undefined) config.accessToken = accessToken;
        if (enabled !== undefined) config.enabled = enabled;
        buffer.saveConfig(config);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Fetch channels from Buffer API and save to config
  if (req.method === "POST" && url.pathname === "/api/buffer-channels") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const config = buffer.loadConfig();
        if (!config.accessToken) throw new Error("Buffer API token not configured");

        const account = await buffer.getAccount();
        if (!account.organizations || account.organizations.length === 0) {
          throw new Error("No organizations found in Buffer account");
        }

        const orgId = account.organizations[0].id;
        const channels = await buffer.getChannels(orgId);

        // Target services
        const TARGET_SERVICES = ["tiktok", "linkedin", "facebook", "youtube", "instagram"];
        const relevantChannels = channels.filter(ch => TARGET_SERVICES.includes(ch.service) && !ch.isDisconnected && !ch.isLocked);

        // Merge with existing config (preserve enabled state)
        const existingChannels = config.channels || {};
        const updatedChannels = {};
        for (const ch of relevantChannels) {
          updatedChannels[ch.id] = {
            id: ch.id,
            name: ch.name,
            service: ch.service,
            type: ch.type,
            avatar: ch.avatar,
            enabled: existingChannels[ch.id] ? existingChannels[ch.id].enabled : true,
          };
        }

        config.channels = updatedChannels;
        config.organizationId = orgId;
        config.organizationName = account.organizations[0].name;
        buffer.saveConfig(config);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, channels: updatedChannels, organization: account.organizations[0].name }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Toggle individual channel on/off
  if (req.method === "POST" && url.pathname === "/api/buffer-channel-toggle") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { channelId, enabled } = JSON.parse(body);
        const config = buffer.loadConfig();
        if (config.channels && config.channels[channelId]) {
          config.channels[channelId].enabled = enabled;
          buffer.saveConfig(config);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
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

  // ── Delete Episode API ─────────────────────────────────────────────────────
  if (req.method === "DELETE" && url.pathname === "/api/episodes") {
    const slug = url.searchParams.get("slug");
    if (!slug) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing slug parameter" }));
      return;
    }
    const epDir = path.join(EPISODES_DIR, slug);
    if (!fs.existsSync(epDir)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Episode not found" }));
      return;
    }
    try {
      // Kill any running process for this episode
      if (activeProcesses[slug]) {
        try { activeProcesses[slug].kill("SIGTERM"); } catch (_) {}
        delete activeProcesses[slug];
      }
      // Remove the episode directory
      fs.rmSync(epDir, { recursive: true, force: true });
      // Clean up logs
      if (logs[slug]) delete logs[slug];
      console.log(`[DELETE] Episode removed: ${slug}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      io.emit("status-update", {});
      io.emit("toast", { type: "success", message: `Deleted: ${slug}` });
    } catch (err) {
      console.error(`[DELETE] Error deleting ${slug}:`, err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
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

  // ── Manual LLM Response API ──────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/llm-response") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { slug, step, response: llmResponse, round } = JSON.parse(body);
        if (!slug || !step || !llmResponse) {
          throw new Error("slug, step, response all required");
        }

        const epDir = path.join(EPISODES_DIR, slug);
        // Save the response for the script to read on resume
        fs.writeFileSync(path.join(epDir, "llm-response.txt"), llmResponse, "utf8");
        io.emit("log", { slug, text: `\n📋 Manual LLM response received — resuming ${step}...\n` });

        // Re-run the step with --resume flag
        const meta = loadMeta(slug);
        const guest = meta.guest || "";
        const role = meta.role || "";
        const mediaType = meta.mediaType || "episode";

        let cmd, args;
        switch (step) {
          case "analyze":
            cmd = NODE_BIN;
            args = ["analyze.js", "--slug", slug, "--resume", "--force"];
            break;
          case "generate":
          case "reel-01":
          case "reel-1":
          case "youtube": {
            cmd = NODE_BIN;
            const extraArgs = (mediaType !== "episode") ? ["--reel-only"] : [];
            args = ["generate.js", "--slug", slug, "--guest", guest, "--role", role,
                    ...extraArgs, "--resume", "--resume-round", String(round || 0), "--force"];
            break;
          }
          case "compose":
            cmd = NODE_BIN;
            args = ["compose.js", "--slug", slug, "--ai-switch", "--resume", "--force"];
            break;
          default:
            throw new Error(`Unknown step for manual LLM: ${step}`);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));

        // Spawn the resume process
        const actualStep = (step === "youtube" || step.startsWith("reel")) ? "generate" : step;
        runStep({ slug, step: actualStep, force: true, mediaType, guest, role, resume: true, resumeRound: round || 0 });
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

        // Safety check: never save empty revision (can happen with reasoning models)
        if (!revised || !revised.trim()) {
          throw new Error("AI returned empty revision. Please try again.");
        }

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
        const { slug, step, force, model, ratio, faceTrack, reelId } = JSON.parse(body);
        if (!slug || !step) throw new Error("slug + step required");

        const meta = loadMeta(slug);
        const mediaType = meta.mediaType || "episode";

        if (mediaType === "reel_full" && !['generate', 'transcribe'].includes(step)) {
          throw new Error(`Step '${step}' not applicable for fully-produced reel.`);
        }
        if (mediaType === "reel_cut" && step === "cut") {
          throw new Error("Cut step not applicable — reel is already cut");
        }
        if (mediaType === "reel_cut" && step === "analyze") {
          throw new Error("Analyze step not applicable for pre-cut reels");
        }
        if (step === "compose" && !meta.multiTrack) {
          throw new Error("Compose step requires a multi-track episode");
        }
        if (step === "generate" && (!meta.guest || !meta.role)) {
          throw new Error("Guest name and role required for generation");
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));

        runStep({ slug, step, force, mediaType, guest: meta.guest, role: meta.role, model, ratio, faceTrack, reelId });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Save reel caption API ──────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/save-reel-caption") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { slug, reelId, caption } = JSON.parse(body);
        if (!slug || !reelId) throw new Error("slug + reelId required");
        const contentPath = path.join(EPISODES_DIR, slug, "content.json");
        const content = loadJSON(contentPath);
        if (!content || !content.reels) throw new Error("No content.json found");
        const reelNum = parseInt(reelId, 10);
        const reel = content.reels.find(r => r.id === reelNum || String(r.id).padStart(2, "0") === reelId);
        if (!reel) throw new Error("Reel not found in content");
        reel.caption = caption;
        saveJSON(contentPath, content);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Save selected reels API ──────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/save-selected-reels") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { slug, reels } = JSON.parse(body);
        if (!slug || !reels) throw new Error("slug + reels required");
        const selectedReelsPath = path.join(EPISODES_DIR, slug, "selected-reels.json");
        const selected = reels.filter(r => r.selected);
        saveJSON(selectedReelsPath, {
          slug,
          selected_at: new Date().toISOString(),
          reels: selected
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, count: selected.length }));
        io.emit("status-update", {});
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── Get analysis data API ──────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/analysis") {
    const slug = url.searchParams.get("slug");
    if (!slug) { res.writeHead(400); res.end("Missing slug"); return; }
    const analysisPath = path.join(EPISODES_DIR, slug, "analysis.json");
    if (!fs.existsSync(analysisPath)) { res.writeHead(404); res.end("No analysis"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(fs.readFileSync(analysisPath, "utf8"));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");

  } catch (err) {
    console.error("[Request Error]", req.method, req.url, err.message);
    try { res.writeHead(500); res.end("Internal Server Error"); } catch (_) {}
  }
}

// ─── Run Pipeline Step ───────────────────────────────────────────────────────

function runStep({ slug, step, force, mediaType, guest, role, model, ratio, faceTrack, reelId, resume, resumeRound }) {
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
      if (resume) args.push("--resume");
      break;
    case "generate":
      cmd = NODE_BIN;
      const extraArgs = (mediaType !== "episode") ? ["--reel-only"] : [];
      const modelArgs = model ? ["--model", model] : [];
      args = ["generate.js", "--slug", slug, "--guest", guest, "--role", role, ...extraArgs, ...modelArgs];
      if (reelId) args.push("--reel-id", reelId);
      if (force) args.push("--force");
      if (resume) { args.push("--resume"); args.push("--resume-round", String(resumeRound || 0)); }
      break;
    case "cut":
      if (!found) { io.emit("toast", { type: "error", message: `No video in ${slug}/` }); return; }
      cmd = NODE_BIN;
      args = ["cut.js", "--slug", slug, "--video", path.join(dir, videoFile)];
      if (fs.existsSync(path.join(dir, "selected-reels.json"))) {
        args.push("--selected-only");
      }
      if (force) args.push("--force");
      break;
    case "crop":
      cmd = NODE_BIN;
      args = ["crop.js", "--slug", slug];
      if (ratio) args.push("--ratio", ratio);
      if (faceTrack) args.push("--face-track");
      if (reelId) args.push("--reel-id", reelId);
      if (force) args.push("--force");
      break;
    case "subtitle":
      cmd = NODE_BIN;
      args = ["subtitle.js", "--slug", slug];
      if (reelId) args.push("--reel-id", reelId);
      if (force) args.push("--force");
      break;
    case "overlay": {
      cmd = NODE_BIN;
      const hasConfig = fs.existsSync(path.join(dir, "overlay-config.json"));
      args = ["overlay.js", "--slug", slug, hasConfig ? "--config" : "--all"];
      if (reelId) args.push("--reel-id", reelId);
      if (force) args.push("--force");
      break;
    }
    case "compose":
      cmd = NODE_BIN;
      args = ["compose.js", "--slug", slug];
      if (force) args.push("--force");
      if (resume) args.push("--resume");
      // Use AI switch points if no manual switches exist
      if (!fs.existsSync(path.join(dir, "switches.json"))) {
        args.push("--ai-switch");
      }
      break;
    default:
      io.emit("toast", { type: "error", message: `Unknown step: ${step}` });
      return;
  }

  activeSteps[slug] = step;
  const _rid = reelId || null;
  io.emit("log", { slug, reelId: _rid, text: `\n▶ Running: ${step}${_rid ? ' (reel ' + _rid + ')' : ''}\n` });
  io.emit("log", { slug, reelId: _rid, text: `   Command: ${cmd} ${args.join(" ")}\n` });
  io.emit("log", { slug, reelId: _rid, text: `   Working dir: ${WORKSPACE_DIR}\n` });
  io.emit("log", { slug, reelId: _rid, text: `   Starting process...\n\n` });
  io.emit("process-start", { slug, step, reelId: _rid });

  console.log(`[Spawning] ${cmd} ${args.join(" ")} in ${WORKSPACE_DIR}`);
  console.log(`[DEBUG] slug=${slug}, step=${step}, io.connected sockets=${io.engine?.clientsCount || 'unknown'}`);
  
  const proc = spawn(cmd, args, {
    cwd: WORKSPACE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
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
    io.emit("process-end", { slug, step, code: -1, reelId: _rid });
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
    io.emit("log", { slug, reelId: _rid, text });
  });
  proc.stderr.on("data", d => {
    gotFirstOutput = true;
    outputSent = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    const text = d.toString();
    stderrBuffer += text;
    io.emit("log", { slug, reelId: _rid, text });
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
    delete activeSteps[slug];

    // Exit code 42 = manual LLM mode: read prompt file and emit to frontend
    if (code === 42) {
      const promptPath = path.join(EPISODES_DIR, slug, "llm-prompt.json");
      if (fs.existsSync(promptPath)) {
        const promptData = loadJSON(promptPath);
        io.emit("log", { slug, text: `\n📋 Manual LLM mode — paste the response in the popup\n` });
        io.emit("llm-prompt", { slug, step, ...promptData });
      } else {
        io.emit("log", { slug, text: `\n❌ Exit 42 but no llm-prompt.json found\n` });
      }
      io.emit("process-end", { slug, step, code: 42, reelId: _rid });
      return;
    }

    io.emit("log", { slug, reelId: _rid, text: `\nExit code: ${code}\n${"─".repeat(40)}\n` });
    // Save crop ratio to meta when crop completes successfully
    if (step === "crop" && code === 0 && ratio) {
      saveMeta(slug, { cropRatio: ratio });
    }
    io.emit("process-end", { slug, step, code, reelId: _rid });
    io.emit("status-update", {});
    // Post-transcription: AI title generation if pending
    if (step === "transcribe" && code === 0) {
      await handlePostTranscription(slug);
    }
  });
}

// ─── Socket Handler ──────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  // Send current running state + buffered logs to reconnecting clients
  socket.emit("restore-state", {
    activeSteps,   // { slug: stepName } for any running processes
    logs: serverLogs // { slug: logText } buffered output
  });

  socket.on("stop-step", ({ slug }) => {
    if (activeProcesses[slug]) {
      const proc = activeProcesses[slug];
      // Kill entire process tree (Whisper spawns child processes)
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch (_) {
        try { proc.kill("SIGKILL"); } catch (_2) {}
      }
      delete activeProcesses[slug];
      delete activeSteps[slug];
      io.emit("log", { slug, text: "\n🛑 Process stopped manually.\n" });
      io.emit("process-end", { slug, step: "stopped", code: -1 });
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

patchIoEmit();

server.listen(PORT, "0.0.0.0", () => {
  console.log("🎙️  Tajarib Dashboard DEV → http://76.13.145.146:" + PORT);
  cleanupOrphanedUploads();
  // Run cleanup every hour
  setInterval(cleanupOrphanedUploads, 60 * 60 * 1000);
});
