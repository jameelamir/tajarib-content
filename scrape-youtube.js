/**
 * scrape-youtube.js
 * Scrapes all videos from @tajaribpodcast: title, url, description
 * No login required — public channel.
 * Usage: node scrape-youtube.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHANNEL_URL = 'https://www.youtube.com/@tajaribpodcast/videos';
const OUTPUT_FILE = path.join(__dirname, 'youtube_data.json');

async function scrapeYouTube() {
  console.log('[YouTube] Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });

  const page = await context.newPage();
  console.log('[YouTube] Loading channel page...');
  await page.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  // Accept cookie consent if present
  const acceptBtn = page.locator('button:has-text("Accept all"), button[aria-label*="Accept"]');
  if (await acceptBtn.count() > 0) {
    console.log('[YouTube] Accepting cookie consent...');
    await acceptBtn.first().click();
    await page.waitForTimeout(3000);
  }

  // Scroll to bottom to load all videos
  console.log('[YouTube] Scrolling to load all videos...');
  let prevCount = 0;
  let stableRounds = 0;
  while (stableRounds < 5) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(2000);
    const count = await page.evaluate(() =>
      document.querySelectorAll('ytd-rich-item-renderer').length
    );
    process.stdout.write(`\r[YouTube] Videos loaded: ${count}   `);
    if (count === prevCount) stableRounds++;
    else { stableRounds = 0; prevCount = count; }
  }
  console.log(`\n[YouTube] Total: ${prevCount} videos found.`);

  // Extract video links + titles from channel page
  const videoList = await page.evaluate(() => {
    const items = document.querySelectorAll('ytd-rich-item-renderer a#video-title-link');
    const seen = new Set();
    return Array.from(items)
      .map(a => {
        const href = (a.getAttribute('href') || '').split('&')[0];
        const url = href.startsWith('http') ? href : 'https://www.youtube.com' + href;
        return { title: (a.getAttribute('title') || a.textContent || '').trim(), url };
      })
      .filter(v => {
        if (!v.url.includes('/watch?v=') || seen.has(v.url)) return false;
        seen.add(v.url);
        return true;
      });
  });

  console.log(`[YouTube] Fetching descriptions for ${videoList.length} videos...`);

  const results = [];
  for (let i = 0; i < videoList.length; i++) {
    const { title, url } = videoList[i];
    process.stdout.write(`\r[YouTube] (${i + 1}/${videoList.length}) ${title.slice(0, 55)}...   `);

    try {
      const vPage = await context.newPage();
      await vPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await vPage.waitForTimeout(2500);

      // Expand description if collapsed
      const expandBtn = vPage.locator('tp-yt-paper-button#expand, #expand');
      if (await expandBtn.count() > 0) {
        await expandBtn.first().click().catch(() => {});
        await vPage.waitForTimeout(600);
      }

      const description = await vPage.evaluate(() => {
        const selectors = [
          '#description-inline-expander .yt-core-attributed-string',
          '#description .yt-core-attributed-string',
          '#description-text',
          'ytd-text-inline-expander #content',
          '#description'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el?.innerText?.trim()) return el.innerText.trim();
        }
        return '';
      });

      results.push({ title, url, description });
      await vPage.close();
    } catch (e) {
      console.warn(`\n[YouTube] Failed ${url}: ${e.message}`);
      results.push({ title, url, description: '' });
    }

    await page.waitForTimeout(400);
  }

  await browser.close();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`\n[YouTube] Done. ${results.length} videos saved to youtube_data.json`);
  return results;
}

module.exports = { scrapeYouTube };
if (require.main === module) scrapeYouTube().catch(e => { console.error(e); process.exit(1); });
