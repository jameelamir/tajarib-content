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
      const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi)$/i.test(f) && !f.includes("reel") && !f.includes("final"));

      const transcript = fs.existsSync(path.join(dir, "transcript.json"));
      const analysis = fs.existsSync(path.join(dir, "analysis.json"));
      const content = loadJSON(path.join(dir, "content.json"));

      const reelsDir = path.join(dir, "reels");
      const reelCount = fs.existsSync(reelsDir) 
        ? fs.readdirSync(reelsDir).filter(f => f.endsWith(".mp4") && !f.includes("-subtitled")).length 
        : 0;
      const finalCount = fs.existsSync(reelsDir) 
        ? fs.readdirSync(reelsDir).filter(f => f.endsWith("-subtitled.mp4")).length 
        : 0;

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

async function callModelForRevision(originalContent, feedback) {
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

  const prompt = `You generated the following Arabic content for the Tajarib podcast:

---BEGIN CONTENT---
${originalContent}
---END CONTENT---

The user has provided this feedback:
"${feedback}"

Please return a revised version that incorporates the feedback exactly, keeping the same format and language style (Iraqi white Arabic). Output only the revised content — no explanations, no extra text.`;

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

const ZAPIER_WEBHOOK_URL = "https://hooks.zapier.com/hooks/catch/25372282/uc0sion/";

async function publishViaZapier(slug, caption, videoPath) {
  // Send webhook to Zapier with caption and video URL
  const meta = loadMeta(slug);
  const isReelFull = meta.mediaType === "reel_full";
  const videoType = isReelFull ? "raw" : "subtitled";
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
    const indexPath = path.join(__dirname, "public", "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(indexPath, "utf8"));
    } else {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("index.html not found");
    }
    return;
  }

  // ── Guest History API ─────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/guests") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getGuestHistory()));
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
    
    if (type === 'subtitled') {
      // Look for subtitled reel file (could be reel-01-subtitled.mp4 or reel-001-subtitled.mp4)
      const reelsDir = path.join(dir, "reels");
      console.log(`[Video API] reelsDir=${reelsDir}, exists=${fs.existsSync(reelsDir)}`);
      if (fs.existsSync(reelsDir)) {
        const files = fs.readdirSync(reelsDir);
        console.log(`[Video API] files in reels:`, files);
        const subtitled = files.find(f => f.includes("subtitled") && f.endsWith(".mp4"));
        videoPath = subtitled ? path.join(reelsDir, subtitled) : path.join(reelsDir, "reel-001-subtitled.mp4");
      } else {
        videoPath = path.join(dir, "reels", "reel-001-subtitled.mp4");
      }
    } else {
      // Find raw video
      const files = fs.readdirSync(dir);
      const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi)$/i.test(f) && !f.includes("reel") && !f.includes("final"));
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

  // ── Publish via Zapier Webhook ────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/publish") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { slug } = JSON.parse(body);
        const meta = loadMeta(slug);
        const content = loadJSON(path.join(EPISODES_DIR, slug, "content.json"));
        
        if (!content || !content.reels || content.reels.length === 0) {
          throw new Error("No reel content found");
        }

        const caption = content.reels[0].caption;
        
        // For reel_full, use the raw video (already subtitled)
        // For reel_cut, use the subtitled reel from reels folder
        let videoPath;
        const dir = path.join(EPISODES_DIR, slug);
        if (meta.mediaType === "reel_full") {
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
        
        const result = await publishViaZapier(slug, caption, videoPath);
        
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

        const revised = await callModelForRevision(currentContent, feedback);

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

      const slug = Array.isArray(fields.slug) ? fields.slug[0] : fields.slug;
      const guest = Array.isArray(fields.guest) ? fields.guest[0] : fields.guest;
      const role = Array.isArray(fields.role) ? fields.role[0] : fields.role;
      const mediaType = (Array.isArray(fields.mediaType) ? fields.mediaType[0] : fields.mediaType) || "episode";
      const transcribeMethod = (Array.isArray(fields.transcribeMethod) ? fields.transcribeMethod[0] : fields.transcribeMethod) || "local";
      const file = Array.isArray(files.video) ? files.video[0] : files.video;

      if (!slug || !file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "slug and video file required" }));
        return;
      }

      const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
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
        ...(role && { role })
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

        if (mediaType === "reel_full" && step !== "generate") {
          throw new Error(`Step '${step}' not applicable for fully-produced reel`);
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
  const found = fs.readdirSync(dir).find(f => /\.(mp4|mkv|mov|avi)$/i.test(f) && !f.includes("reel") && !f.includes("final"));
  if (found) videoFile = found;

  switch (step) {
    case "transcribe":
      if (!found) { io.emit("toast", { type: "error", message: `No video in ${slug}/` }); return; }
      cmd = PYTHON_BIN;
      args = ["-u", "transcribe.py", path.join("episodes", slug, videoFile), "--slug", slug];
      if (force) args.push("--force");
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

  io.emit("log", { slug, text: `\n▶ ${cmd} ${args.join(" ")}\n` });
  io.emit("process-start", { slug, step });

  const proc = spawn(cmd, args, { cwd: WORKSPACE_DIR });
  activeProcesses[slug] = proc;

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
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    io.emit("log", { slug, text: d.toString() });
  });
  proc.stderr.on("data", d => {
    gotFirstOutput = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    io.emit("log", { slug, text: d.toString() });
  });

  proc.on("close", (code) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    delete activeProcesses[slug];
    io.emit("log", { slug, text: `\nExit code: ${code}\n${"─".repeat(40)}\n` });
    io.emit("process-end", { slug, step, code });
    io.emit("status-update", {});
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

server.listen(PORT, "0.0.0.0", () => {
  console.log("🎙️  Tajarib Dashboard DEV → http://76.13.145.146:" + PORT);
});
