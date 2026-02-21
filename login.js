/**
 * login.js — Interactive login for YouTube and Instagram
 * Run once: node login.js
 * It opens a real browser window. Log in manually, then press Enter.
 * Cookies are saved to cookies/ for use by scrape.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const COOKIES_DIR = path.join(__dirname, 'cookies');

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--start-maximized']
  });

  const context = await browser.newContext({ viewport: null });

  // --- YouTube ---
  console.log('\n🔴 Opening YouTube...');
  const ytPage = await context.newPage();
  await ytPage.goto('https://accounts.google.com/signin');
  await waitForEnter('\n✅ Log in to YouTube/Google, then press ENTER here...');

  const ytCookies = await context.cookies(['https://youtube.com', 'https://google.com', 'https://accounts.google.com']);
  const ytStorage = await ytPage.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
  fs.writeFileSync(path.join(COOKIES_DIR, 'youtube.json'), JSON.stringify({ cookies: ytCookies, localStorage: ytStorage }, null, 2));
  console.log('💾 YouTube cookies saved.');
  await ytPage.close();

  // --- Instagram ---
  console.log('\n📸 Opening Instagram...');
  const igPage = await context.newPage();
  await igPage.goto('https://www.instagram.com/accounts/login/');
  await waitForEnter('\n✅ Log in to Instagram, then press ENTER here...');

  const igCookies = await context.cookies(['https://instagram.com', 'https://www.instagram.com']);
  const igStorage = await igPage.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
  fs.writeFileSync(path.join(COOKIES_DIR, 'instagram.json'), JSON.stringify({ cookies: igCookies, localStorage: igStorage }, null, 2));
  console.log('💾 Instagram cookies saved.');

  await browser.close();
  console.log('\n✅ All done! Run: node run.js');
})();
