/**
 * Shared utility functions used across CLI pipeline scripts.
 */

const fs = require("fs");
const path = require("path");

const SHARED_DIR = path.resolve(__dirname, "..");
const EPISODES_DIR = process.env.EPISODES_DIR
  ? process.env.EPISODES_DIR
  : (fs.existsSync(SHARED_DIR) && SHARED_DIR !== __dirname
      ? path.join(SHARED_DIR, "episodes")
      : path.join(__dirname, "episodes"));

/**
 * Parse a timestamp string (MM:SS or HH:MM:SS) into seconds.
 * Also handles plain numeric strings (treated as raw seconds).
 */
function toSeconds(ts) {
  if (!ts) return 0;
  const str = String(ts);
  const parts = str.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parseFloat(str) || 0;
}

/**
 * Format seconds as a zero-padded MM:SS string.
 */
function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * Load and parse a JSON file, returning null if it doesn't exist or is invalid.
 */
function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (_) { return null; }
}

/**
 * Write an object as pretty-printed JSON to a file.
 */
function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Load transcript.json for an episode, exiting on failure.
 */
function loadTranscript(slug) {
  const p = path.join(EPISODES_DIR, slug, "transcript.json");
  if (!fs.existsSync(p)) {
    console.error(`❌ No transcript found: ${p}`);
    console.error("   Run transcribe.py first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Compress transcript segments into timestamped paragraphs for LLM prompts.
 * Skips the first TEASER_SKIP_SECONDS since episode openings are compiled
 * teaser clips from different parts — not usable as standalone content.
 */
const TEASER_SKIP_SECONDS = 60;

function formatTranscriptForPrompt(transcript) {
  const PARAGRAPH_INTERVAL = 30;
  const paragraphs = [];
  let currentTexts = [];
  let paragraphStart = 0;

  for (const seg of transcript.segments) {
    if (seg.start < TEASER_SKIP_SECONDS) continue;
    if (currentTexts.length === 0) paragraphStart = seg.start;
    if (seg.start - paragraphStart >= PARAGRAPH_INTERVAL && currentTexts.length > 0) {
      paragraphs.push(`[${formatTimestamp(paragraphStart)}] ${currentTexts.join(" ")}`);
      currentTexts = [];
      paragraphStart = seg.start;
    }
    currentTexts.push(seg.text.trim());
  }
  if (currentTexts.length > 0) {
    paragraphs.push(`[${formatTimestamp(paragraphStart)}] ${currentTexts.join(" ")}`);
  }
  return paragraphs.join("\n\n");
}

/**
 * Normalize Eastern Arabic numerals (٠١٢٣٤٥٦٧٨٩) to Western (0123456789).
 */
function normalizeNumerals(text) {
  return text.replace(/[٠-٩]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 48));
}

/**
 * Fuzzy-match a text excerpt against transcript segments.
 * Returns the timestamp (in seconds) of the best-matching segment, or null.
 * Options:
 *   afterTime: skip segments before this timestamp (seconds)
 */
function findSegmentByText(segments, excerpt, opts) {
  if (!excerpt || !segments.length) return null;
  const afterTime = (opts && opts.afterTime) || 0;
  const needle = normalizeNumerals(excerpt.trim().replace(/\s+/g, " "));

  // Try sliding windows of 1-4 consecutive segments
  for (let winSize = 1; winSize <= Math.min(4, segments.length); winSize++) {
    for (let i = 0; i <= segments.length - winSize; i++) {
      if (segments[i].start < afterTime) continue;
      const combined = normalizeNumerals(segments.slice(i, i + winSize).map(s => s.text.trim()).join(" ").replace(/\s+/g, " "));
      if (combined.includes(needle)) return segments[i].start;
      if (needle.includes(combined) && winSize > 1) return segments[i].start;
    }
  }

  // Fallback: word overlap scoring
  const needleWords = needle.split(" ");
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start < afterTime) continue;
    const haystackWords = normalizeNumerals(segments[i].text.trim().replace(/\s+/g, " ")).split(" ");
    const overlap = needleWords.filter(w => haystackWords.includes(w)).length;
    const score = overlap / Math.max(needleWords.length, 1);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  return bestIdx >= 0 && bestScore > 0.3 ? segments[bestIdx].start : null;
}

/**
 * Like findSegmentByText but returns the END time of the matching segment
 * (or the last segment in a multi-segment window match).
 * Useful when resolving the end boundary of a "keep" section for trimming.
 */
function findSegmentEndByText(segments, excerpt, opts) {
  if (!excerpt || !segments.length) return null;
  const afterTime = (opts && opts.afterTime) || 0;
  const needle = normalizeNumerals(excerpt.trim().replace(/\s+/g, " "));

  for (let winSize = 1; winSize <= Math.min(4, segments.length); winSize++) {
    for (let i = 0; i <= segments.length - winSize; i++) {
      if (segments[i].start < afterTime) continue;
      const combined = normalizeNumerals(segments.slice(i, i + winSize).map(s => s.text.trim()).join(" ").replace(/\s+/g, " "));
      if (combined.includes(needle) || (needle.includes(combined) && winSize > 1)) {
        return segments[i + winSize - 1].end;
      }
    }
  }

  const needleWords = needle.split(" ");
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start < afterTime) continue;
    const haystackWords = normalizeNumerals(segments[i].text.trim().replace(/\s+/g, " ")).split(" ");
    const overlap = needleWords.filter(w => haystackWords.includes(w)).length;
    const score = overlap / Math.max(needleWords.length, 1);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  return bestIdx >= 0 && bestScore > 0.3 ? segments[bestIdx].end : null;
}

