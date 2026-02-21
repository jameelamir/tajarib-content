/**
 * run.js — Tajarib scrape runner
 * Runs: YouTube scrape → Google Sheets update (if config present)
 * Called by sub-agent. Logs progress to run-state.json
 */

const { scrapeYouTube } = require('./scrape-youtube');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'run-state.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

(async () => {
  const startTime = Date.now();
  const state = { startedAt: new Date().toISOString(), youtube: null, sheets: null, error: null };
  saveState(state);

  try {
    // 1. YouTube
    console.log('--- YouTube scrape ---');
    await scrapeYouTube();
    state.youtube = { status: 'ok', completedAt: new Date().toISOString() };
    saveState(state);

    // 2. Google Sheets (only if configured)
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE));
      const saPath = path.resolve(__dirname, config.serviceAccountPath);
      const hasRealConfig =
        config.spreadsheetId &&
        config.spreadsheetId !== 'REPLACE_WITH_YOUR_GOOGLE_SHEET_ID' &&
        fs.existsSync(saPath);

      if (hasRealConfig) {
        console.log('--- Google Sheets update ---');
        const { updateSheets } = require('./update-sheets');
        await updateSheets();
        state.sheets = { status: 'ok', completedAt: new Date().toISOString() };
        saveState(state);
      } else {
        console.log('[Sheets] Skipping — config not set up yet.');
        state.sheets = { status: 'skipped' };
        saveState(state);
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\nDone in ${elapsed}s`);
    state.durationSeconds = elapsed;
    saveState(state);

  } catch (err) {
    console.error('Run failed:', err.message);
    state.error = err.message;
    saveState(state);
    process.exit(1);
  }
})();
