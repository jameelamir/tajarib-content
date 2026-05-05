/**
 * LLM wrappers — callClaude, model revision, hybrid step choice.
 *
 * Manual paths route through the existing paste-from-your-own-Claude flow
 * (llm.chat → null → llm-prompt socket event → user pastes response).
 *
 * For in-process callers (this file), pass `forceManual: true` to opts.
 * For child-process callers (analyze.js, generate.js, compose.js), the parent
 * spawns with TAJARIB_FORCE_MANUAL=1 in env — see server/pipeline.js.
 */
module.exports = function init(ctx) {
  const { io, pendingManualLLM, pendingModeChoices, llm, prompts } = ctx;

  // Hybrid mode: ask the user once per LLM step whether to use AI or fill manually.
  // Returns 'ai' | 'manual'.
  // - auto mode → 'ai' (run via API)
  // - manual mode → 'ai' (the CLI / callClaude will fall through to the existing
  //   paste-from-your-own-Claude flow, since llm.chat() returns null when mode='manual')
  // - hybrid mode → prompt the user to pick
  async function askLlmModeChoice({ slug = "", step = "llm", description = "" } = {}) {
    const cfg = llm.getConfig();
    if (cfg.mode !== "hybrid") return "ai";
    const requestId = "choice-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingModeChoices.delete(requestId);
        reject(new Error("Mode choice timed out (5 minutes) — defaulting to manual"));
      }, 5 * 60 * 1000);
      pendingModeChoices.set(requestId, {
        resolve: (choice) => { clearTimeout(timeout); resolve(choice === "manual" ? "manual" : "ai"); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });
      io.emit("llm-step-choice", { requestId, slug, step, description });
    });
  }

  async function callClaude(systemPrompt, userMessage, maxTokens = 4096, manualOpts = {}) {
    const result = await llm.chat({
      system: systemPrompt,
      user: userMessage,
      maxTokens,
      forceManual: !!manualOpts.forceManual,
    });
    if (!result) {
      const requestId = 'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingManualLLM.delete(requestId);
          reject(new Error("Manual LLM response timed out (10 minutes)"));
        }, 10 * 60 * 1000);
        pendingManualLLM.set(requestId, {
          resolve: (text) => { clearTimeout(timeout); resolve(text); },
          reject: (err) => { clearTimeout(timeout); reject(err); }
        });
        io.emit("llm-prompt", {
          requestId,
          slug: manualOpts.slug || '',
          step: manualOpts.step || 'dashboard',
          system: systemPrompt,
          user: userMessage,
          expectedFormat: manualOpts.expectedFormat || 'text',
        });
      });
    }

    if (!result.text && result.reasoning) {
      throw new Error("The AI model spent all its capacity on internal reasoning and produced no output. Try again — this is intermittent with reasoning models.");
    }
    if (!result.text) {
      throw new Error("The AI returned an empty response. Please try again.");
    }
    return result.text;
  }

  function hasApiKey() {
    return llm.hasKey();
  }

  async function callModelForRevision(originalContent, feedback, transcriptText = null, slug = "", forceManual = false) {
    let transcriptSection = '';
    if (transcriptText) {
      transcriptSection = `\n\n---FULL TRANSCRIPT (for context on what was actually said)---\n${transcriptText.substring(0, 8000)}${transcriptText.length > 8000 ? '...' : ''}\n---END TRANSCRIPT---`;
    }
    const systemPrompt = prompts.load("revision-system");
    const prompt = prompts.load("revision-user", { originalContent, transcriptSection, feedback });
    return callClaude(systemPrompt, prompt, 4096, { slug, step: "feedback", expectedFormat: "text", forceManual });
  }

  return { callClaude, hasApiKey, callModelForRevision, askLlmModeChoice };
};
