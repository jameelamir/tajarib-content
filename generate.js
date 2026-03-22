#!/usr/bin/env node
/**
 * Step 3: Generate captions, YouTube description, and announcement post.
 * Reads:  episodes/{slug}/transcript.json + analysis.json + formats/*.md
 * Writes: episodes/{slug}/content.json
 *
 * Uses Haimaker (OpenAI-compatible) — same model as the main agent.
 *
 * Usage:
 *   node generate.js --slug my-episode --guest "اسم الضيف" --role "المنصب" [--model auto|claude|openai|gemini] [--force]
 */

const fs   = require("fs");
const path = require("path");
const llm  = require("./llm");
const prompts = require("./prompts");
const { toSeconds, loadJSON, EPISODES_DIR } = require("./utils");

const CLI_ARGS     = process.argv.slice(2);

// ─── Config ─────────────────────────────────────────────────────
let MODEL = llm.getConfig().model || llm.DEFAULT_MODEL;

// Force immediate output for dashboard logging
function log(msg) {
  process.stdout.write(msg + "\n");
}

function extractReelText(transcript, startStr, endStr) {
  const start = toSeconds(startStr);
  const end   = toSeconds(endStr);
  return transcript.segments
    .filter(s => s.end > start && s.start < end)
    .map(s => s.text)
    .join(" ")
    .trim();
}

// ─── LLM call (via shared llm.js — supports Haimaker, Anthropic, etc.) ──
// Manual LLM round counter — each LLM call in the pipeline is a "round"
let manualRound = 0;

async function chat(systemPrompt, userMessage, maxTokens = 1024, slug = null, stepLabel = "generate") {
  const isResume = CLI_ARGS.includes("--resume");
  const resumeRound = parseInt(CLI_ARGS[CLI_ARGS.indexOf("--resume-round") + 1] || "0", 10);

  if (isResume && manualRound < resumeRound) {
    // Already completed in a previous resume — read saved caption from content.json
    const contentPath = path.join(EPISODES_DIR, slug, "content.json");
    if (fs.existsSync(contentPath)) {
      const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
      const reelMatch = (content.reels || []).find(r => `reel-${r.id}` === stepLabel);
      if (reelMatch) {
        manualRound++;
        log(`📋 Skipping round ${manualRound - 1} — already saved`);
        return { text: reelMatch.caption, tokens: 0 };
      }
    }
    manualRound++;
    return { text: "", tokens: 0 };
  }

  if (isResume && manualRound === resumeRound) {
    // Resume mode: read response from file
    const epDir = path.join(EPISODES_DIR, slug);
    const responsePath = path.join(epDir, "llm-response.txt");
    if (!fs.existsSync(responsePath)) {
      log("❌ No llm-response.txt found for resume.");
      process.exit(1);
    }
    const text = fs.readFileSync(responsePath, "utf8").trim();
    manualRound++;
    log("📋 Using manually provided LLM response");
    return { text, tokens: 0 };
  }

  if (!llm.hasKey()) {
    // Manual mode: write prompt to file and exit with code 42
    const epDir = path.join(EPISODES_DIR, slug);
    log(`📋 No API key — manual LLM mode (round ${manualRound})`);
    const promptData = {
      step: stepLabel,
      round: manualRound,
      system: systemPrompt,
      user: userMessage,
      expectedFormat: stepLabel.includes("youtube") ? "json" : "text"
    };
    fs.writeFileSync(path.join(epDir, "llm-prompt.json"), JSON.stringify(promptData, null, 2), "utf8");
    log("📄 Prompt saved to llm-prompt.json — awaiting manual response");
    process.exit(42);
  }

  const response = await llm.chat({
    system: systemPrompt,
    user: userMessage,
    maxTokens,
    model: MODEL,
  });
  const text = response.text;
  const tokens = response.usage.total;

  // Debug: log token breakdown and text status
  log(`   📊 Tokens — input: ${response.usage.input}, output: ${response.usage.output}, total: ${tokens}`);
  log(`   🤖 Model: ${response.model}`);
  if (!text) {
    log(`   ⚠️  LLM returned empty text! Check console for raw response details.`);
  }

  manualRound++;
  return { text, tokens };
}

// ─── Prompts (loaded from prompts/ folder) ───────────────────────
const SYSTEM_REELS = prompts.load("generate-reels-system");
const SYSTEM_YT = prompts.load("generate-youtube-system");

// ─── Generate functions ───────────────────────────────────────────
async function generateReelCaption(reel, guest, role, reelText, formatSpec, slug, episodeContext = "") {
  const user = prompts.load("generate-reels-user", {
    formatSpec, guest, role, reelText, hook: reel.hook, episodeContext,
  });

  // Note: reasoning models (e.g. DeepSeek R1 via haimaker/auto) need extra token
  // budget because they use tokens for internal reasoning before producing output.
  // 512 was too small — the model would exhaust tokens on reasoning and return null content.
  return chat(SYSTEM_REELS, user, 2048, slug, `reel-${reel.id}`);
}

