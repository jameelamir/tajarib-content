/**
 * Reel routes — save caption, trim, add, hide, delete reels.
 */
const fs = require("fs");
const path = require("path");
const { toSeconds } = require("../../utils");
const { remapChunksForCuts, closeSubtitleGaps } = require("../../subtitle");

module.exports = async function reelRoutes(req, res, url, ctx) {
  const { io, EPISODES_DIR, UPLOADS_DIR, loadJSON, saveJSON, loadMeta, saveMeta, readBody, parseSrt, formidable } = ctx;

  if (req.method === "POST" && url.pathname === "/api/save-reel-caption") {
    const body = await readBody(req);
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
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
    } catch (err) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/save-reel-trim") {
    const body = await readBody(req);
    try {
      const { slug, reelId, start, end, cuts } = JSON.parse(body);
      if (!slug || !reelId) throw new Error("slug + reelId required");
      if (!start || !end) throw new Error("start + end required");
      const analysisPath = path.join(EPISODES_DIR, slug, "analysis.json");
      const analysis = loadJSON(analysisPath);
      if (!analysis || !analysis.reels) throw new Error("No analysis.json found");
      const padded = String(reelId).padStart(2, "0");
      const reel = analysis.reels.find(r => String(r.id).padStart(2, "0") === padded);
      if (!reel) throw new Error("Reel not found in analysis");

      // Capture old state before updating (needed to remap proofread chunks)
      const oldStart = toSeconds(reel.start);
      const oldEnd = toSeconds(reel.end);
      const oldCuts = (reel.cuts || []).map(c => ({ from: toSeconds(c.from), to: toSeconds(c.to) }));

      reel.start = start; reel.end = end;
      reel.cuts = Array.isArray(cuts) ? cuts.filter(c => c.from && c.to) : [];
      saveJSON(analysisPath, analysis);

      const reelsDir = path.join(EPISODES_DIR, slug, "reels");

      // Remap proofread subtitle chunks to match new video timeline
      const newStartSec = toSeconds(start);
      const newEndSec = toSeconds(end);
      const newCutsSec = reel.cuts.map(c => ({ from: toSeconds(c.from), to: toSeconds(c.to) }));
      const chunksFile = path.join(reelsDir, `reel-${padded}-chunks.json`);
      const chunksStateFile = path.join(reelsDir, `reel-${padded}-chunks-state.json`);
      try {
        if (fs.existsSync(chunksFile)) {
          const oldChunks = JSON.parse(fs.readFileSync(chunksFile, "utf8"));
          if (oldChunks.length) {
            const remapped = remapChunksForCuts(oldChunks, oldStart, oldEnd, oldCuts, newStartSec, newEndSec, newCutsSec);
            if (remapped.length > 0) {
              closeSubtitleGaps(remapped);
              fs.writeFileSync(chunksFile, JSON.stringify(remapped, null, 2));
              // Track the reel state chunks are synced to
              const validCuts = newCutsSec.filter(c => c.from > newStartSec && c.to < newEndSec && c.to > c.from);
              fs.writeFileSync(chunksStateFile, JSON.stringify({ start: newStartSec, end: newEndSec, cuts: validCuts }));
            } else {
              // All chunks fell inside cuts / outside bounds — remove file so subs regenerate
              fs.unlinkSync(chunksFile);
              try { fs.unlinkSync(chunksStateFile); } catch (_) {}
            }
          }
        }
      } catch (_) {}

      try {
        if (fs.existsSync(reelsDir)) {
          const stale = fs.readdirSync(reelsDir).filter(f => f.startsWith(`reel-${padded}`) && f.endsWith('.mp4'));
          for (const f of stale) fs.unlinkSync(path.join(reelsDir, f));
        }
      } catch (_) {}
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
      io.emit("status-update", {});
    } catch (err) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/upload-reel-srt") {
    const form = formidable({ uploadDir: UPLOADS_DIR, keepExtensions: true, maxFileSize: 10 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      const cleanup = () => { try { const f = files?.srt?.[0] || files?.srt; if (f?.filepath && fs.existsSync(f.filepath)) fs.unlinkSync(f.filepath); } catch (_) {} };
      if (err) { cleanup(); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); return; }
      try {
        const field = (v) => { const x = Array.isArray(v) ? v[0] : v; return x != null ? String(x) : ""; };
        const slug = field(fields.slug);
        const reelId = field(fields.reelId);
        const srtFile = files.srt?.[0] || files.srt;
        if (!slug) throw new Error("slug required");
        if (!srtFile) throw new Error("No SRT file provided");

        const epDir = path.join(EPISODES_DIR, slug);
        if (!fs.existsSync(epDir)) throw new Error("Episode not found");

        const srtContent = fs.readFileSync(srtFile.filepath, "utf-8");
        const parsed = parseSrt(srtContent);
        if (!parsed.segments.length) throw new Error("SRT contains no subtitle blocks — check file format");
        const chunks = parsed.segments.map(s => ({ start: s.start, end: s.end, text: s.text }));

        if (reelId) {
          // Per-reel inside an episode
          const padded = String(reelId).padStart(2, "0");
          const analysisPath = path.join(epDir, "analysis.json");
          const analysis = loadJSON(analysisPath);
          if (!analysis || !analysis.reels) throw new Error("No analysis.json found");
          const reel = analysis.reels.find(r => String(r.id).padStart(2, "0") === padded);
          if (!reel) throw new Error("Reel not found in analysis");

          const reelsDir = path.join(epDir, "reels");
          fs.mkdirSync(reelsDir, { recursive: true });
          const chunksFile = path.join(reelsDir, `reel-${padded}-chunks.json`);
          const chunksStateFile = path.join(reelsDir, `reel-${padded}-chunks-state.json`);
          fs.writeFileSync(chunksFile, JSON.stringify(chunks, null, 2));

          const startSec = toSeconds(reel.start);
          const endSec = toSeconds(reel.end);
          const cuts = (reel.cuts || [])
            .map(c => ({ from: toSeconds(c.from), to: toSeconds(c.to) }))
            .filter(c => c.from > startSec && c.to < endSec && c.to > c.from);
          fs.writeFileSync(chunksStateFile, JSON.stringify({ start: startSec, end: endSec, cuts }));

          const clipTranscriptPath = path.join(reelsDir, `reel-${padded}-transcript.json`);
          try { if (fs.existsSync(clipTranscriptPath)) fs.unlinkSync(clipTranscriptPath); } catch (_) {}

          try {
            const subFile = path.join(reelsDir, `reel-${padded}-subtitled.mp4`);
            const finalFile = path.join(reelsDir, `reel-${padded}-final.mp4`);
            if (fs.existsSync(subFile)) fs.unlinkSync(subFile);
            if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
          } catch (_) {}

          io.emit("log", { slug, text: `\n📄 SRT uploaded for reel ${padded} — ${chunks.length} chunks (re-run Sub to burn)\n` });
        } else {
          // Standalone reel-upload — chunks live as full-chunks.json in the episode dir
          fs.writeFileSync(path.join(epDir, "full-chunks.json"), JSON.stringify(chunks, null, 2));
          try {
            const subFile = path.join(epDir, "full-subtitled.mp4");
            const finalFile = path.join(epDir, "full-final.mp4");
            if (fs.existsSync(subFile)) fs.unlinkSync(subFile);
            if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
          } catch (_) {}

          io.emit("log", { slug, text: `\n📄 SRT uploaded — ${chunks.length} chunks (re-run Sub to burn)\n` });
        }

        cleanup();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, chunkCount: chunks.length }));
        io.emit("status-update", {});
      } catch (e) {
        cleanup();
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/add-reel") {
    const body = await readBody(req);
    try {
      const { slug, start, end, hook } = JSON.parse(body);
      if (!slug) throw new Error("slug required");
      if (!start || !end) throw new Error("start + end required");
      const analysisPath = path.join(EPISODES_DIR, slug, "analysis.json");
      let analysis = loadJSON(analysisPath);
      if (!analysis) analysis = { reels: [] };
      if (!analysis.reels) analysis.reels = [];
      const maxId = analysis.reels.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
      const newId = maxId + 1;
      analysis.reels.push({ id: newId, start, end, hook: hook || "" });
      saveJSON(analysisPath, analysis);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, reelId: String(newId).padStart(2, "0") }));
      io.emit("status-update", {});
    } catch (err) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/toggle-reel-step") {
    const body = await readBody(req);
    try {
      const { slug, reelId, step, enabled } = JSON.parse(body);
      if (!slug || !reelId) throw new Error("slug + reelId required");
      if (step !== "subs" && step !== "overlay") throw new Error("step must be 'subs' or 'overlay'");
      const analysisPath = path.join(EPISODES_DIR, slug, "analysis.json");
      const analysis = loadJSON(analysisPath);
      if (!analysis || !analysis.reels) throw new Error("No analysis.json found");
      const padded = String(reelId).padStart(2, "0");
      const reel = analysis.reels.find(r => String(r.id).padStart(2, "0") === padded);
      if (!reel) throw new Error("Reel not found in analysis");
      const field = step === "subs" ? "subsEnabled" : "overlayEnabled";
      const previous = reel[field] !== false;
      reel[field] = !!enabled;
      saveJSON(analysisPath, analysis);
      // Invalidate final.mp4 so Finalize re-renders with the new flag
      let invalidated = false;
      if (previous !== reel[field]) {
        const finalFile = path.join(EPISODES_DIR, slug, "reels", `reel-${padded}-final.mp4`);
        try { if (fs.existsSync(finalFile)) { fs.unlinkSync(finalFile); invalidated = true; } } catch (_) {}
      }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, invalidated }));
      io.emit("status-update", {});
    } catch (err) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/done-reel") {
    const body = await readBody(req);
    try {
      const { slug, reelId } = JSON.parse(body);
      if (!slug || !reelId) throw new Error("slug + reelId required");
      const meta = loadMeta(slug);
      const doneReels = new Set(meta.doneReels || []);
      const wasDone = doneReels.has(reelId);
      if (wasDone) doneReels.delete(reelId); else doneReels.add(reelId);
      saveMeta(slug, { doneReels: [...doneReels] });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, done: !wasDone }));
      io.emit("status-update", {});
    } catch (err) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/hide-reel") {
    const body = await readBody(req);
    try {
      const { slug, reelId } = JSON.parse(body);
      if (!slug || !reelId) throw new Error("slug + reelId required");
      const meta = loadMeta(slug);
      const hiddenReels = new Set(meta.hiddenReels || []);
      const wasHidden = hiddenReels.has(reelId);
      if (wasHidden) hiddenReels.delete(reelId); else hiddenReels.add(reelId);
      saveMeta(slug, { hiddenReels: [...hiddenReels] });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, hidden: !wasHidden }));
      io.emit("status-update", {});
    } catch (err) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/delete-reel") {
    const body = await readBody(req);
    try {
      const { slug, reelId } = JSON.parse(body);
      if (!slug || !reelId) throw new Error("slug + reelId required");
      const reelsDir = path.join(EPISODES_DIR, slug, "reels");
      const padded = String(reelId).padStart(2, "0");
      if (fs.existsSync(reelsDir)) {
        const files = fs.readdirSync(reelsDir).filter(f => f.startsWith(`reel-${padded}`));
        for (const f of files) fs.unlinkSync(path.join(reelsDir, f));
      }
      const analysisPath = path.join(EPISODES_DIR, slug, "analysis.json");
      if (fs.existsSync(analysisPath)) {
        const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
        if (analysis.reels) { analysis.reels = analysis.reels.filter(r => String(r.id).padStart(2, "0") !== padded); saveJSON(analysisPath, analysis); }
      }
      const meta = loadMeta(slug);
      if (meta.hiddenReels) saveMeta(slug, { hiddenReels: meta.hiddenReels.filter(id => id !== reelId) });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
      io.emit("status-update", {});
    } catch (err) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  return false;
};
