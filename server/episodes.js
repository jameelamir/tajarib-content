/**
 * Episode scanning — builds episode status list for the dashboard.
 * Also: transcription config management.
 */
const fs = require("fs");
const path = require("path");

module.exports = function init(ctx) {
  const { WORKSPACE_DIR, EPISODES_DIR, loadJSON, loadMeta, saveJSON } = ctx;
  const TRANSCRIPTION_CONFIG_FILE = path.join(WORKSPACE_DIR, "transcription-config.json");

  function getTranscriptionConfig() {
    const localConfig = loadJSON(TRANSCRIPTION_CONFIG_FILE);
    const mainAgentConfig = loadJSON("/root/.openclaw/agents/main/agent/models.json");
    const apiKey = mainAgentConfig?.providers?.haimaker?.apiKey;
    return {
      apiKey: apiKey || localConfig?.apiKey || null,
      groqApiKey: localConfig?.groqApiKey || null,
      defaultMethod: localConfig?.defaultMethod || "local",
      localModel: localConfig?.localModel || "large-v3"
    };
  }

  function saveTranscriptionConfig(config) {
    const existing = loadJSON(TRANSCRIPTION_CONFIG_FILE) || {};
    if (config.defaultMethod) existing.defaultMethod = config.defaultMethod;
    if (config.localModel !== undefined) existing.localModel = config.localModel;
    if (config.groqApiKey !== undefined) existing.groqApiKey = config.groqApiKey || null;
    saveJSON(TRANSCRIPTION_CONFIG_FILE, existing);
  }

  function getEpisodes() {
    if (!fs.existsSync(EPISODES_DIR)) return [];

    return fs.readdirSync(EPISODES_DIR)
      .filter(f => fs.statSync(path.join(EPISODES_DIR, f)).isDirectory())
      .map(slug => {
        const dir = path.join(EPISODES_DIR, slug);
        const meta = loadMeta(slug);
        const files = fs.readdirSync(dir);
        const rawVideo = files.find(f => /\.(mp4|mkv|mov|avi|mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && !f.includes("reel") && !f.includes("final"));

        const transcript = fs.existsSync(path.join(dir, "transcript.json"));
        const analysis = fs.existsSync(path.join(dir, "analysis.json"));
        const content = loadJSON(path.join(dir, "content.json"));

        const reelsDir = path.join(dir, "reels");
        const reelFiles = fs.existsSync(reelsDir) ? fs.readdirSync(reelsDir) : [];
        const reelCount = reelFiles.filter(f => /^reel-\d+\.mp4$/.test(f)).length;

        let finalCount = reelFiles.filter(f => f.endsWith("-subtitled.mp4")).length;
        if (fs.existsSync(path.join(dir, "full-subtitled.mp4"))) finalCount += 1;

        const mediaType = meta.mediaType || "episode";
        let videoSize = null;
        if (rawVideo) { try { videoSize = fs.statSync(path.join(dir, rawVideo)).size; } catch (e) {} }

        const hasOverlay = fs.existsSync(path.join(dir, "full-final.mp4")) || reelFiles.some(f => f.endsWith("-final.mp4"));
        const hasComposed = fs.existsSync(path.join(dir, "composed.mp4"));
        const hasCropped = reelFiles.some(f => f.includes("-cropped") && f.endsWith(".mp4"));

        // Per-reel status
        const reelStatuses = [];
        const hiddenReels = new Set(meta.hiddenReels || []);
        const fileReelIds = reelFiles.filter(f => /^reel-\d+\.mp4$/.test(f)).sort().map(f => f.match(/reel-(\d+)\.mp4/)[1]);
        const validCutIds = new Set(fileReelIds.filter(id => {
          try { return fs.statSync(path.join(reelsDir, `reel-${id}.mp4`)).size > 0; } catch { return false; }
        }));
        const analysisData = loadJSON(path.join(dir, "analysis.json"));
        const contentData = loadJSON(path.join(dir, "content.json"));
        const generatedReelIds = new Set((contentData?.reels || []).filter(r => r.caption).map(r => String(r.id).padStart(2, "0")));
        const analysisReelIds = (analysisData?.reels || []).map(r => String(r.id).padStart(2, "0"));
        const allReelIds = [...new Set([...fileReelIds, ...analysisReelIds])].sort();
        for (const id of allReelIds) {
          const reelInfo = analysisData?.reels?.find(r => String(r.id).padStart(2, "0") === id) || {};
          reelStatuses.push({
            id, cut: validCutIds.has(id), generated: generatedReelIds.has(id),
            cropped: reelFiles.includes(`reel-${id}-cropped.mp4`),
            subtitled: reelFiles.includes(`reel-${id}-subtitled.mp4`),
            final: reelFiles.includes(`reel-${id}-final.mp4`),
            hidden: hiddenReels.has(id),
            hook: reelInfo.hook || reelInfo.title || "",
            duration: reelInfo.duration || null, start: reelInfo.start || null, end: reelInfo.end || null,
            cuts: reelInfo.cuts || []
          });
        }

        const clipsAnalysis = loadJSON(path.join(dir, "clips-analysis.json"));

        return {
          slug, mediaType, rawVideo, videoSize,
          guest: meta.guest || "", role: meta.role || "",
          multiTrack: meta.multiTrack || false,
          steps: {
            transcribed: transcript, analyzed: analysis, reelsSelected: true,
            generated: !!content, cut: reelCount > 0, subtitled: finalCount > 0,
            overlaid: hasOverlay, composed: hasComposed, cropped: hasCropped,
            clipsAnalyzed: !!clipsAnalysis, published: meta.published || false
          },
          reelStatuses, clipsAnalysis, content,
          counts: { reels: reelCount, final: finalCount },
          cropRatio: meta.cropRatio || null
        };
      })
      .sort((a, b) => {
        const ma = loadMeta(a.slug).createdAt || "";
        const mb = loadMeta(b.slug).createdAt || "";
        return mb.localeCompare(ma);
      });
  }

  return { getEpisodes, getTranscriptionConfig, saveTranscriptionConfig, TRANSCRIPTION_CONFIG_FILE };
};