async function generateYouTubeContent(transcript, analysis, guest, role, formatSpec, slug) {
  const summary = transcript.segments
    .filter((_, i) => i < 5 || i >= transcript.segments.length - 3 ||
      analysis.chapters?.some(ch => {
        const chSec = ch.start.split(":").reduce((a, v, i, arr) =>
          a + Number(v) * Math.pow(60, arr.length - 1 - i), 0);
        return Math.abs(transcript.segments[i]?.start - chSec) < 10;
      }))
    .map(s => s.text)
    .join(" ")
    .slice(0, 3000);

  const chaptersText = analysis.chapters?.map(ch => `${ch.start} — ${ch.title}`).join("\n") || "";
  const reelsText    = analysis.reels?.map(r => `• ${r.hook}`).join("\n") || "";

  const user = prompts.load("generate-youtube-user", {
    formatSpec, guest, role,
    durationMinutes: analysis.duration_minutes,
    chaptersText, reelsText, summary,
  });

  const result = await chat(SYSTEM_YT, user, 2048, slug, "youtube");
  const raw = result.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return { content: JSON.parse(raw), tokens: result.tokens };
}

// ─── Main ─────────────────────────────────────────────────────────
/**
 * @param {string}  slug
 * @param {string}  guest
 * @param {string}  role
 * @param {boolean} force
 * @param {boolean} reelOnly  — true for reel_full / reel_cut: skip YouTube/announcement.
 *                             In reel-only mode the transcript + analysis may not exist;
 *                             we generate a single caption from whatever info we have.
 */
