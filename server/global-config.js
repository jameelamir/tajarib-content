/**
 * Global config paths — shared across all workspaces.
 * Stored in ~/.tajarib/ so API keys and settings persist.
 */
const os = require("os");
const path = require("path");
const fs = require("fs");

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".tajarib");

// Ensure directory exists on first require
if (!fs.existsSync(GLOBAL_CONFIG_DIR)) {
  fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
}

const GLOBAL_TRANSCRIPTION_CONFIG = path.join(GLOBAL_CONFIG_DIR, "transcription-config.json");
const GLOBAL_AUTH_PATH = path.join(GLOBAL_CONFIG_DIR, "auth.json");

/**
 * Migrate a workspace-local config to global if global doesn't exist yet.
 */
function migrateIfNeeded(localPath, globalPath) {
  if (!fs.existsSync(globalPath) && fs.existsSync(localPath)) {
    try {
      fs.copyFileSync(localPath, globalPath);
    } catch (_) {}
  }
}

module.exports = { GLOBAL_CONFIG_DIR, GLOBAL_TRANSCRIPTION_CONFIG, GLOBAL_AUTH_PATH, migrateIfNeeded };