/**
 * Strip Arabic diacritics (tashkeel) so the same word transcribed with/without
 * vowel marks compares equal during alignment.
 */
function stripDiacritics(text) {
  return text.replace(/[ً-ٰٟۖ-ۭ]/g, "");
}

/**
 * Normalize a string for fuzzy text alignment: numerals, diacritics, common
 * Arabic letter variants (alef forms, ya/alef-maksura, ta-marbuta), whitespace,
 * and punctuation. Mirrors what callers compare against, not what they display.
 */
function normalizeForAlign(text) {
  if (!text) return "";
  let t = stripDiacritics(normalizeNumerals(String(text)));
  t = t.replace(/[إأآا]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي");
  t = t.replace(/[^\p{L}\p{N}\s]/gu, " ");
  return t.replace(/\s+/g, " ").trim().toLowerCase();
}

function tokenizeForAlign(text) {
  const norm = normalizeForAlign(text);
  return norm ? norm.split(" ") : [];
}

/**
 * Match tokens with tolerance for Arabic morphology — Whisper sometimes glues
 * prefixes/suffixes (و، ف، ل، ال، ب، ك، s) or pronoun clitics onto a stem, so
 * exact equality is too strict. Returns true on equal, prefix, or substring
 * containment when both tokens are 3+ chars.
 */
function tokensMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.startsWith(shorter)) return true;
  if (longer.endsWith(shorter)) return true;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  return false;
}

/**
 * Build a bag (multiset) of normalized tokens with length >= minLen.
 * Returns Map(token → count).
 */
function tokenBag(tokens, minLen) {
  const m = new Map();
  for (const t of tokens) {
    if (!t || t.length < minLen) continue;
    m.set(t, (m.get(t) || 0) + 1);
  }
  return m;
}

/**
 * Score how many tokens from `needleBag` appear in `haystackBag`, including
 * morphology-tolerant matches (prefix/suffix/substring) for tokens >= 4 chars.
 * Returns count of matched needle occurrences.
 */
function bagOverlap(needleBag, haystackBag) {
  let hits = 0;
  for (const [token, count] of needleBag.entries()) {
    let matchedInHay = 0;
    if (haystackBag.has(token)) {
      matchedInHay = haystackBag.get(token);
    } else if (token.length >= 4) {
      for (const [hayToken, hayCount] of haystackBag.entries()) {
        if (hayToken.length < 3) continue;
        if (hayToken.includes(token) || (token.length >= 4 && token.includes(hayToken) && hayToken.length >= 4)) {
          matchedInHay += hayCount;
        }
      }
    }
    hits += Math.min(count, matchedInHay);
  }
  return hits;
}

/**
 * Find the haystack-token range whose bag-of-words best matches the needle's
 * bag. Slides a window of size ~needleLen * 1.5 through the haystack.
 * Returns { fromIdx, toIdx, score, hits, contentTokenCount } or null.
 */
function findBestBagWindow(haystackTokens, needleTokens, opts) {
  const minLen = (opts && opts.minLen) || 3;
  const slack = (opts && opts.slack) || 1.5;
  const stride = (opts && opts.stride) || 1;
  const minScore = (opts && opts.minScore) || 0.25;

  const needleBag = tokenBag(needleTokens, minLen);
  const contentTokenCount = Array.from(needleBag.values()).reduce((a, b) => a + b, 0);
  if (contentTokenCount < 3) return null;

  const winSize = Math.max(needleTokens.length, Math.ceil(needleTokens.length * slack));
  let bestScore = 0, bestStart = -1, bestEnd = -1, bestHits = 0;

  for (let i = 0; i + 1 <= haystackTokens.length; i += stride) {
    const end = Math.min(i + winSize, haystackTokens.length);
    if (end - i < Math.ceil(needleTokens.length * 0.5)) break;
    const window = haystackTokens.slice(i, end);
    const hayBag = tokenBag(window, minLen);
    const hits = bagOverlap(needleBag, hayBag);
    const score = hits / contentTokenCount;
    if (score > bestScore) {
      bestScore = score; bestStart = i; bestEnd = end; bestHits = hits;
      if (score >= 0.95) break;
    }
  }

  if (bestScore < minScore || bestStart < 0) return null;
  return { fromIdx: bestStart, toIdx: bestEnd - 1, score: bestScore, hits: bestHits, contentTokenCount };
}

