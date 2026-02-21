/**
 * scrape-instagram.js
 * Scrapes all posts from @tajaribpodcast: link + caption
 * Uses saved cookies from login.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_FILE = path.join(__dirname, 'cookies', 'instagram.json');
const PROFILE_URL = 'https://www.instagram.com/tajaribpodcast/';
const OUTPUT_FILE = path.join(__dirname, 'instagram_data.json');

async function scrapeInstagram() {
  console.log('[Instagram] Starting scrape...');
  const saved = JSON.parse(fs.readFileSync(COOKIES_FILE));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });
  await context.addCookies(saved.cookies);

  const page = await context.newPage();
  await page.goto(PROFILE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Dismiss any popups
  const dismiss = page.locator('[aria-label="Close"], button:has-text("Not now"), button:has-text("Cancel")');
  if (await dismiss.count() > 0) {
    await dismiss.first().click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Scroll to load all posts
  console.log('[Instagram] Scrolling to load all posts...');
  let prevCount = 0;
  let noChangeRounds = 0;
  while (noChangeRounds < 5) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(2500);
    const count = await page.evaluate(() =>
      document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"]').length
    );
    console.log(`[Instagram] Found ${count} posts so far...`);
    if (count === prevCount) noChangeRounds++;
    else noChangeRounds = 0;
    prevCount = count;
  }

  // Collect all post links
  const postLinks = await page.evaluate(() => {
    const anchors = document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"]');
    const seen = new Set();
    const links = [];
    for (const a of anchors) {
      const href = a.getAttribute('href');
      if (!seen.has(href)) {
        seen.add(href);
        links.push('https://www.instagram.com' + href);
      }
    }
    return links;
  });

  console.log(`[Instagram] Total posts found: ${postLinks.length}. Fetching captions...`);

  const results = [];
  for (let i = 0; i < postLinks.length; i++) {
    const url = postLinks[i];
    console.log(`[Instagram] (${i + 1}/${postLinks.length}) ${url}`);
    try {
      const pPage = await context.newPage();
      await pPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await pPage.waitForTimeout(2000);

      const caption = await pPage.evaluate(() => {
        // Try multiple selectors for caption
        const selectors = [
          'div._a9zs span',
          'h1._aacl',
          'div[class*="Caption"] span',
          'article div ul li:first-child span',
          'div._a9zs',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText && el.innerText.trim().length > 0) {
            return el.innerText.trim();
          }
        }
        // Fallback: get all text inside the post article
        const article = document.querySelector('article');
        return article ? article.querySelector('ul li:first-child')?.innerText?.trim() || '' : '';
      });

      results.push({ url, caption });
      await pPage.close();
    } catch (e) {
      console.warn(`[Instagram] Failed to get caption for ${url}: ${e.message}`);
      results.push({ url, caption: '' });
    }

    // Throttle to avoid triggering rate limits
    await page.waitForTimeout(1500);
  }

  await browser.close();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`[Instagram] Done. Saved ${results.length} posts to instagram_data.json`);
  return results;
}

module.exports = { scrapeInstagram };

if (require.main === module) {
  scrapeInstagram().catch(console.error);
}
