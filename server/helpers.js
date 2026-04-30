/**
 * Shared data utilities — JSON I/O, episode metadata, SRT parsing, guest history.
 */
const fs = require("fs");
const path = require("path");

module.exports = function init(ctx) {
  const { EPISODES_DIR, GUESTS_FILE, SHARED_GUESTS_FILE } = ctx;

  function loadJSON(p) {
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
  }

  function saveJSON(p, data) {
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  }

  function loadMeta(slug) {
    return loadJSON(path.join(EPISODES_DIR, slug, "meta.json")) || {};
  }

  function saveMeta(slug, data) {
    const p = path.join(EPISODES_DIR, slug, "meta.json");
    const existing = loadMeta(slug);
    saveJSON(p, { ...existing, ...data });
  }

  function parseSrt(srtContent) {
    const blocks = srtContent.trim().split(/\n\n+/);
    const segments = [];
    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 2) continue;
      let timeLine = -1;
      for (let i = 0; i < Math.min(lines.length, 2); i++) {
        if (lines[i].includes('-->')) { timeLine = i; break; }
      }
      if (timeLine < 0) continue;
      const timeMatch = lines[timeLine].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
      if (!timeMatch) continue;
      const start = +timeMatch[1]*3600 + +timeMatch[2]*60 + +timeMatch[3] + +timeMatch[4]/1000;
      const end = +timeMatch[5]*3600 + +timeMatch[6]*60 + +timeMatch[7] + +timeMatch[8]/1000;
      const text = lines.slice(timeLine + 1).join(' ').replace(/<[^>]*>/g, '').trim();
      if (text) segments.push({ id: segments.length, start, end, text });
    }
    const full_text = segments.map(s => s.text).join(' ');
    // Synthesize word-level timestamps by linearly distributing words within each segment.
    // This gives downstream code (cut, subtitles) fine-grained timing even for coarse SRTs.
    const words = [];
    for (const seg of segments) {
      const segWords = seg.text.split(/\s+/).filter(Boolean);
      if (!segWords.length) continue;
      const segDur = seg.end - seg.start;
      seg.words = [];
      for (let i = 0; i < segWords.length; i++) {
        const w = {
          word: segWords[i],
          start: +(seg.start + segDur * i / segWords.length).toFixed(3),
          end: +(seg.start + segDur * (i + 1) / segWords.length).toFixed(3),
          probability: 1.0,
        };
        seg.words.push(w);
        words.push(w);
      }
    }
    return {
      model: 'uploaded-srt',
      full_text,
      segments,
      words,
      segment_count: segments.length,
      word_count: words.length,
      duration_seconds: segments.length ? segments[segments.length - 1].end : 0,
    };
  }

  function getGuestHistory() {
    return loadJSON(GUESTS_FILE) || [];
  }

  function addGuestToHistory(guest, role) {
    const guests = getGuestHistory();
    const existing = guests.find(g => g.name === guest);
    if (!existing) {
      guests.push({ name: guest, role, used: 1, lastUsed: new Date().toISOString() });
    } else {
      existing.role = role || existing.role;
      existing.used++;
      existing.lastUsed = new Date().toISOString();
    }
    saveJSON(GUESTS_FILE, guests);
    if (SHARED_GUESTS_FILE) saveJSON(SHARED_GUESTS_FILE, guests);
  }

  /** Collect body from an incoming request (used by POST route handlers). */
  function readBody(req) {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => resolve(body));
    });
  }

  /**
   * Convert an arbitrary title into a safe directory/URL slug.
   * Preserves Unicode letters and digits (so Arabic, Cyrillic, etc. survive)
   * and collapses everything else into single dashes. Returns "" for input
   * that has no usable characters (caller decides the fallback, e.g. temp slug).
   */
  function slugify(input) {
    if (input == null) return "";
    return String(input)
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  }

  return { loadJSON, saveJSON, loadMeta, saveMeta, parseSrt, getGuestHistory, addGuestToHistory, readBody, slugify };
};
