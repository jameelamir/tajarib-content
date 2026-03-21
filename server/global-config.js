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
 * Migrate workspace-local config into global. If global doesn't exist, copy it.
 * If global exists, merge any non-null values from local (local wins for API keys).
 */
function migrateIfNeeded(localPath, globalPath) {
  if (!fs.existsSync(localPath)) return;
  try {
    const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
    if (!fs.existsSync(globalPath)) {
      fs.writeFileSync(globalPath, JSON.stringify(local, null, 2));
      return;
    }
    // Merge: local non-null values fill in missing/null global values
    const global = JSON.parse(fs.readFileSync(globalPath, "utf8"));
    let changed = false;
    for (const [k, v] of Object.entries(local)) {
      if (v != null && (global[k] == null || global[k] === "")) {
        global[k] = v;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(globalPath, JSON.stringify(global, null, 2));
  } catch (_) {}
}

module.exports = { GLOBAL_CONFIG_DIR, GLOBAL_TRANSCRIPTION_CONFIG, GLOBAL_AUTH_PATH, migrateIfNeeded };
