/**
 * Episode context — optional per-episode summary that gets injected into
 * reel caption generation so the LLM sees the broader episode arc, not just
 * the clip's transcript. Stored on meta.json as `episodeContext`.
 */
const fs = require("fs");
const path = require("path");

module.exports = function init(ctx) {
  const { EPISODES_DIR, loadJSON, loadMeta, saveMeta, callClaude, prompts } = ctx;

  const MAX_TRANSCRIPT_CHARS = 30000;

  async function generateEpisodeContextFromTranscript(transcriptText, guest, role, slug = "", forceManual = false) {
    const transcript = (transcriptText || "").slice(0, MAX_TRANSCRIPT_CHARS);
    const systemPrompt = prompts.load("episode-context-system");
    const userPrompt = prompts.load("episode-context-user", {
      guest: guest || "",
      role: role || "",
      transcript,
    });
    const result = await callClaude(systemPrompt, userPrompt, 1500, {
      slug, step: "episode-context", expectedFormat: "text", forceManual,
    });
    return (result || "").trim();
  }

  function loadTranscriptText(slug) {
    const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
    if (!fs.existsSync(transcriptPath)) return null;
    const t = loadJSON(transcriptPath);
    if (!t) return null;
    return t.full_text || (t.segments || []).map(s => s.text).join(" ") || null;
  }

  return { generateEpisodeContextFromTranscript, loadTranscriptText };
};
