/**
 * Storage routes — disk usage, storage config, file deletion, server status.
 */
const fs = require("fs");
const path = require("path");

module.exports = async function storageRoutes(req, res, url, ctx) {
  const { io, EPISODES_DIR, UPLOADS_DIR, loadMeta, readBody, getStorageConfig, saveStorageConfig, categorizeFile, calcDirSize } = ctx;

  if (req.method === "GET" && url.pathname === "/api/storage") {
    try {
      const config = getStorageConfig();
      const quotaBytes = config.quotaGB * 1024 * 1024 * 1024;
      let totalBytes = 0;
      const episodeStorage = [];

      if (fs.existsSync(EPISODES_DIR)) {
        const slugs = fs.readdirSync(EPISODES_DIR)
          .filter(f => { try { return fs.statSync(path.join(EPISODES_DIR, f)).isDirectory(); } catch (_) { return false; } });

        for (const slug of slugs) {
          const dir = path.join(EPISODES_DIR, slug);
          const meta = loadMeta(slug);
          const breakdown = { raw: 0, reels: 0, subtitled: 0, final: 0, json: 0, other: 0 };
          const fileList = [];

          try {
            for (const f of fs.readdirSync(dir)) {
              const fp = path.join(dir, f);
              try {
                const stat = fs.statSync(fp);
                if (stat.isFile()) {
                  const cat = categorizeFile(f);
                  breakdown[cat] += stat.size;
                  fileList.push({ name: f, path: f, size: stat.size, category: cat, mtime: stat.mtimeMs });
                }
              } catch (_) {}
            }
          } catch (_) {}

          const reelsDir = path.join(dir, "reels");
          if (fs.existsSync(reelsDir)) {
            try {
              for (const f of fs.readdirSync(reelsDir)) {
                const fp = path.join(reelsDir, f);
                try {
                  const stat = fs.statSync(fp);
                  if (stat.isFile()) {
                    const cat = categorizeFile(f);
                    breakdown[cat] += stat.size;
                    fileList.push({ name: f, path: `reels/${f}`, size: stat.size, category: cat, mtime: stat.mtimeMs });
                  }
                } catch (_) {}
              }
            } catch (_) {}
          }

          const epTotal = Object.values(breakdown).reduce((a, b) => a + b, 0);
          totalBytes += epTotal;
          episodeStorage.push({ slug, guest: meta.guest || "", mediaType: meta.mediaType || "episode", createdAt: meta.createdAt || null, totalBytes: epTotal, breakdown, files: fileList });
        }
      }

      let uploadsBytes = 0;
      if (fs.existsSync(UPLOADS_DIR)) { uploadsBytes = calcDirSize(UPLOADS_DIR); totalBytes += uploadsBytes; }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ totalBytes, quotaBytes, quotaGB: config.quotaGB, usedGB: +(totalBytes / (1024 * 1024 * 1024)).toFixed(2), percentUsed: quotaBytes > 0 ? +((totalBytes / quotaBytes) * 100).toFixed(1) : 0, uploadsBytes, episodes: episodeStorage }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/storage-config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getStorageConfig()));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/storage-config") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      const existing = getStorageConfig();
      if (parsed.quotaGB !== undefined) {
        if (typeof parsed.quotaGB !== "number" || parsed.quotaGB < 1) throw new Error("Invalid quota");
        existing.quotaGB = parsed.quotaGB;
      }
      if (parsed.sharedAssetsDir !== undefined) {
        existing.sharedAssetsDir = parsed.sharedAssetsDir || undefined;
      }
      saveStorageConfig(existing);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, ...existing }));
      io.emit("toast", { type: "success", message: `Storage config updated` });
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/delete-files") {
    const body = await readBody(req);
    try {
      const { slug, files } = JSON.parse(body);
      if (!slug || !Array.isArray(files) || files.length === 0) throw new Error("slug and files[] required");
      const dir = path.join(EPISODES_DIR, slug);
      if (!fs.existsSync(dir)) throw new Error("Episode not found");
      const deleted = []; let freedBytes = 0;
      for (const relPath of files) {
        const safe = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
        const fullPath = path.join(dir, safe);
        if (!fullPath.startsWith(dir)) continue;
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const size = fs.statSync(fullPath).size; fs.unlinkSync(fullPath); deleted.push(safe); freedBytes += size;
        }
      }
      const freedMb = (freedBytes / 1024 / 1024).toFixed(1);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, deleted, freedBytes, freedMb: parseFloat(freedMb) }));
      io.emit("toast", { type: "success", message: `Deleted ${deleted.length} file(s), freed ${freedMb} MB` });
      io.emit("status-update", {});
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/server-status") {
    try {
      const { execFileSync } = require("child_process");
      const dfRaw = execFileSync("df", ["-B1", ctx.WORKSPACE_DIR], { encoding: "utf8" }).trim();
      const dfLines = dfRaw.split("\n");
      const parts = dfLines[dfLines.length - 1].split(/\s+/);
      const total = parseInt(parts[1]), used = parseInt(parts[2]), available = parseInt(parts[3]);
      let episodesSize = 0;
      if (fs.existsSync(EPISODES_DIR)) episodesSize = calcDirSize(EPISODES_DIR);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, disk: { total, used, available, percentUsed: Math.round((used / total) * 100), totalGb: (total/1024/1024/1024).toFixed(1), usedGb: (used/1024/1024/1024).toFixed(1), availableGb: (available/1024/1024/1024).toFixed(1) }, episodesSize, episodesSizeGb: (episodesSize/1024/1024/1024).toFixed(1) }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return true;
  }

  return false;
};