async function generate(slug, guest, role, force = false, reelOnly = false, reelId = null) {
  const outputPath = path.join(EPISODES_DIR, slug, "content.json");

  if (fs.existsSync(outputPath) && !force) {
    log(`⏭️  Content already exists: ${outputPath}`);
    log("   Use --force to regenerate.");
    return outputPath;
  }

  const reelFormat = prompts.load("reel-caption-format");
  const config     = llm.getConfig();

  log(`✍️  Generating content for: ${slug}`);
  log(`   Guest: ${guest} — ${role}`);
  log(`   Mode: ${reelOnly ? "REEL ONLY (caption only)" : "FULL EPISODE"}`);
  log(`   Model: ${MODEL}${config.baseUrl ? ' via ' + new URL(config.baseUrl).hostname : ' via Anthropic'}\n`);

  let totalTokens = 0;

  // ── REEL-ONLY MODE ──────────────────────────────────────────────
  // The user has uploaded an already-cut reel. We don't have a full transcript
  // or analysis. Generate a single reel caption from scratch using guest info
  // and whatever transcript exists (or a placeholder if none).
  if (reelOnly) {
    const transcript = loadJSON(path.join(EPISODES_DIR, slug, "transcript.json"));

    // Build a best-effort reel text from transcript, or use a stub
    let reelText = "[No transcript available — reel was uploaded as already edited]";
    if (transcript && transcript.segments && transcript.segments.length) {
      reelText = transcript.segments.map(s => s.text).join(" ").trim().slice(0, 2000);
    }

    // Create a minimal fake reel object so generateReelCaption can run
    const fakeReel = { id: "reel-01", hook: "", start: "0:00", end: "1:00" };

    log(`   🎬 Generating reel caption…`);
    const result = await generateReelCaption(fakeReel, guest, role, reelText, reelFormat, slug);
    totalTokens += result.tokens;
    log(`   ✅ Done (${result.tokens} tokens)`);

    // Clean up caption: strip markdown code blocks if present
    let captionText = (result.text || "").trim();
    captionText = captionText.replace(/^```[\w]*\n?/gm, "").replace(/```\s*$/gm, "").trim();

    if (!captionText) {
      log(`   ⚠️  WARNING: LLM returned empty caption text!`);
      log(`   Raw result.text: ${JSON.stringify(result.text)}`);
    } else {
      log(`   📝 Caption preview: ${captionText.substring(0, 80)}…`);
    }

    const output = {
      slug,
      generated_at: new Date().toISOString(),
      guest, role,
      reel_only: true,
      total_tokens_used: totalTokens,
      reels: [{
        id: "reel-01",
        reel_text: reelText,
        caption: captionText,
      }],
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
    log(`\n✅ Done! Total tokens: ${totalTokens.toLocaleString()}`);
    log(`📄 Saved: ${outputPath}`);
    return outputPath;
  }

  // ── FULL EPISODE MODE ───────────────────────────────────────────
  const transcript = loadJSON(path.join(EPISODES_DIR, slug, "transcript.json"));
  const analysis   = loadJSON(path.join(EPISODES_DIR, slug, "analysis.json"));

  if (!transcript) { process.stderr.write("❌ No transcript.json found. Run transcribe first.\n"); process.exit(1); }
  if (!analysis)   { process.stderr.write("❌ No analysis.json found. Run analyze first.\n");     process.exit(1); }

  const ytFormat = prompts.load("youtube-description-format");

  let reelsToProcess = analysis.reels || [];

  // Per-reel filter
  if (reelId) {
    const targetId = parseInt(reelId, 10);
    reelsToProcess = reelsToProcess.filter(r => r.id === targetId);
    if (reelsToProcess.length === 0) {
      process.stderr.write(`❌ Reel ${reelId} not found in analysis.\n`);
      process.exit(1);
    }
    log(`📋 Per-reel mode: generating only reel ${targetId}`);
  }

  const reelCaptions = [];
  for (const reel of reelsToProcess) {
    const reelText = extractReelText(transcript, reel.start, reel.end);
    log(`   🎬 Reel ${reel.id}: ${reel.hook.slice(0, 50)}...`);
    const episodeContext = analysis.general_notes || "";
    const result = await generateReelCaption(reel, guest, role, reelText, reelFormat, slug, episodeContext);
    const caption = {
      id: reel.id, start: reel.start, end: reel.end,
      hook: reel.hook, reel_text: reelText, caption: result.text,
    };
    reelCaptions.push(caption);
    totalTokens += result.tokens;
    log(`   ✅ Done (${result.tokens} tokens)`);

    // Save incrementally so partial progress survives interruptions
    const existing = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, "utf8")) : { slug, guest, role, reels: [] };
    const existingReels = existing.reels || [];
    const idx = existingReels.findIndex(r => r.id === caption.id);
    if (idx >= 0) existingReels[idx] = caption;
    else existingReels.push(caption);
    existing.reels = existingReels;
    existing.generated_at = new Date().toISOString();
    existing.total_tokens_used = totalTokens;
    fs.writeFileSync(outputPath, JSON.stringify(existing, null, 2), "utf8");
  }

  // YouTube + announcement
  let ytResult = { tokens: 0, content: {} };
  if (!reelId) {
    log("   📺 Generating YouTube description + titles + announcement...");
    ytResult = await generateYouTubeContent(transcript, analysis, guest, role, ytFormat, slug);
    totalTokens += ytResult.tokens;
    log(`   ✅ YouTube content done (${ytResult.tokens} tokens)`);
  }

  if (reelId && fs.existsSync(outputPath)) {
    // Per-reel mode: merge into existing content.json
    const existing = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    const existingReels = existing.reels || [];
    const newCaption = reelCaptions[0];
    if (newCaption) {
      const idx = existingReels.findIndex(r => r.id === newCaption.id);
      if (idx >= 0) existingReels[idx] = newCaption;
      else existingReels.push(newCaption);
    }
    existing.reels = existingReels;
    existing.generated_at = new Date().toISOString();
    fs.writeFileSync(outputPath, JSON.stringify(existing, null, 2), "utf8");
    log(`\n✅ Done! Merged reel ${reelId} into content.json`);
    log(`📄 Saved: ${outputPath}`);
  } else {
    // Full mode or no existing content
    const output = {
      slug,
      generated_at: new Date().toISOString(),
      guest, role,
      total_tokens_used: totalTokens,
      reels: reelCaptions,
      ...ytResult.content,
    };
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
    log(`\n✅ Done! Total tokens: ${totalTokens.toLocaleString()}`);
    log(`📄 Saved: ${outputPath}`);
  }
  return outputPath;
}

// ─── CLI ──────────────────────────────────────────────────────────
const get      = (flag) => { const i = CLI_ARGS.indexOf(flag); return i !== -1 ? CLI_ARGS[i + 1] : null; };
const slug     = get("--slug");
const guest    = get("--guest");
const role     = get("--role");
const force    = CLI_ARGS.includes("--force");
const reelOnly = CLI_ARGS.includes("--reel-only");
const reelIdFilter = get("--reel-id");
const modelArg = get("--model");

if (modelArg) {
  MODEL = modelArg;
}

if (!slug || !guest || !role) {
  process.stderr.write("Usage: node generate.js --slug <slug> --guest <name> --role <role> [--model claude-sonnet-4-5-20241022] [--force] [--reel-only]\n");
  process.exit(1);
}

generate(slug, guest, role, force, reelOnly, reelIdFilter).catch(err => {
  process.stderr.write("❌ " + err.message + "\n");
  process.exit(1);
});
