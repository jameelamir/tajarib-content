/**
 * Content routes — prompts CRUD, topic clips, analyze clips, delete video.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

module.exports = async function contentRoutes(req, res, url, ctx) {
  const { io, WORKSPACE_DIR, EPISODES_DIR, NODE_BIN, loadJSON, saveJSON, loadMeta, saveMeta, callClaude, askLlmModeChoice, prompts, readBody } = ctx;

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

  if (req.method === "POST" && url.pathname === "/api/analyze-clips") {
    const body = await readBody(req);
    try {
      const { slug, guest, role } = JSON.parse(body);
      if (!slug) throw new Error("slug required");
      const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
      if (!fs.existsSync(transcriptPath)) throw new Error("Transcript not found. Upload MP3 first.");
      const choice = askLlmModeChoice ? await askLlmModeChoice({ slug, step: "analyze-clips", description: "AI-suggest reel-worthy clips from transcript" }) : "ai";
      const transcript = loadJSON(transcriptPath);
      function fmtTime(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`; }
      const segments = transcript.segments.map(s => `[${fmtTime(s.start)} - ${fmtTime(s.end)}] ${s.text}`).slice(0, 100).join('\n');
      const systemPrompt = prompts.load("reel-suggest-system");
      const prompt = prompts.load("reel-suggest-user", { guest: guest || "Unknown", role: role || "Unknown", segments });
      const aiContent = await callClaude(systemPrompt, prompt, 2048, { slug, step: "analyze-clips", expectedFormat: "json", forceManual: choice === "manual" });
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
