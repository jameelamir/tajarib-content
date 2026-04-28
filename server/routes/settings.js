/**
 * Settings routes — guests, transcription config, LLM config.
 */
const fs = require("fs");
const path = require("path");
const { GLOBAL_AUTH_PATH } = require("../global-config");

module.exports = async function settingsRoutes(req, res, url, ctx) {
  const { io, WORKSPACE_DIR, loadJSON, saveJSON, getGuestHistory, getTranscriptionConfig, saveTranscriptionConfig, llm, readBody } = ctx;

  if (req.method === "GET" && url.pathname === "/api/guests") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getGuestHistory()));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/transcription-config") {
    const config = getTranscriptionConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    const effectiveDefault = config.defaultMethod || (config.groqApiKey ? "groq" : "local");
    const groqKeyHint = config.groqApiKey ? "gsk_..." + config.groqApiKey.slice(-4) : null;
    res.end(JSON.stringify({ hasApiKey: !!config.apiKey, hasGroqKey: !!config.groqApiKey, groqKeyHint, defaultMethod: effectiveDefault, localModel: config.localModel || "large-v3" }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/transcription-config") {
    const body = await readBody(req);
    try {
      const { apiKey, groqApiKey, defaultMethod, localModel } = JSON.parse(body);
      const config = getTranscriptionConfig();
      if (apiKey !== undefined) config.apiKey = apiKey || null;
      if (groqApiKey !== undefined) config.groqApiKey = groqApiKey || null;
      if (defaultMethod) config.defaultMethod = defaultMethod;
      if (localModel !== undefined) config.localModel = localModel || "large-v3";
      saveTranscriptionConfig(config);
      const savedConfig = getTranscriptionConfig();
      const groqKeyHint = savedConfig.groqApiKey ? "gsk_..." + savedConfig.groqApiKey.slice(-4) : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, hasApiKey: !!savedConfig.apiKey, hasGroqKey: !!savedConfig.groqApiKey, groqKeyHint }));
      io.emit("toast", { type: "success", message: "Transcription settings saved" });
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/llm-config") {
    const config = llm.getConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasKey: !!config.key, baseUrl: config.baseUrl || "", model: config.model || "", manualMode: config.manualMode || false }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/gen-key-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasKey: ctx.hasApiKey() }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/version") {
    let version = "unknown", sha = "dev", builtAt = "dev";
    try { version = JSON.parse(fs.readFileSync(path.join(ctx.WORKSPACE_DIR, "package.json"), "utf8")).version || version; } catch (_) {}
    try {
      const v = JSON.parse(fs.readFileSync(path.join(ctx.WORKSPACE_DIR, ".version.json"), "utf8"));
      sha = v.sha || sha; builtAt = v.builtAt || builtAt;
    } catch (_) {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version, sha, builtAt }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/llm-config") {
    const body = await readBody(req);
    try {
      const { apiKey, baseUrl, model, manualMode } = JSON.parse(body);
      if (apiKey !== undefined && apiKey && apiKey.length < 10) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid key — too short" }));
        return true;
      }
      const authPath = GLOBAL_AUTH_PATH;
      const existing = loadJSON(authPath) || {};
      existing.llm = existing.llm || {};
      if (apiKey !== undefined) existing.llm.key = apiKey || "";
      if (baseUrl !== undefined) existing.llm.baseUrl = baseUrl || "";
      if (model !== undefined) existing.llm.model = model || "";
      if (manualMode !== undefined) existing.llm.manualMode = !!manualMode;
      if (existing.anthropic) delete existing.anthropic;
      saveJSON(authPath, existing);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      io.emit("toast", { type: "success", message: "LLM settings saved" });
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/gen-key") {
    const body = await readBody(req);
    try {
      const { apiKey } = JSON.parse(body);
      if (!apiKey || apiKey.length < 10) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid key — too short" }));
        return true;
      }
      const authPath = GLOBAL_AUTH_PATH;
      const existing = loadJSON(authPath) || {};
      existing.llm = existing.llm || {};
      existing.llm.key = apiKey;
      if (existing.anthropic) delete existing.anthropic;
      saveJSON(authPath, existing);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      io.emit("toast", { type: "success", message: "API key saved" });
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  return false;
};
