/**
 * Shared LLM client — supports OpenAI-compatible endpoints (Haimaker, LiteLLM, etc.)
 * and direct Anthropic API.
 *
 * Config is read from auth.json:
 *   { "llm": { "key": "...", "baseUrl": "https://api.haimaker.ai/v1", "model": "haimaker/auto" } }
 *
 * If baseUrl is set → OpenAI-compatible /chat/completions
 * If baseUrl is empty → direct Anthropic SDK (key must be sk-ant-...)
 *
 * Backwards compatible with old format: { "anthropic": { "key": "..." } }
 */

const fs = require("fs");
const path = require("path");

const AUTH_PATH = path.join(__dirname, "auth.json");

const DEFAULT_MODEL = "haimaker/auto";

// ─── Config ────────────────────────────────────────────────────────

function loadConfig() {
  // Priority 1: auth.json
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
    if (data.llm && data.llm.key) return data.llm;
    // Backwards compat: old { anthropic: { key } } format
    if (data.anthropic?.key) {
      return { key: data.anthropic.key, baseUrl: "", model: "" };
    }
    if (data.providers?.anthropic?.apiKey) {
      return { key: data.providers.anthropic.apiKey, baseUrl: "", model: "" };
    }
  } catch (_) {}

  // Priority 2: fallback auth paths (for OpenClaw environments)
  const fallbacks = [
    "/root/.openclaw/agents/main/agent/auth.json",
    "/root/.openclaw/agents/main/agent/models.json",
  ];
  for (const p of fallbacks) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const key = data?.anthropic?.key || data?.providers?.anthropic?.apiKey;
      if (key) return { key, baseUrl: "", model: "" };
    } catch (_) {}
  }

  return {};
}

function getConfig() {
  const config = loadConfig();
  return {
    key: process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || config.key || "",
    baseUrl: process.env.LLM_BASE_URL || config.baseUrl || "",
    model: config.model || DEFAULT_MODEL,
  };
}

function hasKey() {
  return !!getConfig().key;
}

// ─── Chat ──────────────────────────────────────────────────────────

/**
 * Send a chat completion request.
 * @param {Object} opts
 * @param {string} opts.system - System prompt
 * @param {string} opts.user   - User message
 * @param {number} [opts.maxTokens=4096]
 * @param {string} [opts.model] - Override model from config
 * @returns {Promise<{text: string, model: string, usage: {input: number, output: number, total: number}}|null>}
 *          Returns null if no API key is configured.
 */
async function chat({ system, user, maxTokens = 4096, model: modelOverride }) {
  const config = getConfig();
  const model = modelOverride || config.model || DEFAULT_MODEL;

  if (!config.key) return null; // No key — caller handles manual mode

  if (config.baseUrl) {
    // ── OpenAI-compatible endpoint ──
    const url = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.key}`,
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM API ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();

    // Extract text — try standard OpenAI format first, then fallbacks
    let text = "";
    let reasoning = "";
    const choice = data.choices?.[0];
    if (choice) {
      // Capture reasoning content from reasoning models (DeepSeek R1, etc.)
      if (typeof choice.message?.reasoning_content === "string") {
        reasoning = choice.message.reasoning_content.trim();
      }

      if (typeof choice.message?.content === "string") {
        text = choice.message.content.trim();
      } else if (Array.isArray(choice.message?.content)) {
        // Anthropic-style: content is [{type:"text", text:"..."}]
        const textBlock = choice.message.content.find(b => b.type === "text");
        text = (textBlock?.text || "").trim();
      } else if (typeof choice.text === "string") {
        // Older completions API format
        text = choice.text.trim();
      }
    }

    // Debug: log when text is empty (often caused by reasoning models exhausting token budget)
    if (!text && reasoning) {
      console.error("[llm.js] WARNING: content is null/empty but reasoning_content exists.");
      console.error("[llm.js] The reasoning model may have exhausted max_tokens on thinking.");
      console.error("[llm.js] Reasoning preview:", reasoning.slice(0, 200));
    } else if (!text) {
      console.error("[llm.js] WARNING: Empty text extracted from API response.");
      console.error("[llm.js] Response keys:", JSON.stringify(Object.keys(data)));
      if (data.choices?.length) {
        console.error("[llm.js] choices[0] keys:", JSON.stringify(Object.keys(data.choices[0])));
        console.error("[llm.js] choices[0].message:", JSON.stringify(data.choices[0].message)?.slice(0, 500));
      }
      console.error("[llm.js] usage:", JSON.stringify(data.usage));
    }

    return {
      text,
      reasoning,
      model: data.model || model,
      usage: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
        total: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0),
      },
    };
  } else {
    // ── Direct Anthropic SDK ──
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: config.key });
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    return {
      text: (response.content[0]?.text || "").trim(),
      model: response.model,
      usage: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0,
        total: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      },
    };
  }
}

module.exports = { getConfig, hasKey, chat, loadConfig, DEFAULT_MODEL };
