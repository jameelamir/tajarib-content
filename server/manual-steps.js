/**
 * Manual paths for LLM-based pipeline steps. Invoked when the user picks
 * "Fill in manually" from the hybrid-mode choice modal — we skip the LLM call
 * and write empty placeholders so the existing edit UIs let the user fill in
 * the result by hand.
 */
const fs = require("fs");
const path = require("path");

module.exports = function init(ctx) {
  const { io, EPISODES_DIR, loadJSON, saveJSON, loadMeta } = ctx;

  // Generate step (manual): create empty caption / YouTube / announcement
  // placeholders for every reel from analysis.json. The reel-ui caption
  // textarea + content edit fields then surface as "fill me in yourself".
  function manualGenerate(slug, { reelOnly = false, reelId = null, youtubeOnly = false } = {}) {
    const dir = path.join(EPISODES_DIR, slug);
    const outputPath = path.join(dir, "content.json");
    const meta = loadMeta(slug);
    const guest = meta.guest || "";
    const role = meta.role || "";

    if (reelOnly) {
      const existing = fs.existsSync(outputPath) ? loadJSON(outputPath) : null;
      const output = existing || {
        slug, generated_at: new Date().toISOString(),
        guest, role, reel_only: true,
        manual: true,
        reels: [{ id: "reel-01", reel_text: "", caption: "" }],
      };
      output.manual = true;
      output.generated_at = new Date().toISOString();
      saveJSON(outputPath, output);
      io.emit("log", { slug, text: "✍️  Manual mode — empty caption placeholder created. Type your caption in the editor.\n" });
      io.emit("status-update", {});
      return outputPath;
    }

    const analysis = loadJSON(path.join(dir, "analysis.json"));
    if (!analysis) {
      io.emit("log", { slug, text: "❌ Manual generate: no analysis.json found. Run analyze first.\n" });
      io.emit("toast", { type: "error", message: "Run analyze before generate" });
      throw new Error("analysis.json not found");
    }

    const existing = fs.existsSync(outputPath) ? loadJSON(outputPath) : null;
    const existingReels = existing?.reels || [];
    let reelsSource = analysis.reels || [];

    // Per-reel manual fill: only replace the targeted reel, keep the rest
    if (reelId) {
      const targetId = parseInt(reelId, 10);
      reelsSource = reelsSource.filter(r => r.id === targetId);
    }

    const placeholders = reelsSource.map(reel => {
      const prior = existingReels.find(r => r.id === reel.id);
      return {
        id: reel.id,
        start: reel.start,
        end: reel.end,
        hook: reel.hook,
        reel_text: prior?.reel_text || "",
        caption: prior?.caption || "",
      };
    });

    let mergedReels = placeholders;
    if (reelId) {
      // Merge: replace the targeted reel, keep others as-is
      mergedReels = existingReels.slice();
      placeholders.forEach(p => {
        const idx = mergedReels.findIndex(r => r.id === p.id);
        if (idx >= 0) mergedReels[idx] = p; else mergedReels.push(p);
      });
    }

    const output = existing || { slug, guest, role };
    output.slug = slug;
    output.guest = guest;
    output.role = role;
    output.generated_at = new Date().toISOString();
    output.manual = true;
    if (!youtubeOnly) output.reels = mergedReels;

    // YouTube-only: leave reels alone, ensure youtube placeholders exist
    // Full mode: also seed empty youtube fields
    if (youtubeOnly || !reelId) {
      output.youtube_description = output.youtube_description || "";
      output.announcement = output.announcement || "";
      output.video_titles = output.video_titles || [];
    }

    saveJSON(outputPath, output);

    const what = youtubeOnly
      ? "YouTube description + announcement"
      : reelId
        ? `reel ${reelId} caption`
        : `${mergedReels.length} caption(s) + YouTube + announcement`;
    io.emit("log", { slug, text: `✍️  Manual mode — empty ${what} placeholder(s) created. Fill them in via the edit fields.\n` });
    io.emit("status-update", {});
    return outputPath;
  }

  // Analyze step (manual): write a minimal analysis.json so the pipeline
  // marker shows as done. Reels remain empty — user adds them via the
  // existing reel-add UI before the rest of the pipeline can proceed.
  function manualAnalyze(slug) {
    const dir = path.join(EPISODES_DIR, slug);
    const outputPath = path.join(dir, "analysis.json");
    const transcriptPath = path.join(dir, "transcript.json");

    let durationMinutes = 0;
    try {
      const t = loadJSON(transcriptPath);
      const lastSeg = t?.segments?.[t.segments.length - 1];
      if (lastSeg?.end) durationMinutes = Math.round(lastSeg.end / 60);
    } catch (_) {}

    const existing = fs.existsSync(outputPath) ? loadJSON(outputPath) : null;
    const output = existing || {};
    output.duration_minutes = output.duration_minutes || durationMinutes;
    output.cuts = output.cuts || [];
    output.reels = output.reels || [];
    output.chapters = output.chapters || [];
    output.general_notes = output.general_notes || "";
    output.manual = true;
    output.analyzed_at = new Date().toISOString();

    saveJSON(outputPath, output);
    io.emit("log", { slug, text: "✍️  Manual analyze — empty reel/chapter list saved. Use \"Find & Create Reel\" on the transcript to add reels before cut/generate.\n" });
    io.emit("toast", { type: "info", message: "Analyze skipped — add reels via Find & Create" });
    io.emit("status-update", {});
    return outputPath;
  }

  return { manualGenerate, manualAnalyze };
};
