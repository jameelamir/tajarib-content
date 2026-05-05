/**
 * Media routes — video serving (with range requests), reel versions, thumbnails, assets, overlay config.
 */
const fs = require("fs");
const path = require("path");
const { ensureLowQuality } = require("../low-quality");

module.exports = async function mediaRoutes(req, res, url, ctx) {
  const { io, WORKSPACE_DIR, EPISODES_DIR, UPLOADS_DIR, loadJSON, loadMeta, readBody, formidable, getStorageConfig } = ctx;
  const ASSETS_DIR = path.join(WORKSPACE_DIR, "assets");
  const SHARED_ASSETS_DIR = path.join(path.resolve(WORKSPACE_DIR, ".."), "assets");
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  if (req.method === "GET" && url.pathname === "/api/reel-versions") {
    const slug = url.searchParams.get("slug");
    if (!slug) { res.writeHead(400); res.end("Missing slug"); return true; }
    const reelsDir = path.join(EPISODES_DIR, slug, "reels");
    if (!fs.existsSync(reelsDir)) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ reels: [] })); return true; }
    const files = fs.readdirSync(reelsDir);
    const reelIdSet = new Set();
    files.forEach(f => { const m = f.match(/^reel-(\d+)/); if (m) reelIdSet.add(m[1]); });
    const reels = [...reelIdSet].sort().map(id => {
      const cutFile = path.join(reelsDir, `reel-${id}.mp4`);
      const hasCut = files.includes(`reel-${id}.mp4`) && (() => { try { return fs.statSync(cutFile).size > 0; } catch { return false; } })();
      const hasCropped = files.includes(`reel-${id}-cropped.mp4`);
      const hasSubtitled = files.includes(`reel-${id}-subtitled.mp4`);
      const serving = hasCut ? (hasCropped ? "cropped" : hasSubtitled ? "subtitled" : "cut") : (hasCropped ? "cropped_orphan" : null);
      return { id, hasCut, hasCropped, hasSubtitled, serving };
    });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ reels }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/video") {
    const slug = url.searchParams.get("slug"), type = url.searchParams.get("type"), reelParam = url.searchParams.get("reel"), stage = url.searchParams.get("stage");
    if (!slug) { res.writeHead(400); res.end("Missing slug"); return true; }
    const dir = path.join(EPISODES_DIR, slug);
    let videoPath;
    if (reelParam) {
      const isValid = (p) => fs.existsSync(p) && fs.statSync(p).size > 10240;
      const reelsDir = path.join(dir, "reels");
      const subs = url.searchParams.get("subs");
      if (subs === 'off') {
        // Subtitles hidden — skip final and subtitled, serve cropped > raw
        videoPath = isValid(path.join(reelsDir, `reel-${reelParam}-cropped.mp4`)) ? path.join(reelsDir, `reel-${reelParam}-cropped.mp4`) :
          path.join(reelsDir, `reel-${reelParam}.mp4`);
      } else if (stage === 'pre-overlay') {
        // Skip final video — serve subtitled > cropped > raw (for overlay preview background)
        videoPath = isValid(path.join(reelsDir, `reel-${reelParam}-subtitled.mp4`)) ? path.join(reelsDir, `reel-${reelParam}-subtitled.mp4`) :
          isValid(path.join(reelsDir, `reel-${reelParam}-cropped.mp4`)) ? path.join(reelsDir, `reel-${reelParam}-cropped.mp4`) :
          path.join(reelsDir, `reel-${reelParam}.mp4`);
      } else {
        videoPath = isValid(path.join(reelsDir, `reel-${reelParam}-final.mp4`)) ? path.join(reelsDir, `reel-${reelParam}-final.mp4`) :
          isValid(path.join(reelsDir, `reel-${reelParam}-subtitled.mp4`)) ? path.join(reelsDir, `reel-${reelParam}-subtitled.mp4`) :
          isValid(path.join(reelsDir, `reel-${reelParam}-cropped.mp4`)) ? path.join(reelsDir, `reel-${reelParam}-cropped.mp4`) :
          path.join(reelsDir, `reel-${reelParam}.mp4`);
      }
    } else if (type === 'compressed') { videoPath = path.join(dir, "publish-compressed.mp4"); }
    else if (type === 'final') {
      const fullFinal = path.join(dir, "full-final.mp4");
      if (fs.existsSync(fullFinal)) videoPath = fullFinal;
      else {
        const reelsDir = path.join(dir, "reels");
        if (fs.existsSync(reelsDir)) { const f = fs.readdirSync(reelsDir).find(f => f.endsWith("-final.mp4")); videoPath = f ? path.join(reelsDir, f) : fullFinal; }
        else videoPath = fullFinal;
      }
    } else if (type === 'subtitled') {
      const fullSub = path.join(dir, "full-subtitled.mp4");
      if (fs.existsSync(fullSub)) videoPath = fullSub;
      else {
        const reelsDir = path.join(dir, "reels");
        if (fs.existsSync(reelsDir)) { const f = fs.readdirSync(reelsDir).find(f => f.includes("subtitled") && f.endsWith(".mp4")); videoPath = f ? path.join(reelsDir, f) : path.join(reelsDir, "reel-001-subtitled.mp4"); }
        else videoPath = path.join(dir, "reels", "reel-001-subtitled.mp4");
      }
    } else {
      const files = fs.readdirSync(dir);
      const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi|mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && !f.includes("reel") && !f.includes("final"));
      videoPath = path.join(dir, rawVideo || "raw.mp4");
    }
    if (!fs.existsSync(videoPath)) { res.writeHead(404); res.end("Video not found"); return true; }
    // Low-quality preview: swap in cached low version if ready, else kick off
    // background transcode and serve the original (no blocking).
    let servedQuality = "full";
    if (url.searchParams.get("q") === "low" && url.searchParams.get("download") !== "1") {
      const lowPath = ensureLowQuality(videoPath);
      if (lowPath) { videoPath = lowPath; servedQuality = "low"; }
      else { servedQuality = "preparing"; }
    }
    const stat = fs.statSync(videoPath);
    if (stat.size === 0) { res.writeHead(204); res.end(); return true; }
    const wantDownload = url.searchParams.get("download") === "1";
    const safeName = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const downloadName = reelParam ? `${safeName(slug)}-reel-${safeName(reelParam)}.mp4` : `${safeName(slug)}.mp4`;
    const dispositionHeader = wantDownload ? { "Content-Disposition": `attachment; filename="${downloadName}"` } : {};
    const qualityHeader = { "X-Video-Quality": servedQuality };
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10), end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Type": "video/mp4", "Cache-Control": "no-store", ...qualityHeader, ...dispositionHeader });
      fs.createReadStream(videoPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": "video/mp4", "Cache-Control": "no-store", ...qualityHeader, ...dispositionHeader });
      fs.createReadStream(videoPath).pipe(res);
    }
    return true;
  }

  const thumbMatch = url.pathname.match(/^\/api\/reel-thumbnail\/(.+?)\/(.+)$/);
  if (req.method === "GET" && thumbMatch) {
    const slug = decodeURIComponent(thumbMatch[1]), reelId = thumbMatch[2];
    const dir = path.join(EPISODES_DIR, slug, "reels");
    const reelFile = path.join(dir, `reel-${reelId}.mp4`), thumbFile = path.join(dir, `reel-${reelId}-thumb.jpg`);
    if (!fs.existsSync(reelFile)) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Reel not found" })); return true; }
    if (!fs.existsSync(thumbFile) || fs.statSync(thumbFile).mtimeMs < fs.statSync(reelFile).mtimeMs) {
      try { const { execFileSync } = require("child_process"); execFileSync("ffmpeg", ["-y", "-i", reelFile, "-ss", "3", "-frames:v", "1", "-q:v", "4", thumbFile], { stdio: "pipe" }); }
      catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Thumbnail generation failed" })); return true; }
    }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" }); res.end(fs.readFileSync(thumbFile));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/assets") {
    const assets = {};
    for (const name of ["sponsor.mov", "logo.mov"]) {
      const p = path.join(ASSETS_DIR, name);
      if (fs.existsSync(p)) { const stat = fs.statSync(p); assets[name.replace(".mov", "")] = { file: name, size: stat.size, sizeMb: (stat.size / 1024 / 1024).toFixed(1) }; }
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(assets));
    return true;
  }

  // Browse all assets (local + shared dir) with optional type filter
  if (req.method === "GET" && url.pathname === "/api/assets/browse") {
    const typeFilter = url.searchParams.get("type");
    const videoExts = [".mov", ".mp4", ".avi", ".mkv"];
    const imageExts = [".png", ".jpg", ".jpeg", ".gif"];
    const overlayExts = [...videoExts, ...imageExts];
    function matchesType(ext) {
      if (!typeFilter) return overlayExts.includes(ext);
      if (typeFilter === "video") return videoExts.includes(ext);
      if (typeFilter === "image") return imageExts.includes(ext);
      return overlayExts.includes(ext);
    }
    function scanDir(dirPath, source) {
      const results = [];
      if (!fs.existsSync(dirPath)) return results;
      try {
        for (const name of fs.readdirSync(dirPath)) {
          if (name.startsWith(".")) continue;
          const ext = path.extname(name).toLowerCase();
          if (!matchesType(ext)) continue;
          const fullPath = path.join(dirPath, name);
          try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;
            const isSymlink = fs.lstatSync(fullPath).isSymbolicLink();
            results.push({ name, source, path: fullPath, sizeMb: (stat.size / 1024 / 1024).toFixed(1), isSymlink, symlinkTarget: isSymlink ? fs.readlinkSync(fullPath) : null });
          } catch (_) {}
        }
      } catch (_) {}
      return results;
    }
    const files = scanDir(ASSETS_DIR, "local");
    const storageConf = getStorageConfig();
    const sharedDir = storageConf.sharedAssetsDir || (fs.existsSync(SHARED_ASSETS_DIR) ? SHARED_ASSETS_DIR : null);
    if (sharedDir && fs.existsSync(sharedDir)) {
      const sharedFiles = scanDir(sharedDir, "shared");
      const localTargets = new Set(files.filter(f => f.isSymlink && f.symlinkTarget).map(f => f.symlinkTarget));
      const localNames = new Set(files.map(f => f.name));
      for (const sf of sharedFiles) { if (!localTargets.has(sf.path) && !localNames.has(sf.name)) files.push(sf); }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files, sharedAssetsDir: sharedDir }));
    return true;
  }

  // Serve asset files for browser preview (images directly, first frame for videos)
  const assetFileMatch = url.pathname.match(/^\/api\/assets\/file\/(.+)$/);
  if (req.method === "GET" && assetFileMatch) {
    const fileName = decodeURIComponent(assetFileMatch[1]);
    if (fileName.includes("..") || fileName.includes("/")) { res.writeHead(400); res.end("Invalid filename"); return true; }
    let filePath = path.join(ASSETS_DIR, fileName);
    if (!fs.existsSync(filePath) && fs.existsSync(path.join(SHARED_ASSETS_DIR, fileName))) filePath = path.join(SHARED_ASSETS_DIR, fileName);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return true; }
    const ext = path.extname(fileName).toLowerCase();
    if ([".mov", ".mp4", ".avi", ".mkv"].includes(ext)) {
      // Use PNG to preserve alpha/transparency from .mov overlay files
      const thumbPath = path.join(ASSETS_DIR, `.thumb-${fileName}.png`);
      const oldJpgThumb = path.join(ASSETS_DIR, `.thumb-${fileName}.jpg`);
      if (fs.existsSync(oldJpgThumb)) try { fs.unlinkSync(oldJpgThumb); } catch (_) {} // clean up old JPEG thumbs
      const srcStat = fs.statSync(filePath);
      if (!fs.existsSync(thumbPath) || fs.statSync(thumbPath).mtimeMs < srcStat.mtimeMs) {
        try {
          const { execFileSync } = require("child_process");
          execFileSync("ffmpeg", ["-y", "-i", filePath, "-frames:v", "1", "-pix_fmt", "rgba", thumbPath], { stdio: "pipe" });
        } catch (_) { res.writeHead(500); res.end("Thumbnail failed"); return true; }
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=60" });
      res.end(fs.readFileSync(thumbPath));
      return true;
    }
    const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream", "Cache-Control": "public, max-age=60" });
    res.end(fs.readFileSync(filePath));
    return true;
  }

  // Serve overlay video files as WebM VP9 with alpha for browser live preview
  const assetVideoMatch = url.pathname.match(/^\/api\/assets\/video\/(.+)$/);
  if (req.method === "GET" && assetVideoMatch) {
    const fileName = decodeURIComponent(assetVideoMatch[1]);
    if (fileName.includes("..") || fileName.includes("/")) { res.writeHead(400); res.end("Invalid filename"); return true; }
    let filePath = path.join(ASSETS_DIR, fileName);
    if (!fs.existsSync(filePath) && fs.existsSync(path.join(SHARED_ASSETS_DIR, fileName))) filePath = path.join(SHARED_ASSETS_DIR, fileName);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return true; }
    const ext = path.extname(fileName).toLowerCase();
    const baseName = path.basename(fileName, ext);
    if ([".mov", ".mp4", ".avi"].includes(ext)) {
      // Transcode to WebM VP9 with alpha preservation for browser playback
      const webmPath = path.join(ASSETS_DIR, `.preview-${baseName}.webm`);
      const srcStat = fs.statSync(filePath);
      if (!fs.existsSync(webmPath) || fs.statSync(webmPath).mtimeMs < srcStat.mtimeMs) {
        try {
          const { execFileSync } = require("child_process");
          execFileSync("ffmpeg", ["-y", "-i", filePath, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "2M", "-auto-alt-ref", "0", "-an", webmPath], { stdio: "pipe", timeout: 60000 });
        } catch (e) { res.writeHead(500); res.end("Transcode failed: " + (e.stderr?.toString().split("\n").slice(-3).join(" ") || e.message)); return true; }
      }
      const stat = fs.statSync(webmPath);
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Type": "video/webm" });
        fs.createReadStream(webmPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { "Content-Type": "video/webm", "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=300" });
        fs.createReadStream(webmPath).pipe(res);
      }
      return true;
    }
    // For non-video files (PNG/JPG), serve directly
    const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(fs.readFileSync(filePath));
    return true;
  }

  // Link a file from shared assets dir into local assets/ via symlink
  if (req.method === "POST" && url.pathname === "/api/link-asset") {
    const body = await readBody(req);
    try {
      const { sourcePath, assetName } = JSON.parse(body);
      if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error("Source file not found");
      const destName = assetName || path.basename(sourcePath);
      const destPath = path.join(ASSETS_DIR, destName);
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      fs.symlinkSync(sourcePath, destPath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, file: destName, linkedTo: sourcePath }));
      io.emit("toast", { type: "success", message: `Linked asset: ${destName}` });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/upload-asset") {
    const form = formidable({ uploadDir: UPLOADS_DIR, keepExtensions: true, maxFileSize: 500 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
      try {
        const assetType = Array.isArray(fields.type) ? fields.type[0] : (fields.type || "");
        const file = files.file?.[0] || files.file;
        if (!assetType || !file) throw new Error("type and file required");
        if (!["sponsor", "logo", "cta", "lower-third"].includes(assetType)) throw new Error("type must be 'sponsor', 'logo', 'cta', or 'lower-third'");
        let destPath;
        if (assetType === "lower-third") {
          // Save lower-third files to shared assets dir with original filename
          fs.mkdirSync(SHARED_ASSETS_DIR, { recursive: true });
          const originalName = file.originalFilename || "lower-third.mov";
          destPath = path.join(SHARED_ASSETS_DIR, originalName);
        } else {
          // sponsor / logo / cta — preserve original filename so multiple coexist forever
          const defaults = { sponsor: "sponsor.mov", logo: "logo.mov", cta: "cta.png" };
          const originalName = file.originalFilename || defaults[assetType];
          destPath = path.join(ASSETS_DIR, originalName);
        }
        fs.renameSync(file.filepath, destPath);
        const sizeMb = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, file: path.basename(destPath), sizeMb }));
        io.emit("toast", { type: "success", message: `${assetType} overlay uploaded (${sizeMb} MB)` });
      } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: e.message })); }
    });
    return true;
  }

  const overlayConfigMatch = url.pathname.match(/^\/api\/overlay-config\/(.+)$/);
  if (overlayConfigMatch) {
    const slug = decodeURIComponent(overlayConfigMatch[1]);
    const dir = path.join(EPISODES_DIR, slug), configPath = path.join(dir, "overlay-config.json");
    const { GLOBAL_CONFIG_DIR } = require("../global-config");
    const globalDefaultPath = path.join(GLOBAL_CONFIG_DIR, "overlay-config.json");
    const seedDefaultPath = path.join(WORKSPACE_DIR, "overlay-config.json");
    if (req.method === "GET") {
      const defaults = { sponsor: { enabled: true, x: 1.3, y: 1.2, scale: 180 }, logo: { enabled: true, x: 92.3, y: 1.2, scale: 140 }, lowerThird: { enabled: false, startTime: 2, endTime: 8 }, cta: { enabled: false, mode: "text", text: "www.tajarib.show", fontSize: 28, fontColor: "#ffffff", imagePath: "", x: 50, y: 85, scale: 200, startTime: 50, endTime: 58 } };
      // Fallback: episode-specific → persistent global default → in-repo seed → hardcoded defaults
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(loadJSON(configPath) || loadJSON(globalDefaultPath) || loadJSON(seedDefaultPath) || defaults));
      return true;
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      try {
        const config = JSON.parse(body);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        // Also write to persistent global default so new episodes inherit this config across rebuilds.
        fs.writeFileSync(globalDefaultPath, JSON.stringify(config, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
        io.emit("toast", { type: "success", message: "Overlay config saved" });
      } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: e.message })); }
      return true;
    }
  }

  return false;
};
