/**
 * Shared utility functions used across CLI pipeline scripts.
 */

const fs = require("fs");
const path = require("path");

const EPISODES_DIR = path.join(__dirname, "episodes");

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
 */
function formatTranscriptForPrompt(transcript) {
  const PARAGRAPH_INTERVAL = 30;
  const paragraphs = [];
  let currentTexts = [];
  let paragraphStart = 0;

  for (const seg of transcript.segments) {
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
 * Fuzzy-match a text excerpt against transcript segments.
 * Returns the timestamp (in seconds) of the best-matching segment, or null.
 */
function findSegmentByText(segments, excerpt) {
  if (!excerpt || !segments.length) return null;
  const needle = excerpt.trim().replace(/\s+/g, " ");

  // Try sliding windows of 1-4 consecutive segments
  for (let winSize = 1; winSize <= Math.min(4, segments.length); winSize++) {
    for (let i = 0; i <= segments.length - winSize; i++) {
      const combined = segments.slice(i, i + winSize).map(s => s.text.trim()).join(" ").replace(/\s+/g, " ");
      if (combined.includes(needle)) return segments[i].start;
      if (needle.includes(combined) && winSize > 1) return segments[i].start;
    }
  }

  // Fallback: word overlap scoring
  const needleWords = needle.split(" ");
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < segments.length; i++) {
    const haystackWords = segments[i].text.trim().replace(/\s+/g, " ").split(" ");
    const overlap = needleWords.filter(w => haystackWords.includes(w)).length;
    const score = overlap / Math.max(needleWords.length, 1);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  return bestIdx >= 0 && bestScore > 0.3 ? segments[bestIdx].start : null;
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
};
