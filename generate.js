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

const AUTH_FILE   = "/root/.openclaw/agents/main/agent/models.json";
const EPISODES_DIR = path.join(__dirname, "episodes");
const FORMATS_DIR  = path.join(__dirname, "formats");

// ─── Config ─────────────────────────────────────────────────────
const BASE_URL = "https://api.haimaker.ai/v1";
let MODEL      = "auto"; // default, can be overridden via --model

function getApiKey() {
  // Read from models.json (has inline apiKey) or fall back to auth.json
  try {
    const m = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    const key = m?.providers?.haimaker?.apiKey;
    if (key) return key;
  } catch (e) {}
  // fallback
  const auth = JSON.parse(fs.readFileSync("/root/.openclaw/agents/main/agent/auth.json", "utf8"));
  return auth.haimaker.key;
}

// ─── Helpers ─────────────────────────────────────────────────────
function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Force immediate output for dashboard logging
function log(msg) {
  process.stdout.write(msg + "\n");
}

function loadFormat(name) {
  const p = path.join(FORMATS_DIR, `${name}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function extractReelText(transcript, startStr, endStr) {
  function toSeconds(ts) {
    const parts = ts.split(":").map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  const start = toSeconds(startStr);
  const end   = toSeconds(endStr);
  return transcript.segments
    .filter(s => s.end > start && s.start < end)
    .map(s => s.text)
    .join(" ")
    .trim();
}

// ─── LLM call (OpenAI-compatible) ────────────────────────────────
async function chat(apiKey, systemPrompt, userMessage, maxTokens = 1024) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage  },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text   = data.choices?.[0]?.message?.content?.trim() ?? "";
  const tokens = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);
  return { text, tokens };
}

// ─── Prompts ──────────────────────────────────────────────────────
const SYSTEM_REELS = `أنت كاتب محتوى لبودكاست "تجارب" — أبرز بودكاست اقتصادي عراقي.
مهمتك: كتابة كابشن لريل إنستغرام بناءً على مقطع من الحلقة.

اقرأ تعليمات الفورمات جيداً واتبعها بدقة.

قواعد اللغة:
- اكتب بالعربية — لغة بيضاء عراقية (لا فصحى ثقيلة، لا عامية كثيفة)
- لا تستخدم چ — استخدم ج بدلها
- قل وية مو ويا
- تجنب يحجي — استخدم نتكلم، نناقش، نغطي
- جمل قصيرة ومباشرة
- لا مبالغة ولا مديح فارغ
- آراء الضيف دائماً منسوبة إليه، مو حقائق مطلقة

أخرج فقط نص الكابشن — بدون شرح أو تعليق.`;

const SYSTEM_YT = `أنت كاتب محتوى لبودكاست "تجارب" — أبرز بودكاست اقتصادي عراقي.
مهمتك: كتابة وصف يوتيوب + عنوان + نص إعلان إنستغرام.

اقرأ تعليمات الفورمات جيداً واتبعها بدقة.

قواعد اللغة:
- اكتب بالعربية — لغة بيضاء عراقية
- لا چ — استخدم ج. قل وية مو ويا. تجنب يحجي.
- جمل قصيرة ومباشرة، لا مبالغة
- آراء الضيف منسوبة إليه دائماً

أخرج JSON بالهيكل التالي بالضبط (بدون نص خارج JSON):
{
  "youtube_titles": [
    "العنوان الأول",
    "العنوان الثاني",
    "العنوان الثالث"
  ],
  "youtube_description": "نص الوصف الكامل",
  "announcement_post": "نص منشور الإعلان للإنستغرام"
}`;

// ─── Generate functions ───────────────────────────────────────────
async function generateReelCaption(apiKey, reel, guest, role, reelText, formatSpec) {
  const user = `فورمات الكابشن المطلوب:
${formatSpec}

---
معلومات الحلقة:
- اسم الضيف: ${guest}
- المنصب/الدور: ${role}

---
نص المقطع:
${reelText}

---
الفكرة المحورية للريل: ${reel.hook}

اكتب الكابشن الآن:`;

  return chat(apiKey, SYSTEM_REELS, user, 512);
}

async function generateYouTubeContent(apiKey, transcript, analysis, guest, role, formatSpec) {
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

  const user = `فورمات المطلوب:
${formatSpec}

---
معلومات الحلقة:
- الضيف: ${guest}
- المنصب: ${role}
- المدة: ${analysis.duration_minutes} دقيقة

---
أقسام الحلقة:
${chaptersText}

---
أبرز الأفكار (من التحليل):
${reelsText}

---
مقتطف من النص:
${summary}

---
أخرج JSON فقط.`;

  const result = await chat(apiKey, SYSTEM_YT, user, 2048);
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
async function generate(slug, guest, role, force = false, reelOnly = false) {
  const outputPath = path.join(EPISODES_DIR, slug, "content.json");

  if (fs.existsSync(outputPath) && !force) {
    log(`⏭️  Content already exists: ${outputPath}`);
    log("   Use --force to regenerate.");
    return outputPath;
  }

  const reelFormat = loadFormat("reel-caption");
  const apiKey     = getApiKey();

  log(`✍️  Generating content for: ${slug}`);
  log(`   Guest: ${guest} — ${role}`);
  log(`   Mode: ${reelOnly ? "REEL ONLY (caption only)" : "FULL EPISODE"}`);
  log(`   Model: ${MODEL} via Haimaker\n`);

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
    const result = await generateReelCaption(apiKey, fakeReel, guest, role, reelText, reelFormat);
    totalTokens += result.tokens;
    log(`   ✅ Done (${result.tokens} tokens)`);

    const output = {
      slug,
      generated_at: new Date().toISOString(),
      guest, role,
      reel_only: true,
      total_tokens_used: totalTokens,
      reels: [{
        id: "reel-01",
        reel_text: reelText,
        caption: result.text,
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

  const ytFormat = loadFormat("youtube-description");

  let totalTokens2 = 0; // separate var to avoid shadowing

  // Reel captions (from analysis.reels)
  const reelCaptions = [];
  for (const reel of (analysis.reels || [])) {
    const reelText = extractReelText(transcript, reel.start, reel.end);
    log(`   🎬 Reel ${reel.id}: ${reel.hook.slice(0, 50)}...`);
    const result = await generateReelCaption(apiKey, reel, guest, role, reelText, reelFormat);
    reelCaptions.push({
      id: reel.id, start: reel.start, end: reel.end,
      hook: reel.hook, reel_text: reelText, caption: result.text,
    });
    totalTokens2 += result.tokens;
    log(`   ✅ Done (${result.tokens} tokens)`);
  }

  // YouTube + announcement
  log("   📺 Generating YouTube description + titles + announcement...");
  const ytResult = await generateYouTubeContent(apiKey, transcript, analysis, guest, role, ytFormat);
  totalTokens2 += ytResult.tokens;
  log(`   ✅ YouTube content done (${ytResult.tokens} tokens)`);

  const output = {
    slug,
    generated_at: new Date().toISOString(),
    guest, role,
    total_tokens_used: totalTokens2,
    reels: reelCaptions,
    ...ytResult.content,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
  log(`\n✅ Done! Total tokens: ${totalTokens2.toLocaleString()}`);
  log(`📄 Saved: ${outputPath}`);
  return outputPath;
}

// ─── CLI ──────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const get      = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug     = get("--slug");
const guest    = get("--guest");
const role     = get("--role");
const force    = args.includes("--force");
const reelOnly = args.includes("--reel-only");
const modelArg = get("--model");

if (modelArg) {
  MODEL = modelArg;
}

if (!slug || !guest || !role) {
  process.stderr.write("Usage: node generate.js --slug <slug> --guest <name> --role <role> [--model auto|claude|openai|gemini] [--force] [--reel-only]\n");
  process.exit(1);
}

generate(slug, guest, role, force, reelOnly).catch(err => {
  process.stderr.write("❌ " + err.message + "\n");
  process.exit(1);
});
