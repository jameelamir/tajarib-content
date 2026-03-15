/**
 * Centralized prompt loader — reads prompt templates from prompts/*.md
 * and substitutes {{variable}} placeholders.
 */

const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = path.join(__dirname, "prompts");

/**
 * Load a prompt template and substitute variables.
 * @param {string} name  — filename without extension (e.g. "analyze-system")
 * @param {Object} [vars] — key/value pairs to replace {{key}} with value
 * @returns {string}
 */
function load(name, vars = {}) {
  const filePath = path.join(PROMPTS_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompt not found: ${name} (${filePath})`);
  }
  let text = fs.readFileSync(filePath, "utf8").trim();
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, String(value ?? ""));
  }
  return text;
}

module.exports = { load, PROMPTS_DIR };
