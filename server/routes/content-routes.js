/**
 * Content routes — prompts CRUD, topic clips, analyze clips, delete video.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

module.exports = async function contentRoutes(req, res, url, ctx) {
  const { io, WORKSPACE_DIR, EPISODES_DIR, NODE_BIN, loadJSON, saveJSON, loadMeta, saveMeta, callClaude, prompts, readBody } = ctx;

  if (req.method === "GET" && url.pathname === "/api/prompts") {
    try {
      const files = fs.readdirSync(prompts.PROMPTS_DIR).filter(f => f.endsWith(".md")).sort();
      const result = files.map(f => ({ name: f.replace(/\.md$/, ""), content: fs.readFileSync(path.join(prompts.PROMPTS_DIR, f), "utf8") }));
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/prompts/")) {
    const promptName = decodeURIComponent(url.pathname.replace("/api/prompts/", ""));
    if (!promptName || /[\/\\]/.test(promptName)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid prompt name" })); return true; }
    const body = await readBody(req);
    try {
      const { content } = JSON.parse(body);
      if (typeof content !== "string") throw new Error("content must be a string");
      const filePath = path.join(prompts.PROMPTS_DIR, `${promptName}.md`);
      if (!fs.existsSync(filePath)) throw new Error("Prompt not found: " + promptName);
      fs.writeFileSync(filePath, content, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
      io.emit("toast", { type: "success", message: `Prompt "${promptName}" saved` });
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/generate-topic-clip") {
    const body = await readBody(req);
    try {
      const { slug, topic, guest, role } = JSON.parse(body);
      if (!slug || !topic) throw new Error("slug and topic required");
      const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
      if (!fs.existsSync(transcriptPath)) throw new Error("Transcript not found");
      const transcript = loadJSON(transcriptPath);
      const transcriptText = transcript.full_text || transcript.segments.map(s => s.text).join(' ');
      const systemPrompt = prompts.load("topic-clip-system");
      const prompt = prompts.load("topic-clip-user", { topic, transcriptText });
      const aiResult = await callClaude(systemPrompt, prompt, 1024, { slug, step: "topic-clip", expectedFormat: "json" });
      const clipData = JSON.parse(aiResult.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());

      const content = { guest, role, opener: clipData.hook, reels: [{ id: "topic-" + Date.now(), hook: clipData.hook, caption: clipData.caption, start_time: clipData.start_time, end_time: clipData.end_time, duration: clipData.end_time - clipData.start_time, purpose: "Topic: " + topic }], createdAt: new Date().toISOString() };
      const reelSlug = slug + "-" + topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 30);
      const reelDir = path.join(EPISODES_DIR, reelSlug);
      fs.mkdirSync(reelDir, { recursive: true });
      const meta = loadMeta(slug);
      const videoFile = meta.rawVideo || path.join(EPISODES_DIR, slug, "raw.mp4");
      saveMeta(reelSlug, { mediaType: "reel_full", originalFilename: meta.originalFilename, createdAt: new Date().toISOString(), rawVideo: videoFile, guest, role, sourceEpisode: slug, topic });
      fs.copyFileSync(transcriptPath, path.join(reelDir, "transcript.json"));
      saveJSON(path.join(reelDir, "content.json"), content);

      const startMin = Math.floor(clipData.start_time / 60), startSec = Math.floor(clipData.start_time % 60);
      const endMin = Math.floor(clipData.end_time / 60), endSec = Math.floor(clipData.end_time % 60);
      saveJSON(path.join(reelDir, "analysis.json"), { reels: [{ id: 1, title: clipData.hook, hook: clipData.hook, start: `${startMin}:${String(startSec).padStart(2, '0')}`, end: `${endMin}:${String(endSec).padStart(2, '0')}`, duration: Math.round(clipData.end_time - clipData.start_time) }] });

      io.emit("log", { slug: reelSlug, text: `\n▶ Cutting topic clip: ${topic}\n` });
      const cutProc = spawn(NODE_BIN, ["cut.js", "--slug", reelSlug, "--video", videoFile], { cwd: WORKSPACE_DIR });
      cutProc.stdout.on("data", d => io.emit("log", { slug: reelSlug, text: d.toString() }));
      cutProc.stderr.on("data", d => io.emit("log", { slug: reelSlug, text: d.toString() }));
      cutProc.on("close", (code) => { io.emit("log", { slug: reelSlug, text: `\nClip cut complete. Exit: ${code}\n` }); io.emit("status-update", {}); });

      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, slug: reelSlug }));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/analyze-clips") {
    const body = await readBody(req);
    try {
      const { slug, guest, role } = JSON.parse(body);
      if (!slug) throw new Error("slug required");
      const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
      if (!fs.existsSync(transcriptPath)) throw new Error("Transcript not found. Upload MP3 first.");
      const transcript = loadJSON(transcriptPath);
      function fmtTime(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`; }
      const segments = transcript.segments.map(s => `[${fmtTime(s.start)} - ${fmtTime(s.end)}] ${s.text}`).slice(0, 100).join('\n');
      const systemPrompt = prompts.load("reel-suggest-system");
      const prompt = prompts.load("reel-suggest-user", { guest: guest || "Unknown", role: role || "Unknown", segments });
      const aiContent = await callClaude(systemPrompt, prompt, 2048, { slug, step: "analyze-clips", expectedFormat: "json" });
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Could not parse AI response");
      const result = JSON.parse(jsonMatch[0]);
      saveJSON(path.join(EPISODES_DIR, slug, "clip-suggestions.json"), { createdAt: new Date().toISOString(), guest, role, clips: result.clips });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, clips: result.clips, analysis: result.analysis }));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/delete-video") {
    const body = await readBody(req);
    try {
      const { slug, fileType } = JSON.parse(body);
      if (!slug) throw new Error("slug required");
      const dir = path.join(EPISODES_DIR, slug);
      if (!fs.existsSync(dir)) throw new Error("Episode not found");
      let deleted = [], freedBytes = 0;
      if (fileType === "raw" || fileType === "all") {
        const files = fs.readdirSync(dir);
        const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi|mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && !f.includes("reel") && !f.includes("final") && !f.includes("subtitled"));
        if (rawVideo) { const stats = fs.statSync(path.join(dir, rawVideo)); fs.unlinkSync(path.join(dir, rawVideo)); deleted.push(rawVideo); freedBytes += stats.size; const meta = loadMeta(slug); if (meta.rawVideo) { delete meta.rawVideo; saveMeta(slug, meta); } }
      }
      if (fileType === "processed" || fileType === "all") {
        const reelsDir = path.join(dir, "reels");
        if (fs.existsSync(reelsDir)) { for (const f of fs.readdirSync(reelsDir).filter(f => f.endsWith(".mp4"))) { const stats = fs.statSync(path.join(reelsDir, f)); fs.unlinkSync(path.join(reelsDir, f)); deleted.push(`reels/${f}`); freedBytes += stats.size; } }
        const fullSub = path.join(dir, "full-subtitled.mp4");
        if (fs.existsSync(fullSub)) { const stats = fs.statSync(fullSub); fs.unlinkSync(fullSub); deleted.push("full-subtitled.mp4"); freedBytes += stats.size; }
      }
      if (fileType === "transcript" || fileType === "all") {
        const tp = path.join(dir, "transcript.json");
        if (fs.existsSync(tp)) { const stats = fs.statSync(tp); fs.unlinkSync(tp); deleted.push("transcript.json"); freedBytes += stats.size; }
      }
      const freedMb = (freedBytes / 1024 / 1024).toFixed(1);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, deleted, freedBytes, freedMb: parseFloat(freedMb) }));
      io.emit("toast", { type: "success", message: `Deleted ${deleted.length} files, freed ${freedMb} MB` }); io.emit("status-update", {});
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  return false;
};
