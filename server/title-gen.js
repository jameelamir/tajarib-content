/**
 * AI title generation, episode renaming, and post-transcription hook.
 */
const fs = require("fs");
const path = require("path");

module.exports = function init(ctx) {
  const { io, EPISODES_DIR, loadJSON, loadMeta, saveMeta, callClaude, activeProcesses, logs, prompts } = ctx;

  async function generateTitleFromTranscript(transcriptText, guest, role, slug = "") {
    const snippet = transcriptText.substring(0, 4000);
    const guestInfo = guest ? `Guest: ${guest}${role ? ' (' + role + ')' : ''}` : '';
    const systemPrompt = prompts.load("slug-system");
    const prompt = prompts.load("slug-user", {
      guestInfo: guestInfo ? guestInfo + '\n' : '',
      snippet,
    });
    const result = await callClaude(systemPrompt, prompt, 100, { slug, step: "generate-title", expectedFormat: "text" });
    return result.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || "untitled-episode";
  }

  function deduplicateSlug(baseSlug) {
    if (!fs.existsSync(path.join(EPISODES_DIR, baseSlug))) return baseSlug;
    let version = 2;
    while (fs.existsSync(path.join(EPISODES_DIR, `${baseSlug}-v${version}`))) version++;
    return `${baseSlug}-v${version}`;
  }

  function renameEpisode(oldSlug, newSlug) {
    const oldDir = path.join(EPISODES_DIR, oldSlug);
    const newDir = path.join(EPISODES_DIR, newSlug);
    if (!fs.existsSync(oldDir)) throw new Error(`Episode ${oldSlug} not found`);
    if (fs.existsSync(newDir)) throw new Error(`Episode ${newSlug} already exists`);

    const meta = loadMeta(oldSlug);
    if (meta.rawVideo) meta.rawVideo = meta.rawVideo.replace(oldSlug, newSlug);
    fs.renameSync(oldDir, newDir);
    saveMeta(newSlug, meta);

    if (logs[oldSlug]) { logs[newSlug] = logs[oldSlug]; delete logs[oldSlug]; }
    for (const [key, proc] of Object.entries(activeProcesses)) {
      if (key === oldSlug || key.startsWith(oldSlug + ':')) {
        const newKey = key === oldSlug ? newSlug : newSlug + key.slice(oldSlug.length);
        activeProcesses[newKey] = proc; delete activeProcesses[key];
      }
    }
    return newSlug;
  }

  async function handlePostTranscription(slug) {
    const meta = loadMeta(slug);
    if (!meta.pendingAiTitle) return slug;

    try {
      const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
      if (!fs.existsSync(transcriptPath)) return slug;
      const transcript = loadJSON(transcriptPath);
      const fullText = transcript.full_text || transcript.segments?.map(s => s.text).join(' ') || '';
      if (!fullText) return slug;

      io.emit("log", { slug, text: "\n🤖 Generating AI title from transcript...\n" });
      const aiSlug = await generateTitleFromTranscript(fullText, meta.guest, meta.role, slug);
      const finalSlug = deduplicateSlug(aiSlug);

      io.emit("log", { slug, text: `📝 AI suggested: ${aiSlug}${finalSlug !== aiSlug ? ` → ${finalSlug} (deduplicated)` : ''}\n` });
      const newSlug = renameEpisode(slug, finalSlug);

      const newMeta = loadMeta(newSlug);
      delete newMeta.pendingAiTitle;
      saveMeta(newSlug, newMeta);

      io.emit("log", { slug: newSlug, text: `✅ Episode renamed: ${slug} → ${newSlug}\n` });
      io.emit("episode-renamed", { oldSlug: slug, newSlug });
      io.emit("status-update", {});
      io.emit("toast", { type: "success", message: `AI titled: ${newSlug}` });
      return newSlug;
    } catch (err) {
      console.error(`[AI Title] Error for ${slug}:`, err.message);
      io.emit("log", { slug, text: `\n⚠️ AI title generation failed: ${err.message}. Keeping current name.\n` });
      const meta2 = loadMeta(slug);
      delete meta2.pendingAiTitle;
      saveMeta(slug, meta2);
      return slug;
    }
  }

  return { generateTitleFromTranscript, deduplicateSlug, renameEpisode, handlePostTranscription };
};
