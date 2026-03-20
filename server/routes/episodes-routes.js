/**
 * Episode routes — list, delete, file read/write, save-content, set-meta, analysis, validate-model, manual-caption.
 */
const fs = require("fs");
const path = require("path");

module.exports = async function episodesRoutes(req, res, url, ctx) {
  const { io, WORKSPACE_DIR, EPISODES_DIR, loadJSON, saveJSON, loadMeta, saveMeta, addGuestToHistory, getEpisodes, activeProcesses, logs, readBody } = ctx;

  if (req.method === "GET" && url.pathname === "/api/episodes") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getEpisodes()));
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/episodes") {
    const slug = url.searchParams.get("slug");
    if (!slug) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing slug parameter" })); return true; }
    const epDir = path.join(EPISODES_DIR, slug);
    if (!fs.existsSync(epDir)) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Episode not found" })); return true; }
    try {
      if (activeProcesses[slug]) { try { activeProcesses[slug].kill("SIGTERM"); } catch (_) {} delete activeProcesses[slug]; }
      fs.rmSync(epDir, { recursive: true, force: true });
      if (logs[slug]) delete logs[slug];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      io.emit("status-update", {}); io.emit("toast", { type: "success", message: `Deleted: ${slug}` });
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const slug = url.searchParams.get("slug"), file = url.searchParams.get("file");
    if (!slug || !file) { res.writeHead(400); res.end("Missing params"); return true; }
    const filePath = path.join(EPISODES_DIR, slug, file);
    if (fs.existsSync(filePath)) { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end(fs.readFileSync(filePath, "utf8")); }
    else { res.writeHead(404); res.end(""); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/file") {
    const body = await readBody(req);
    try {
      const { slug, file, content } = JSON.parse(body);
      const filePath = path.join(EPISODES_DIR, slug, file);
      if (!fs.existsSync(path.dirname(filePath))) throw new Error("Directory missing");
      fs.writeFileSync(filePath, content, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
      io.emit("toast", { type: "success", message: `Saved ${file}` });
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/save-content") {
    const body = await readBody(req);
    try {
      const { slug, field, value } = JSON.parse(body);
      const contentPath = path.join(EPISODES_DIR, slug, "content.json");
      const content = loadJSON(contentPath);
      if (!content) throw new Error("No content.json found");
      const parts = field.split("."); let ref = content;
      for (let i = 0; i < parts.length - 1; i++) { ref = ref[parts[i]]; if (ref === undefined) throw new Error(`Field path not found: ${field}`); }
      ref[parts[parts.length - 1]] = value;
      saveJSON(contentPath, content);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
      io.emit("toast", { type: "success", message: "Content saved" });
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/set-meta") {
    const body = await readBody(req);
    try {
      const { slug, guest, role, mediaType } = JSON.parse(body);
      if (!slug) throw new Error("slug required");
      if (guest) addGuestToHistory(guest, role || "");
      saveMeta(slug, { ...(guest && { guest }), ...(role && { role }), ...(mediaType && { mediaType }) });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
      io.emit("status-update", {});
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/analysis") {
    const slug = url.searchParams.get("slug");
    if (!slug) { res.writeHead(400); res.end("Missing slug"); return true; }
    const analysisPath = path.join(EPISODES_DIR, slug, "analysis.json");
    if (!fs.existsSync(analysisPath)) { res.writeHead(404); res.end("No analysis"); return true; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(fs.readFileSync(analysisPath, "utf8"));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/manual-caption") {
    const body = await readBody(req);
    try {
      const { slug, caption } = JSON.parse(body);
      if (!slug || !caption) throw new Error("slug and caption required");
      const meta = loadMeta(slug);
      const contentPath = path.join(EPISODES_DIR, slug, "content.json");
      const existing = loadJSON(contentPath);
      if (existing) {
        if (existing.reels && existing.reels.length > 0) existing.reels[0].caption = caption;
        else existing.reels = [{ id: "reel-01", caption }];
        existing.manual = true; existing.updated_at = new Date().toISOString();
        saveJSON(contentPath, existing);
      } else {
        saveJSON(contentPath, { slug, generated_at: new Date().toISOString(), guest: meta.guest || "", role: meta.role || "", manual: true, reel_only: true, reels: [{ id: "reel-01", caption }] });
      }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
      io.emit("toast", { type: "success", message: "Caption saved" }); io.emit("status-update", {});
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/validate-model") {
    const model = url.searchParams.get("model");
    if (!model) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ valid: false, error: "No model specified" })); return true; }
    const knownAliases = { 'auto': 'Claude Sonnet 4.5 (default)', 'claude': 'Claude (Anthropic)', 'claude-sonnet-4-5-20241022': 'Claude Sonnet 4.5', 'claude-sonnet': 'Claude Sonnet', 'claude-opus': 'Claude Opus', 'claude-haiku': 'Claude Haiku', 'openai': 'OpenAI', 'gpt-4o': 'GPT-4o', 'gpt-4o-mini': 'GPT-4o Mini', 'gpt-4': 'GPT-4', 'gpt-4-turbo': 'GPT-4 Turbo', 'gemini': 'Gemini (Google)', 'haimaker/auto': 'HAI Maker Auto', 'openrouter/auto': 'OpenRouter Auto' };
    const normalized = model.toLowerCase().trim();
    if (knownAliases[normalized]) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ valid: true, displayName: knownAliases[normalized] })); return true; }
    try {
      let apiKey; try { const m = loadJSON("/root/.openclaw/agents/main/agent/models.json"); apiKey = m?.providers?.haimaker?.apiKey; } catch (_) {}
      if (!apiKey) { const auth = loadJSON("/root/.openclaw/agents/main/agent/auth.json"); apiKey = auth?.haimaker?.key; }
      if (apiKey) {
        const apiRes = await fetch("https://api.haimaker.ai/v1/models", { headers: { "Authorization": `Bearer ${apiKey}` } });
        if (apiRes.ok) { const data = await apiRes.json(); const match = (data.data || []).find(m => m.id === model || m.id === normalized); if (match) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ valid: true, displayName: match.id })); return true; } }
      }
    } catch (_) {}
    const validPattern = /^[a-z0-9]+([\/:._-][a-z0-9-]+)*$/i;
    if (validPattern.test(model)) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ valid: true, displayName: model, note: "Custom model" })); return true; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ valid: false, error: "Invalid model format" }));
    return true;
  }

  return false;
};