/**
 * Find the haystack position with the densest cluster of `targets` tokens.
 * Slides a small window of size `clusterSize` through [fromIdx..toIdx]; at
 * each position, counts unique target tokens that appear. Returns the
 * position of the FIRST target token in the best-scoring cluster, or -1.
 */
function findBestCluster(haystackTokens, fromIdx, toIdx, targets, opts) {
  const clusterSize = (opts && opts.clusterSize) || Math.max(8, targets.length + 4);
  const minHits = (opts && opts.minHits) || 2;
  let bestHits = 0, bestFirstHit = -1;

  for (let i = fromIdx; i <= toIdx; i++) {
    const end = Math.min(i + clusterSize, haystackTokens.length);
    const seen = new Set();
    let firstHit = -1;
    for (let p = i; p < end; p++) {
      for (let ti = 0; ti < targets.length; ti++) {
        if (seen.has(ti)) continue;
        if (tokensMatch(haystackTokens[p], targets[ti])) {
          seen.add(ti);
          if (firstHit < 0) firstHit = p;
          break;
        }
      }
    }
    if (seen.size > bestHits) {
      bestHits = seen.size;
      bestFirstHit = firstHit;
    }
  }
  return bestHits >= minHits ? bestFirstHit : -1;
}

function findBestClusterEnd(haystackTokens, fromIdx, toIdx, targets, opts) {
  const clusterSize = (opts && opts.clusterSize) || Math.max(8, targets.length + 4);
  const minHits = (opts && opts.minHits) || 2;
  let bestHits = 0, bestLastHit = -1;

  for (let i = fromIdx; i <= toIdx; i++) {
    const end = Math.min(i + clusterSize, haystackTokens.length);
    const seen = new Set();
    let lastHit = -1;
    for (let p = i; p < end; p++) {
      for (let ti = 0; ti < targets.length; ti++) {
        if (seen.has(ti)) continue;
        if (tokensMatch(haystackTokens[p], targets[ti])) {
          seen.add(ti);
          lastHit = p;
          break;
        }
      }
    }
    if (seen.size >= bestHits) {
      bestHits = seen.size;
      bestLastHit = lastHit;
    }
  }
  return bestHits >= minHits ? bestLastHit : -1;
}

/**
 * Align a reel's transcript text against the episode's word-level transcript.
 * Returns { startSec, endSec, confidence } or null if no confident match.
 *
 * Strategy: bag-of-words sliding window finds the haystack region with the
 * most overlap with the reel transcript, then we anchor on the FIRST few reel
 * content tokens (to set start) and LAST few (to set end) within that region.
 * Robust to Whisper transcription differences because we don't require exact
 * match on any single token.
 */
function alignReelTextToEpisode(reelText, episodeWords, opts) {
  if (!reelText || !episodeWords || !episodeWords.length) return null;
  const minScore = (opts && opts.minScore) || 0.3;
  const reelTokens = tokenizeForAlign(reelText);
  if (reelTokens.length < 3) return null;

  const haystackTokens = episodeWords.map(w => normalizeForAlign(w.word || w.text || ""));

  const window = findBestBagWindow(haystackTokens, reelTokens, { minScore, slack: 1.25 });
  if (!window) return null;

  const winLen = Math.max(1, window.toIdx - window.fromIdx);
  const headRegionEnd = Math.min(window.toIdx, window.fromIdx + Math.ceil(winLen * 0.25) + 5);
  const tailRegionStart = Math.max(window.fromIdx, window.toIdx - Math.ceil(winLen * 0.25) - 5);

  const anchorSize = Math.min(12, Math.max(5, Math.ceil(reelTokens.length * 0.12)));
  const headTargets = reelTokens.slice(0, anchorSize).filter(t => t && t.length >= 3);
  const tailTargets = reelTokens.slice(-anchorSize).filter(t => t && t.length >= 3);

  let startIdx = findBestCluster(haystackTokens, window.fromIdx, headRegionEnd, headTargets, { clusterSize: anchorSize + 4, minHits: 2 });
  if (startIdx < 0) startIdx = window.fromIdx;

  let endIdx = findBestClusterEnd(haystackTokens, Math.max(tailRegionStart, startIdx), window.toIdx, tailTargets, { clusterSize: anchorSize + 4, minHits: 2 });
  if (endIdx < 0 || endIdx <= startIdx) endIdx = window.toIdx;

  const startWord = episodeWords[startIdx];
  const endWord = episodeWords[endIdx];
  const startSec = typeof startWord.start === "number" ? startWord.start : 0;
  const endSec = typeof endWord.end === "number" ? endWord.end : startSec;
  if (endSec <= startSec) return null;

  return {
    startSec,
    endSec,
    confidence: window.score,
    matchedTokens: window.hits,
    contentTokens: window.contentTokenCount,
  };
}

module.exports = {
  EPISODES_DIR,
  toSeconds,
  formatTimestamp,
  loadJSON,
  saveJSON,
  loadTranscript,
  formatTranscriptForPrompt,
  findSegmentByText,
  findSegmentEndByText,
  normalizeForAlign,
  tokenizeForAlign,
  alignReelTextToEpisode,
};
