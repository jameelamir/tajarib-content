/**
 * update-sheets.js
 * Pushes YouTube and Instagram data to a Google Sheet
 * Requires: config.json with { spreadsheetId, serviceAccountPath }
 *           service account JSON file with Sheets + Drive access
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const YT_FILE = path.join(__dirname, 'youtube_data.json');
const IG_FILE = path.join(__dirname, 'instagram_data.json');

async function getAuth(serviceAccountPath) {
  const credentials = JSON.parse(fs.readFileSync(serviceAccountPath));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
  });
  return auth;
}

async function ensureSheet(sheets, spreadsheetId, sheetTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === sheetTitle);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetTitle } } }]
      }
    });
    console.log(`[Sheets] Created tab: ${sheetTitle}`);
  }
}

async function updateSheet(sheets, spreadsheetId, sheetTitle, rows) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetTitle}!A1:Z10000`
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows }
  });
  console.log(`[Sheets] Updated ${sheetTitle}: ${rows.length - 1} rows`);
}

async function updateSheets() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE));
  const { spreadsheetId, serviceAccountPath } = config;

  const auth = await getAuth(serviceAccountPath);
  const sheets = google.sheets({ version: 'v4', auth });

  // --- YouTube Tab ---
  if (fs.existsSync(YT_FILE)) {
    const ytData = JSON.parse(fs.readFileSync(YT_FILE));
    await ensureSheet(sheets, spreadsheetId, 'YouTube');
    const ytRows = [
      ['Title', 'URL', 'Description'],
      ...ytData.map(v => [v.title, v.url, v.description])
    ];
    await updateSheet(sheets, spreadsheetId, 'YouTube', ytRows);
  }

  // --- Instagram Tab ---
  if (fs.existsSync(IG_FILE)) {
    const igData = JSON.parse(fs.readFileSync(IG_FILE));
    await ensureSheet(sheets, spreadsheetId, 'Instagram');
    const igRows = [
      ['URL', 'Caption'],
      ...igData.map(p => [p.url, p.caption])
    ];
    await updateSheet(sheets, spreadsheetId, 'Instagram', igRows);
  }

  console.log('[Sheets] All done ✅');
}

module.exports = { updateSheets };

if (require.main === module) {
  updateSheets().catch(console.error);
}
