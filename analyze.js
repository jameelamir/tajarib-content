#!/usr/bin/env node
/**
 * Step 2: Analyze transcript with Claude.
 * Identifies cuts, reel moments, and chapters.
 * Reads:  episodes/{slug}/transcript.json
 * Writes: episodes/{slug}/analysis.json
 *
 * Usage:
 *   node analyze.js --slug my-episode [--force] [--more]
 */

const fs = require("fs");
const path = require("path");
const llm = require("./llm");
const prompts = require("./prompts");
const { formatTimestamp, toSeconds, loadTranscript, formatTranscriptForPrompt, findSegmentByText, EPISODES_DIR } = require("./utils");

const CLI_ARGS = process.argv.slice(2);

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

  // Resolve reels — skip teaser (first 60s), validate start < end
  const TEASER_SECONDS = 60;
  if (analysis.reels) {
    for (const reel of analysis.reels) {
      if (reel.text_start) {
        const t = findSegmentByText(segments, reel.text_start, { afterTime: TEASER_SECONDS });
        if (t !== null) reel.start = formatTimestamp(t);
        delete reel.text_start;
      }
      if (reel.text_end) {
        // End must be after start
        const startSec = reel.start ? toSeconds(reel.start) : 0;
        const t = findSegmentByText(segments, reel.text_end, { afterTime: startSec });
        if (t !== null) reel.end = formatTimestamp(t);
        delete reel.text_end;
      }
      // Validate: end must be after start, and duration should be reasonable
      if (reel.start && reel.end) {
        const startSec = toSeconds(reel.start);
        const endSec = toSeconds(reel.end);
        if (endSec <= startSec && reel.duration_seconds) {
          reel.end = formatTimestamp(startSec + reel.duration_seconds);
        }
      } else if (reel.start && !reel.end && reel.duration_seconds) {
        reel.end = formatTimestamp(toSeconds(reel.start) + reel.duration_seconds);
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

/**
 * "Get More Reels" mode: keep existing analysis, ask LLM for additional reels
 * that don't overlap with what's already been identified.
 */
async function analyzeMore(slug) {
  const outputPath = path.join(EPISODES_DIR, slug, "analysis.json");
  if (!fs.existsSync(outputPath)) {
    console.error("❌ No existing analysis.json — run analyze first.");
    process.exit(1);
  }

  const existing = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const existingReels = existing.reels || [];
  if (existingReels.length === 0) {
    console.error("❌ No existing reels to build on — run analyze first.");
    process.exit(1);
  }

  console.log(`🔍 Getting more reels for: ${slug} (${existingReels.length} existing)`);
  const transcript = loadTranscript(slug);
  const formattedTranscript = formatTranscriptForPrompt(transcript);

  // Build summary of existing reels for the prompt
  const existingReelsSummary = existingReels.map(r =>
    `- ريل ${r.id}: [${r.start} → ${r.end}] ${r.hook || ""}\n  "${(r.transcript_excerpt || "").slice(0, 100)}"`
  ).join("\n");

  const userMessage = prompts.load("analyze-more-user", {
    durationMinutes: Math.round(transcript.duration_seconds / 60),
    existingReels: existingReelsSummary,
    formattedTranscript,
  });

  const epDir = path.join(EPISODES_DIR, slug);
  const isResume = CLI_ARGS.includes("--resume");
  let rawContent;
  let elapsed = "0";
  let tokenInfo = { input: 0, output: 0, total: 0 };
  let modelName = "manual";

  if (isResume) {
    const responsePath = path.join(epDir, "llm-response.txt");
    if (!fs.existsSync(responsePath)) {
      console.error("❌ No llm-response.txt found for resume.");
      process.exit(1);
    }
    rawContent = fs.readFileSync(responsePath, "utf8");
    console.log("📋 Using manually provided LLM response");
  } else if (!llm.hasKey()) {
    console.log("📋 No API key found — entering manual LLM mode");
    const promptData = {
      step: "analyze-more",
      system: SYSTEM_PROMPT,
      user: userMessage,
      expectedFormat: "json"
    };
    fs.writeFileSync(path.join(epDir, "llm-prompt.json"), JSON.stringify(promptData, null, 2), "utf8");
    console.log("📄 Prompt saved to llm-prompt.json — awaiting manual response");
    process.exit(42);
  } else {
    const config = llm.getConfig();
    console.log(`🤖 Sending to ${config.model || 'default model'} for more reels...`);
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
  let result;
  try {
    const cleaned = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    result = JSON.parse(cleaned);
  } catch (e) {
    console.error("❌ Failed to parse LLM response as JSON:");
    console.error(rawContent.slice(0, 500));
    process.exit(1);
  }

  const newReels = result.reels || [];
  if (newReels.length === 0) {
    console.log("⚠️  LLM returned no new reels.");
    return outputPath;
  }

  // Resolve timestamps on new reels
  const hasTextRefs = newReels.some(r => r.text_start);
  if (hasTextRefs) {
    console.log("🔗 Resolving text references to precise timestamps...");
    resolveTimestamps({ reels: newReels }, transcript.segments);
  }
  const resolved = newReels.filter(r => r.start && r.end);

  // Assign new IDs starting after the max existing ID
  const maxId = existingReels.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0);
  for (let i = 0; i < resolved.length; i++) {
    resolved[i].id = maxId + 1 + i;
  }

  // Merge into existing analysis
  existing.reels = [...existingReels, ...resolved];
  existing.analyzed_at = new Date().toISOString();
  existing.more_model = modelName;
  existing.more_tokens = tokenInfo;

  fs.writeFileSync(outputPath, JSON.stringify(existing, null, 2), "utf8");

  console.log(`✅ Got ${resolved.length} more reels in ${elapsed}s`);
  console.log(`   Total reels: ${existing.reels.length}`);
  console.log(`   Tokens used: ${tokenInfo.total.toLocaleString()}`);
  console.log(`📄 Saved: ${outputPath}`);
  return outputPath;
}

module.exports = { resolveTimestamps };

// CLI
if (require.main === module) {
  const slugIdx = CLI_ARGS.indexOf("--slug");
  const force = CLI_ARGS.includes("--force");
  const more = CLI_ARGS.includes("--more");
  if (slugIdx === -1 || !CLI_ARGS[slugIdx + 1]) {
    console.error("Usage: node analyze.js --slug <episode-slug> [--force] [--more]");
    process.exit(1);
  }
  const slug = CLI_ARGS[slugIdx + 1];
  const run = more ? analyzeMore(slug) : analyze(slug, force);
  run.catch(err => { console.error("❌", err.message); process.exit(1); });
}
