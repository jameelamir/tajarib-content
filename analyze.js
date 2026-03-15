#!/usr/bin/env node
/**
 * Step 2: Analyze transcript with Claude.
 * Identifies cuts, reel moments, and chapters.
 * Reads:  episodes/{slug}/transcript.json
 * Writes: episodes/{slug}/analysis.json
 *
 * Usage:
 *   node analyze.js --slug my-episode [--force]
 */

const fs = require("fs");
const path = require("path");
const llm = require("./llm");
const prompts = require("./prompts");

const EPISODES_DIR = path.join(__dirname, "episodes");
const CLI_ARGS = process.argv.slice(2);

function loadTranscript(slug) {
  const p = path.join(EPISODES_DIR, slug, "transcript.json");
  if (!fs.existsSync(p)) {
    console.error(`❌ No transcript found: ${p}`);
    console.error("   Run transcribe.py first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatTranscriptForPrompt(transcript) {
  // Compress segments into paragraphs with a timestamp every ~30 seconds.
  // This significantly reduces token count while preserving enough context for analysis.
  const PARAGRAPH_INTERVAL = 30; // seconds between timestamp markers
  const paragraphs = [];
  let currentTexts = [];
  let paragraphStart = 0;

  for (const seg of transcript.segments) {
    if (currentTexts.length === 0) {
      paragraphStart = seg.start;
    }
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
 * Fuzzy-match a text excerpt against the original transcript segments.
 * Returns the timestamp (in seconds) of the best-matching segment.
 */
function findSegmentByText(segments, excerpt) {
  if (!excerpt || !segments.length) return null;
  const needle = excerpt.trim().replace(/\s+/g, " ");
  let bestIdx = -1;
  let bestScore = 0;

  // Try sliding windows of 1-4 consecutive segments (excerpt likely spans multiple)
  for (let winSize = 1; winSize <= Math.min(4, segments.length); winSize++) {
    for (let i = 0; i <= segments.length - winSize; i++) {
      const combined = segments.slice(i, i + winSize).map(s => s.text.trim()).join(" ").replace(/\s+/g, " ");
      // Exact substring match — best possible result
      if (combined.includes(needle)) return segments[i].start;
      if (needle.includes(combined) && winSize > 1) return segments[i].start;
    }
  }

  // Fallback: word overlap scoring against individual segments
  const needleWords = needle.split(" ");
  for (let i = 0; i < segments.length; i++) {
    const haystackWords = segments[i].text.trim().replace(/\s+/g, " ").split(" ");
    const overlap = needleWords.filter(w => haystackWords.includes(w)).length;
    const score = overlap / Math.max(needleWords.length, 1);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  return bestIdx >= 0 && bestScore > 0.3 ? segments[bestIdx].start : null;
}

/**
 * Resolve text-based references from LLM output into precise MM:SS timestamps
 * using the original transcript segments.
 */
function resolveTimestamps(analysis, segments) {
  // Resolve cuts
  if (analysis.cuts) {
    for (const cut of analysis.cuts) {
      if (cut.text_start) {
        const t = findSegmentByText(segments, cut.text_start);
        if (t !== null) cut.start = formatTimestamp(t);
        delete cut.text_start;
      }
      if (cut.text_end) {
        const t = findSegmentByText(segments, cut.text_end);
        if (t !== null) cut.end = formatTimestamp(t);
        delete cut.text_end;
      }
    }
    // Drop any cuts where matching failed
    analysis.cuts = analysis.cuts.filter(c => c.start && c.end);
  }

  // Resolve reels
  if (analysis.reels) {
    for (const reel of analysis.reels) {
      if (reel.text_start) {
        const t = findSegmentByText(segments, reel.text_start);
        if (t !== null) reel.start = formatTimestamp(t);
        delete reel.text_start;
      }
      if (reel.text_end) {
        const t = findSegmentByText(segments, reel.text_end);
        if (t !== null) reel.end = formatTimestamp(t);
        delete reel.text_end;
      }
    }
    analysis.reels = analysis.reels.filter(r => r.start && r.end);
  }

  // Resolve chapters
  if (analysis.chapters) {
    for (const ch of analysis.chapters) {
      if (ch.text_start) {
        const t = findSegmentByText(segments, ch.text_start);
        if (t !== null) ch.start = formatTimestamp(t);
        delete ch.text_start;
      }
    }
    analysis.chapters = analysis.chapters.filter(c => c.start);
  }

  return analysis;
}

const SYSTEM_PROMPT = prompts.load("analyze-system");

async function analyze(slug, force = false) {
  const outputPath = path.join(EPISODES_DIR, slug, "analysis.json");

  if (fs.existsSync(outputPath) && !force) {
    console.log(`⏭️  Analysis already exists: ${outputPath}`);
    console.log("   Use --force to re-analyze.");
    return outputPath;
  }

  console.log(`🔍 Analyzing episode: ${slug}`);
  const transcript = loadTranscript(slug);
  console.log(`📄 Transcript: ${transcript.segment_count} segments, ${Math.round(transcript.duration_seconds / 60)} min`);

  const formattedTranscript = formatTranscriptForPrompt(transcript);

  const userMessage = prompts.load("analyze-user", {
    durationMinutes: Math.round(transcript.duration_seconds / 60),
    formattedTranscript,
  });

  const epDir = path.join(EPISODES_DIR, slug);
  const isResume = CLI_ARGS.includes("--resume");
  let rawContent;
  let elapsed = "0";
  let tokenInfo = { input: 0, output: 0, total: 0 };
  let modelName = "manual";

  if (isResume) {
    // Resume mode: read response from file
    const responsePath = path.join(epDir, "llm-response.txt");
    if (!fs.existsSync(responsePath)) {
      console.error("❌ No llm-response.txt found for resume.");
      process.exit(1);
    }
    rawContent = fs.readFileSync(responsePath, "utf8");
    console.log("📋 Using manually provided LLM response");
  } else {
    if (!llm.hasKey()) {
      // Manual mode: write prompt to file and exit with code 42
      console.log("📋 No API key found — entering manual LLM mode");
      const promptData = {
        step: "analyze",
        system: SYSTEM_PROMPT,
        user: userMessage,
        expectedFormat: "json"
      };
      fs.writeFileSync(path.join(epDir, "llm-prompt.json"), JSON.stringify(promptData, null, 2), "utf8");
      console.log("📄 Prompt saved to llm-prompt.json — awaiting manual response");
      process.exit(42);
    }

    const config = llm.getConfig();
    console.log(`🤖 Sending to ${config.model || 'default model'} for analysis...`);
    const startTime = Date.now();

    const response = await llm.chat({
      system: SYSTEM_PROMPT,
      user: userMessage,
      maxTokens: 4096,
    });

    elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    rawContent = response.text;
    modelName = response.model;
    tokenInfo = response.usage;
  }

  // Parse JSON response
  let analysis;
  try {
    // Strip any markdown fences if present
    const cleaned = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    analysis = JSON.parse(cleaned);
  } catch (e) {
    console.error("❌ Failed to parse LLM response as JSON:");
    console.error(rawContent.slice(0, 500));
    process.exit(1);
  }

  // Resolve text-based references to precise timestamps
  const hasTextRefs = (analysis.cuts || []).some(c => c.text_start) ||
                      (analysis.reels || []).some(r => r.text_start) ||
                      (analysis.chapters || []).some(c => c.text_start);
  if (hasTextRefs) {
    console.log("🔗 Resolving text references to precise timestamps...");
    resolveTimestamps(analysis, transcript.segments);
    const resolvedCuts = (analysis.cuts || []).length;
    const resolvedReels = (analysis.reels || []).length;
    console.log(`   ✅ Resolved: ${resolvedCuts} cuts, ${resolvedReels} reels`);
  }

  // Augment with metadata
  const output = {
    slug,
    analyzed_at: new Date().toISOString(),
    model: modelName,
    tokens: tokenInfo,
    duration_minutes: Math.round(transcript.duration_seconds / 60),
    ...analysis
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`✅ Analysis done in ${elapsed}s`);
  console.log(`   Cuts: ${analysis.cuts?.length || 0}`);
  console.log(`   Reels: ${analysis.reels?.length || 0}`);
  console.log(`   Chapters: ${analysis.chapters?.length || 0}`);
  console.log(`   Tokens used: ${output.tokens.total.toLocaleString()}`);
  console.log(`📄 Saved: ${outputPath}`);
  return outputPath;
}

// CLI
const slugIdx = CLI_ARGS.indexOf("--slug");
const force = CLI_ARGS.includes("--force");
if (slugIdx === -1 || !CLI_ARGS[slugIdx + 1]) {
  console.error("Usage: node analyze.js --slug <episode-slug> [--force]");
  process.exit(1);
}
const slug = CLI_ARGS[slugIdx + 1];
analyze(slug, force).catch(err => { console.error("❌", err.message); process.exit(1); });
