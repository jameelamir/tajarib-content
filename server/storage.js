/**
 * Storage config, file categorization, and disk usage helpers.
 */
const fs = require("fs");
const path = require("path");

module.exports = function init(ctx) {
  const { WORKSPACE_DIR, BUFFER_CONFIG_FILE, loadJSON, saveJSON } = ctx;
  const STORAGE_CONFIG_FILE = path.join(WORKSPACE_DIR, "storage-config.json");

  function getStorageConfig() {
    return loadJSON(STORAGE_CONFIG_FILE) || { quotaGB: 100 };
  }

  function saveStorageConfig(config) {
    saveJSON(STORAGE_CONFIG_FILE, config);
  }

  function categorizeFile(filename) {
    const f = filename.toLowerCase();
    if (f.endsWith('.json') || f.endsWith('.txt') || f.endsWith('.srt') || f.endsWith('.vtt') || f.endsWith('.ass') || f.endsWith('.md'))
      return 'json';
    if (f.includes('-final.') || f === 'full-final.mp4')
      return 'final';
    if (f.includes('-subtitled.') || f === 'full-subtitled.mp4')
      return 'subtitled';
    if (f.includes('reel-') || f.includes('-cropped.'))
      return 'reels';
    if (/^(raw|speaker|guest|composed)\./i.test(f) || (/\.(mp4|mkv|mov|avi|mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && !f.includes('reel')))
      return 'raw';
    return 'other';
  }

  function calcDirSize(dir) {
    let total = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        const s = fs.statSync(fp);
        if (s.isDirectory()) total += calcDirSize(fp);
        else total += s.size;
      }
    } catch (_) {}
    return total;
  }

  function getBufferConfig() {
    return loadJSON(BUFFER_CONFIG_FILE) || { accessToken: null, enabled: false };
  }

  function saveBufferConfig(config) {
    saveJSON(BUFFER_CONFIG_FILE, config);
  }

  return { STORAGE_CONFIG_FILE, getStorageConfig, saveStorageConfig, categorizeFile, calcDirSize, getBufferConfig, saveBufferConfig };
};
