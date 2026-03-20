/**
 * Publish routes — Zapier/Buffer publishing, Buffer config/channels.
 */
const fs = require("fs");
const path = require("path");

module.exports = async function publishRoutes(req, res, url, ctx) {
  const { io, EPISODES_DIR, loadJSON, loadMeta, saveMeta, readBody, compressForPublish, publishViaZapier, publishViaBuffer, buffer } = ctx;

  if (req.method === "POST" && url.pathname === "/api/publish") {
    const body = await readBody(req);
    try {
      const { slug, service, bufferMode } = JSON.parse(body);
      const useBuffer = service === "buffer";
      const meta = loadMeta(slug);
      const content = loadJSON(path.join(EPISODES_DIR, slug, "content.json"));

      let caption;
      if (content && content.reels && content.reels.length > 0) caption = content.reels[0].caption;
      else { const guest = meta.guest || "ضيف تاجرب"; caption = `🎙️ ${guest}${meta.role ? " - " + meta.role : ""}\n\n#تجارب #بودكاست #ريادة_الأعمال`; }

      let videoPath;
      const dir = path.join(EPISODES_DIR, slug);
      const fullSubtitled = path.join(dir, "full-subtitled.mp4");
      if (fs.existsSync(fullSubtitled)) videoPath = fullSubtitled;
      else if (meta.mediaType === "reel_full") {
        const files = fs.readdirSync(dir);
        const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi)$/i.test(f) && !f.includes("reel") && !f.includes("final"));
        videoPath = path.join(dir, rawVideo || "raw.mp4");
      } else {
        const reelsDir = path.join(dir, "reels");
        if (fs.existsSync(reelsDir)) { const f = fs.readdirSync(reelsDir).find(f => f.includes("subtitled") && f.endsWith(".mp4")); videoPath = f ? path.join(reelsDir, f) : path.join(reelsDir, "reel-001-subtitled.mp4"); }
        else videoPath = path.join(dir, "reels", "reel-001-subtitled.mp4");
      }

      io.emit("toast", { type: "success", message: `Preparing video for ${useBuffer ? "Buffer" : "Zapier"}...` });
      const publishVideoPath = await compressForPublish(videoPath, slug);

      let result;
      if (useBuffer) {
        result = await publishViaBuffer(slug, caption, publishVideoPath, bufferMode);
        const successCount = result.results.filter(r => r.success).length;
        const failCount = result.results.filter(r => !r.success).length;
        io.emit("toast", { type: failCount > 0 ? "warning" : "success", message: `Buffer: ${successCount} channel(s) posted${failCount > 0 ? `, ${failCount} failed` : ''}` });
      } else {
        result = await publishViaZapier(slug, caption, publishVideoPath);
        io.emit("toast", { type: "success", message: "Sent to Zapier!" });
      }

      saveMeta(slug, { published: true, publishedAt: new Date().toISOString() });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, result }));
      io.emit("status-update", {});
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/buffer-config") {
    const config = buffer.loadConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasToken: !!config.accessToken, tokenPreview: config.accessToken ? "..." + config.accessToken.slice(-6) : null, enabled: config.enabled || false, channels: config.channels || {} }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/buffer-config") {
    const body = await readBody(req);
    try {
      const { accessToken, enabled } = JSON.parse(body);
      const config = buffer.loadConfig();
      if (accessToken !== undefined) config.accessToken = accessToken;
      if (enabled !== undefined) config.enabled = enabled;
      buffer.saveConfig(config);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/buffer-channels") {
    const body = await readBody(req);
    try {
      const config = buffer.loadConfig();
      if (!config.accessToken) throw new Error("Buffer API token not configured");
      const account = await buffer.getAccount();
      if (!account.organizations || account.organizations.length === 0) throw new Error("No organizations found in Buffer account");
      const orgId = account.organizations[0].id;
      const channels = await buffer.getChannels(orgId);
      const TARGET_SERVICES = ["tiktok", "linkedin", "facebook", "youtube", "instagram"];
      const relevantChannels = channels.filter(ch => TARGET_SERVICES.includes(ch.service) && !ch.isDisconnected && !ch.isLocked);
      const existingChannels = config.channels || {};
      const updatedChannels = {};
      for (const ch of relevantChannels) {
        updatedChannels[ch.id] = { id: ch.id, name: ch.name, service: ch.service, type: ch.type, avatar: ch.avatar, enabled: existingChannels[ch.id] ? existingChannels[ch.id].enabled : true };
      }
      config.channels = updatedChannels; config.organizationId = orgId; config.organizationName = account.organizations[0].name;
      buffer.saveConfig(config);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, channels: updatedChannels, organization: account.organizations[0].name }));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/buffer-channel-toggle") {
    const body = await readBody(req);
    try {
      const { channelId, enabled } = JSON.parse(body);
      const config = buffer.loadConfig();
      if (config.channels && config.channels[channelId]) { config.channels[channelId].enabled = enabled; buffer.saveConfig(config); }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  return false;
};
