/**
 * LLM wrappers — callClaude, model revision, manual LLM mode, hybrid step choice.
 */
class ManualSkip extends Error {
  constructor(step) { super(`Manual skip: ${step}`); this.code = "MANUAL_SKIP"; this.step = step; }
}

module.exports = function init(ctx) {
  const { io, pendingManualLLM, pendingModeChoices, pendingTitleInputs, llm, prompts } = ctx;

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

  // Hybrid + manual title: prompt the user to type the title themselves.
  // Returns the typed string.
  async function askManualTitle({ slug = "", currentSlug = "" } = {}) {
    const requestId = "title-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingTitleInputs.delete(requestId);
        reject(new Error("Manual title input timed out (10 minutes)"));
      }, 10 * 60 * 1000);
      pendingTitleInputs.set(requestId, {
        resolve: (text) => { clearTimeout(timeout); resolve(text || ""); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });
      io.emit("llm-title-input", { requestId, slug, currentSlug });
    });
  }

  async function callClaude(systemPrompt, userMessage, maxTokens = 4096, manualOpts = {}) {
    const result = await llm.chat({ system: systemPrompt, user: userMessage, maxTokens });
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

  async function callModelForRevision(originalContent, feedback, transcriptText = null, slug = "") {
    let transcriptSection = '';
    if (transcriptText) {
      transcriptSection = `\n\n---FULL TRANSCRIPT (for context on what was actually said)---\n${transcriptText.substring(0, 8000)}${transcriptText.length > 8000 ? '...' : ''}\n---END TRANSCRIPT---`;
    }
    const systemPrompt = prompts.load("revision-system");
    const prompt = prompts.load("revision-user", { originalContent, transcriptSection, feedback });
    return callClaude(systemPrompt, prompt, 4096, { slug, step: "feedback", expectedFormat: "text" });
  }

  return { callClaude, hasApiKey, callModelForRevision, askLlmModeChoice, askManualTitle, ManualSkip };
};

module.exports.ManualSkip = ManualSkip;
