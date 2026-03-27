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
      const { slug, service, bufferMode, channelIds, reelId } = JSON.parse(body);
      const useBuffer = service === "buffer";
      const meta = loadMeta(slug);
      const content = loadJSON(path.join(EPISODES_DIR, slug, "content.json"));

      let caption;
      if (reelId && content && content.reels) {
        const reel = content.reels.find(r => String(r.id).padStart(2, "0") === reelId);
        if (reel && reel.caption) caption = reel.caption;
      }
      if (!caption) {
        if (content && content.reels && content.reels.length > 0) caption = content.reels[0].caption;
        else { const guest = meta.guest || "ضيف تاجرب"; caption = `🎙️ ${guest}${meta.role ? " - " + meta.role : ""}\n\n#تجارب #بودكاست #ريادة_الأعمال`; }
      }

      let videoPath;
      const dir = path.join(EPISODES_DIR, slug);

      if (reelId) {
        // Publish a specific reel: prefer final > subtitled > cropped > raw
        const reelsDir = path.join(dir, "reels");
        const candidates = [`reel-${reelId}-final.mp4`, `reel-${reelId}-subtitled.mp4`, `reel-${reelId}-cropped.mp4`, `reel-${reelId}.mp4`];
        const found = candidates.find(f => fs.existsSync(path.join(reelsDir, f)));
        videoPath = found ? path.join(reelsDir, found) : path.join(reelsDir, `reel-${reelId}-subtitled.mp4`);
      } else {
        // No specific reel — prefer full-final > full-subtitled > first reel > raw
        const fullFinal = path.join(dir, "full-final.mp4");
        const fullSubtitled = path.join(dir, "full-subtitled.mp4");
        if (fs.existsSync(fullFinal)) videoPath = fullFinal;
        else if (fs.existsSync(fullSubtitled)) videoPath = fullSubtitled;
        else if (meta.mediaType === "reel_full") {
          const files = fs.readdirSync(dir);
          const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi)$/i.test(f) && !f.includes("reel") && !f.includes("final"));
          videoPath = path.join(dir, rawVideo || "raw.mp4");
        } else {
          const reelsDir = path.join(dir, "reels");
          if (fs.existsSync(reelsDir)) {
            const f = fs.readdirSync(reelsDir).find(f => f.endsWith("-final.mp4")) || fs.readdirSync(reelsDir).find(f => f.includes("subtitled") && f.endsWith(".mp4"));
            videoPath = f ? path.join(reelsDir, f) : path.join(reelsDir, "reel-001-subtitled.mp4");
          } else videoPath = path.join(dir, "reels", "reel-001-subtitled.mp4");
        }
      }

      if (!fs.existsSync(videoPath)) {
        io.emit("toast", { type: "error", message: `Video not found: ${path.basename(videoPath)}` });
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: `Video file not found: ${path.basename(videoPath)}` }));
        return true;
      }
      const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1);
      io.emit("toast", { type: "success", message: `[1/3] Compressing video (${sizeMB}MB)...` });
      const publishVideoPath = await compressForPublish(videoPath, slug);
      const finalSizeMB = (fs.statSync(publishVideoPath).size / 1024 / 1024).toFixed(1);

      let result;
      if (useBuffer) {
        io.emit("toast", { type: "success", message: `[2/3] Uploading ${finalSizeMB}MB to temp host...` });
        result = await publishViaBuffer(slug, caption, publishVideoPath, bufferMode, channelIds);
        const successCount = result.results.filter(r => r.success).length;
        const failCount = result.results.filter(r => !r.success).length;
        const failDetails = result.results.filter(r => !r.success).map(r => `${r.service}: ${r.error}`).join("; ");
        io.emit("toast", { type: failCount > 0 ? "warning" : "success", message: `[3/3] Buffer: ${successCount} posted${failCount > 0 ? `, ${failCount} failed — ${failDetails}` : ''}` });
      } else {
        io.emit("toast", { type: "success", message: `[2/3] Sending to Zapier...` });
        result = await publishViaZapier(slug, caption, publishVideoPath);
        io.emit("toast", { type: "success", message: "[3/3] Sent to Zapier!" });
      }

      saveMeta(slug, { published: true, publishedAt: new Date().toISOString() });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, result }));
      io.emit("status-update", {});
    } catch (err) {
      console.error("[Publish] Error:", err);
      io.emit("toast", { type: "error", message: `Publish failed: ${err.message}` });
      res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message }));
    }
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
