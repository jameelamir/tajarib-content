/**
 * Pipeline routes — run-step, replace SRT, LLM response/feedback, generate title.
 */
const fs = require("fs");
const path = require("path");

module.exports = async function pipelineRoutes(req, res, url, ctx) {
  const { io, WORKSPACE_DIR, EPISODES_DIR, NODE_BIN, loadJSON, saveJSON, loadMeta, saveMeta, parseSrt,
    callModelForRevision, generateTitleFromTranscript, deduplicateSlug, renameEpisode, handlePostTranscription,
    runStep, runReelsParallel, pendingManualLLM, readBody, formidable, UPLOADS_DIR } = ctx;

  if (req.method === "POST" && url.pathname === "/api/run-step") {
    const body = await readBody(req);
    try {
      const { slug, step, force, more, model, ratio, faceTrack, reelId, preferSide, burnOnly, subtitleStyle, noTranscribe } = JSON.parse(body);
      if (!slug || !step) throw new Error("slug + step required");
      const meta = loadMeta(slug);
      const mediaType = meta.mediaType || "episode";
      if (mediaType === "reel_full" && !['generate', 'transcribe'].includes(step)) throw new Error(`Step '${step}' not applicable for fully-produced reel.`);
      if (mediaType === "reel_cut" && step === "cut") throw new Error("Cut step not applicable — reel is already cut");
      if (mediaType === "reel_cut" && step === "analyze") throw new Error("Analyze step not applicable for pre-cut reels");
      if (step === "compose" && !meta.multiTrack) throw new Error("Compose step requires a multi-track episode");
      if (step === "generate" && (!meta.guest || !meta.role)) throw new Error("Guest name and role required for generation");
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
      if (step === "process-reels") runReelsParallel(slug, { ratio, faceTrack, subtitleStyle });
      else runStep({ slug, step, force, more, mediaType, guest: meta.guest, role: meta.role, model, ratio, faceTrack, reelId, preferSide, burnOnly, subtitleStyle, noTranscribe });
    } catch (err) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/replace-srt") {
    const form = ctx.formidable({ uploadDir: UPLOADS_DIR, keepExtensions: true, maxFileSize: 50 * 1024 * 1024 });
    form.parse(req, (err, fields, files) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
      const slug = Array.isArray(fields.slug) ? fields.slug[0] : fields.slug;
      const srtFile = files.srt?.[0] || files.srt;
      if (!slug || !srtFile) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing slug or srt file" })); return; }
      const epDir = path.join(EPISODES_DIR, slug);
      if (!fs.existsSync(epDir)) { res.writeHead(404); res.end(JSON.stringify({ error: "Episode not found" })); return; }
      try {
        const srtContent = fs.readFileSync(srtFile.filepath, "utf-8");
        const transcriptData = parseSrt(srtContent);
        transcriptData.slug = slug;
        const existing = path.join(epDir, "transcript.json");
        if (fs.existsSync(existing)) { const old = JSON.parse(fs.readFileSync(existing, "utf8")); transcriptData.source_file = old.source_file || ""; }
        saveJSON(existing, transcriptData);
        const srtExt = path.extname(srtFile.originalFilename || ".srt").toLowerCase();
        fs.copyFileSync(srtFile.filepath, path.join(epDir, `uploaded${srtExt}`)); fs.unlinkSync(srtFile.filepath);
        const analysisPath = path.join(epDir, "analysis.json"); if (fs.existsSync(analysisPath)) fs.unlinkSync(analysisPath);
        const clipsPath = path.join(epDir, "clips-analysis.json"); if (fs.existsSync(clipsPath)) fs.unlinkSync(clipsPath);
        io.emit("log", { slug, text: `📄 SRT replaced — ${transcriptData.segment_count} segments loaded. Re-analyze to update reels.\n` });
        io.emit("status-update", {}); io.emit("toast", { type: "success", message: "Transcript replaced — run Analyze next" });
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, segments: transcriptData.segment_count }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/llm-response") {
    const body = await readBody(req);
    try {
      const { slug, step, response: llmResponse, round, requestId } = JSON.parse(body);
      if (!llmResponse) throw new Error("response is required");
      if (requestId && pendingManualLLM.has(requestId)) {
        const pending = pendingManualLLM.get(requestId); pendingManualLLM.delete(requestId); pending.resolve(llmResponse);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true })); return true;
      }
      if (!slug || !step) throw new Error("slug and step required for pipeline resume");
      const epDir = path.join(EPISODES_DIR, slug);
      fs.writeFileSync(path.join(epDir, "llm-response.txt"), llmResponse, "utf8");
      io.emit("log", { slug, text: `\n📋 Manual LLM response received — resuming ${step}...\n` });
      const meta = loadMeta(slug);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true }));
      const actualStep = (step === "youtube" || step.startsWith("reel")) ? "generate" : step === "analyze-more" ? "analyze" : step;
      // When resuming a per-reel manual LLM response, scope to just that reel
      // so it doesn't cascade to the next reel and trigger another popup.
      // With --reel-id, there's only one LLM call, so resumeRound is always 0.
      let reelId = null;
      let youtubeOnly = false;
      let resumeRound = round || 0;
      if (step.startsWith("reel-")) {
        const id = step.replace("reel-", "");
        if (id && !isNaN(id)) { reelId = parseInt(id, 10); resumeRound = 0; }
      } else if (step === "youtube") {
        youtubeOnly = true;
        resumeRound = 0;
      }
      const more = step === "analyze-more";
      runStep({ slug, step: actualStep, force: true, more, mediaType: meta.mediaType || "episode", guest: meta.guest, role: meta.role, resume: true, resumeRound, reelId, youtubeOnly });
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/feedback") {
    const body = await readBody(req);
    try {
      const { slug, field, currentContent, feedback } = JSON.parse(body);
      if (!slug || !field || !currentContent || !feedback) throw new Error("slug, field, currentContent, feedback all required");
      let transcriptText = null;
      const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
      if (fs.existsSync(transcriptPath)) { try { const t = loadJSON(transcriptPath); transcriptText = t.full_text || t.segments?.map(s => s.text).join(' ') || null; } catch (_) {} }
      const revised = await callModelForRevision(currentContent, feedback, transcriptText, slug);
      if (!revised || !revised.trim()) throw new Error("AI returned empty revision. Please try again.");
      const contentPath = path.join(EPISODES_DIR, slug, "content.json");
      const content = loadJSON(contentPath);
      if (content) { const parts = field.split("."); let ref = content; for (let i = 0; i < parts.length - 1; i++) ref = ref[parts[i]]; ref[parts[parts.length - 1]] = revised; saveJSON(contentPath, content); }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, revised }));
      io.emit("toast", { type: "success", message: "Content revised by AI" });
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/generate-title") {
    const body = await readBody(req);
    try {
      const { slug } = JSON.parse(body);
      if (!slug) throw new Error("slug required");
      const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
      if (!fs.existsSync(transcriptPath)) throw new Error("No transcript found — transcribe first");
      const transcript = loadJSON(transcriptPath);
      const fullText = transcript.full_text || transcript.segments?.map(s => s.text).join(' ') || '';
      if (!fullText) throw new Error("Transcript is empty");
      const meta = loadMeta(slug);
      io.emit("log", { slug, text: "\n🤖 Generating AI title from transcript...\n" });
      const aiSlug = await generateTitleFromTranscript(fullText, meta.guest, meta.role, slug);
      const finalSlug = deduplicateSlug(aiSlug);
      io.emit("log", { slug, text: `📝 AI suggested: ${aiSlug}${finalSlug !== aiSlug ? ` → ${finalSlug} (deduplicated)` : ''}\n` });
      const newSlug = renameEpisode(slug, finalSlug);
      const newMeta = loadMeta(newSlug); delete newMeta.pendingAiTitle; saveMeta(newSlug, newMeta);
      io.emit("log", { slug: newSlug, text: `✅ Episode renamed: ${slug} → ${newSlug}\n` });
      io.emit("episode-renamed", { oldSlug: slug, newSlug }); io.emit("status-update", {}); io.emit("toast", { type: "success", message: `AI titled: ${newSlug}` });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, oldSlug: slug, newSlug }));
    } catch (err) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: err.message })); }
    return true;
  }

  return false;
};
