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
const { formatTimestamp, toSeconds, loadTranscript, formatTranscriptForPrompt, findSegmentByText, findSegmentEndByText, EPISODES_DIR } = require("./utils");

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

/**
 * Format transcript segments within a time range, with pause indicators.
 * Gives the LLM a detailed segment-level view for making trim decisions.
 * Pauses (⏸) mark natural cut points where audio won't sound abrupt.
 */
function formatSegmentsForTrimming(transcript, startSec, endSec) {
  const segs = transcript.segments.filter(s => s.start >= startSec - 0.5 && s.start < endSec);
  const lines = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    lines.push(`[${formatTimestamp(seg.start)}] ${seg.text.trim()}`);
    if (i < segs.length - 1) {
      const gap = segs[i + 1].start - seg.end;
      if (gap >= 0.4) {
        lines.push(`  ⏸ ${gap.toFixed(1)}s`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Auto-trim a topic reel that exceeds 90s down to 30-90s.
 * Uses word-level timestamps to find natural cut points (pauses),
 * then asks the LLM to choose which parts to keep for a coherent story.
 * Returns the reel with updated start/end and internal cuts.
 */
async function trimTopicReel(slug, reel, transcript) {
  const startSec = toSeconds(reel.start);
  const endSec = toSeconds(reel.end);
  const duration = endSec - startSec;

  console.log(`✂️  Reel ${reel.id} is ${Math.round(duration)}s — trimming to 30-90s...`);

  const segmentTranscript = formatSegmentsForTrimming(transcript, startSec, endSec);

  const userMessage = prompts.load("trim-topic-user", {
    topic: reel.hook || "الموضوع",
    currentDuration: Math.round(duration),
    segmentTranscript,
  });

  const epDir = path.join(EPISODES_DIR, slug);
  const isResume = CLI_ARGS.includes("--resume");
  let rawContent;

  if (isResume) {
    const responsePath = path.join(epDir, "llm-response.txt");
    if (!fs.existsSync(responsePath)) {
      console.error("❌ No llm-response.txt found for resume.");
      process.exit(1);
    }
    rawContent = fs.readFileSync(responsePath, "utf8");
    console.log("📋 Using manually provided LLM response");
  } else {
    if (!llm.hasKey()) {
      console.log("📋 No API key found — entering manual LLM mode");
      const promptData = {
        step: "trim",
        system: SYSTEM_PROMPT,
        user: userMessage,
        expectedFormat: "json",
        reelId: reel.id,
      };
      fs.writeFileSync(path.join(epDir, "llm-prompt.json"), JSON.stringify(promptData, null, 2), "utf8");
      console.log("📄 Prompt saved to llm-prompt.json — awaiting manual response");
      process.exit(42);
    }

    const config = llm.getConfig();
    console.log(`🤖 Sending to ${config.model || "default model"} for smart trimming...`);
    const trimStart = Date.now();

    const response = await llm.chat({
      system: SYSTEM_PROMPT,
      user: userMessage,
      maxTokens: 4096,
    });

    const trimElapsed = ((Date.now() - trimStart) / 1000).toFixed(1);
    rawContent = response.text;
    console.log(`   ⏱️  LLM responded in ${trimElapsed}s`);
  }

  let result;
  try {
    const cleaned = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    result = JSON.parse(cleaned);
  } catch (e) {
    console.error("❌ Failed to parse trim response:", rawContent.slice(0, 300));
    return reel;
  }

  const keepSections = result.keep || [];
  if (keepSections.length === 0) {
    console.log("⚠️  No keep sections returned — keeping full reel.");
    return reel;
  }

  // Resolve keep sections to precise timestamps
  const segments = transcript.segments;
  const resolvedKeeps = [];

  for (const keep of keepSections) {
    const keepStart = findSegmentByText(segments, keep.text_start, { afterTime: startSec - 1 });
    if (keepStart === null) {
      console.log(`   ⚠️  Could not resolve text_start: "${keep.text_start}"`);
      continue;
    }

    // Use findSegmentEndByText to get the END time of the last segment in this keep section
    const keepEndTime = findSegmentEndByText(segments, keep.text_end, { afterTime: keepStart });
    if (keepEndTime === null) {
      console.log(`   ⚠️  Could not resolve text_end: "${keep.text_end}"`);
      continue;
    }

    resolvedKeeps.push({ start: keepStart, end: keepEndTime });
  }

  if (resolvedKeeps.length === 0) {
    console.log("⚠️  Could not resolve any keep sections — keeping full reel.");
    return reel;
  }

  // Sort by start time
  resolvedKeeps.sort((a, b) => a.start - b.start);

  // Update reel boundaries to first/last kept section
  reel.start = formatTimestamp(resolvedKeeps[0].start);
  reel.end = formatTimestamp(resolvedKeeps[resolvedKeeps.length - 1].end);

  // Compute internal cuts as gaps between consecutive keep sections
  const internalCuts = [];
  for (let i = 0; i < resolvedKeeps.length - 1; i++) {
    const gapStart = resolvedKeeps[i].end;
    const gapEnd = resolvedKeeps[i + 1].start;
    if (gapEnd - gapStart > 0.5) {
      internalCuts.push({
        from: formatTimestamp(gapStart),
        to: formatTimestamp(gapEnd),
      });
    }
  }

  reel.cuts = internalCuts;

  const totalKept = resolvedKeeps.reduce((sum, k) => sum + (k.end - k.start), 0);
  console.log(`   ✅ Trimmed: ${Math.round(duration)}s → ${Math.round(totalKept)}s`);
  console.log(`   📐 ${resolvedKeeps.length} section(s) kept, ${internalCuts.length} internal cut(s)`);
  if (result.flow_summary) {
    console.log(`   📝 ${result.flow_summary}`);
  }

  return reel;
}

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

/**
 * "Topic Reel" mode: search the transcript for a specific topic and generate
 * a reel centered around it.
 */
async function analyzeTopic(slug, topic) {
  const outputPath = path.join(EPISODES_DIR, slug, "analysis.json");
  if (!fs.existsSync(outputPath)) {
    console.error("❌ No existing analysis.json — run analyze first.");
    process.exit(1);
  }

  const existing = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const existingReels = existing.reels || [];

  console.log(`🔍 Searching for topic reel: "${topic}" in ${slug} (${existingReels.length} existing)`);
  const transcript = loadTranscript(slug);
  const formattedTranscript = formatTranscriptForPrompt(transcript);

  const userMessage = prompts.load("analyze-topic-user", {
    topic,
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
      step: "analyze-topic",
      topic,
      system: SYSTEM_PROMPT,
      user: userMessage,
      expectedFormat: "json"
    };
    fs.writeFileSync(path.join(epDir, "llm-prompt.json"), JSON.stringify(promptData, null, 2), "utf8");
    console.log("📄 Prompt saved to llm-prompt.json — awaiting manual response");
    process.exit(42);
  } else {
    const config = llm.getConfig();
    console.log(`🤖 Sending to ${config.model || 'default model'} for topic reel...`);
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
    console.log("⚠️  LLM found no reels for this topic.");
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
  existing.topic_model = modelName;
  existing.topic_tokens = tokenInfo;

  fs.writeFileSync(outputPath, JSON.stringify(existing, null, 2), "utf8");

  console.log(`✅ Found ${resolved.length} topic reel(s) for "${topic}" in ${elapsed}s`);
  console.log(`   Total reels: ${existing.reels.length}`);
  console.log(`   Tokens used: ${tokenInfo.total.toLocaleString()}`);
  console.log(`📄 Saved: ${outputPath}`);
  return outputPath;
}

/**
 * "Trim Reel" mode: intelligently trim a specific reel to 30-90s using
 * segment-level transcript analysis with natural pause detection.
 */
async function trimReel(slug, reelId) {
  const outputPath = path.join(EPISODES_DIR, slug, "analysis.json");
  if (!fs.existsSync(outputPath)) {
    console.error("❌ No existing analysis.json — run analyze first.");
    process.exit(1);
  }

  const existing = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const reel = (existing.reels || []).find(r => String(r.id) === String(reelId));
  if (!reel) {
    console.error(`❌ Reel ${reelId} not found in analysis.json`);
    process.exit(1);
  }

  const transcript = loadTranscript(slug);
  const trimmed = await trimTopicReel(slug, reel, transcript);

  // Update reel in-place
  const idx = existing.reels.findIndex(r => String(r.id) === String(reelId));
  existing.reels[idx] = trimmed;
  fs.writeFileSync(outputPath, JSON.stringify(existing, null, 2), "utf8");

  console.log(`📄 Saved: ${outputPath}`);
  return outputPath;
}

module.exports = { resolveTimestamps };

// CLI
if (require.main === module) {
  const slugIdx = CLI_ARGS.indexOf("--slug");
  const force = CLI_ARGS.includes("--force");
  const more = CLI_ARGS.includes("--more");
  const trim = CLI_ARGS.includes("--trim");
  const topicIdx = CLI_ARGS.indexOf("--topic");
  const topic = topicIdx !== -1 ? CLI_ARGS[topicIdx + 1] : null;
  const reelIdIdx = CLI_ARGS.indexOf("--reel-id");
  const reelId = reelIdIdx !== -1 ? CLI_ARGS[reelIdIdx + 1] : null;
  if (slugIdx === -1 || !CLI_ARGS[slugIdx + 1]) {
    console.error("Usage: node analyze.js --slug <episode-slug> [--force] [--more] [--topic <topic>] [--trim --reel-id <id>]");
    process.exit(1);
  }
  const slug = CLI_ARGS[slugIdx + 1];
  const run = trim ? trimReel(slug, reelId) : topic ? analyzeTopic(slug, topic) : more ? analyzeMore(slug) : analyze(slug, force);
  run.catch(err => { console.error("❌", err.message); process.exit(1); });
}
