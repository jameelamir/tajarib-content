#!/usr/bin/env node
/**
 * Step 3: Generate captions, YouTube description, and announcement post.
 * Reads:  episodes/{slug}/transcript.json + analysis.json + formats/*.md
 * Writes: episodes/{slug}/content.json
 *
 * Usage:
 *   node generate.js --slug my-episode --guest "اسم الضيف" --role "المنصب" [--force]
 */

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const AUTH_FILE = "/root/.openclaw/agents/main/agent/auth.json";
const EPISODES_DIR = path.join(__dirname, "episodes");
const FORMATS_DIR = path.join(__dirname, "formats");

function getApiKey() {
  const auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  return auth.anthropic.key;
}

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadFormat(name) {
  const p = path.join(FORMATS_DIR, `${name}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

// Given a reel with start/end timestamps (MM:SS or HH:MM:SS), extract transcript text
function extractReelText(transcript, startStr, endStr) {
  function toSeconds(ts) {
    const parts = ts.split(":").map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  const start = toSeconds(startStr);
  const end = toSeconds(endStr);
  return transcript.segments
    .filter(s => s.end > start && s.start < end)
    .map(s => s.text)
    .join(" ")
    .trim();
}

const SYSTEM_PROMPT_REELS = `أنت كاتب محتوى لبودكاست "تجارب" — أبرز بودكاست اقتصادي عراقي.
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

const SYSTEM_PROMPT_YT = `أنت كاتب محتوى لبودكاست "تجارب" — أبرز بودكاست اقتصادي عراقي.
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

async function generateReelCaption(client, reel, guest, role, reelText, formatSpec) {
  const userMessage = `فورمات الكابشن المطلوب:
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

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 512,
    system: SYSTEM_PROMPT_REELS,
    messages: [{ role: "user", content: userMessage }]
  });

  return {
    caption: response.content[0].text.trim(),
    tokens: response.usage.input_tokens + response.usage.output_tokens
  };
}

async function generateYouTubeContent(client, transcript, analysis, guest, role, formatSpec) {
  // Send a condensed transcript summary (first + last segments + chapter starts) to save tokens
  const summary = transcript.segments
    .filter((_, i) => i < 5 || i >= transcript.segments.length - 3 ||
      analysis.chapters?.some(ch => {
        const chSec = ch.start.split(":").reduce((a, v, i, arr) =>
          a + Number(v) * Math.pow(60, arr.length - 1 - i), 0);
        return Math.abs(transcript.segments[i]?.start - chSec) < 10;
      }))
    .map(s => s.text)
    .join(" ")
    .slice(0, 3000); // cap at ~3k chars

  const chaptersText = analysis.chapters?.map(ch => `${ch.start} — ${ch.title}`).join("\n") || "";
  const reelsText = analysis.reels?.map(r => `• ${r.hook}`).join("\n") || "";

  const userMessage = `فورمات المطلوب:
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

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2048,
    system: SYSTEM_PROMPT_YT,
    messages: [{ role: "user", content: userMessage }]
  });

  const raw = response.content[0].text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return {
    content: JSON.parse(raw),
    tokens: response.usage.input_tokens + response.usage.output_tokens
  };
}

async function generate(slug, guest, role, force = false) {
  const outputPath = path.join(EPISODES_DIR, slug, "content.json");

  if (fs.existsSync(outputPath) && !force) {
    console.log(`⏭️  Content already exists: ${outputPath}`);
    console.log("   Use --force to regenerate.");
    return outputPath;
  }

  const transcript = loadJSON(path.join(EPISODES_DIR, slug, "transcript.json"));
  const analysis = loadJSON(path.join(EPISODES_DIR, slug, "analysis.json"));

  if (!transcript) { console.error("❌ No transcript.json found. Run transcribe.py first."); process.exit(1); }
  if (!analysis) { console.error("❌ No analysis.json found. Run analyze.js first."); process.exit(1); }

  const reelFormat = loadFormat("reel-caption");
  const ytFormat = loadFormat("youtube-description");

  const client = new Anthropic.default({ apiKey: getApiKey() });
  let totalTokens = 0;

  console.log(`✍️  Generating content for: ${slug}`);
  console.log(`   Guest: ${guest} — ${role}`);

  // Generate reel captions
  const reelCaptions = [];
  for (const reel of (analysis.reels || [])) {
    const reelText = extractReelText(transcript, reel.start, reel.end);
    process.stdout.write(`   🎬 Reel ${reel.id}: ${reel.hook.slice(0, 50)}...`);
    const result = await generateReelCaption(client, reel, guest, role, reelText, reelFormat);
    reelCaptions.push({
      id: reel.id,
      start: reel.start,
      end: reel.end,
      hook: reel.hook,
      reel_text: reelText,
      caption: result.caption
    });
    totalTokens += result.tokens;
    console.log(` ✅ (${result.tokens} tokens)`);
  }

  // Generate YouTube content
  console.log("   📺 Generating YouTube description + titles + announcement...");
  const ytResult = await generateYouTubeContent(client, transcript, analysis, guest, role, ytFormat);
  totalTokens += ytResult.tokens;
  console.log(`   ✅ YouTube content done (${ytResult.tokens} tokens)`);

  const output = {
    slug,
    generated_at: new Date().toISOString(),
    guest,
    role,
    total_tokens_used: totalTokens,
    reels: reelCaptions,
    ...ytResult.content
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`\n✅ Done! Total tokens used: ${totalTokens.toLocaleString()}`);
  console.log(`📄 Saved: ${outputPath}`);
  return outputPath;
}

// CLI
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const slug = get("--slug");
const guest = get("--guest");
const role = get("--role");
const force = args.includes("--force");

if (!slug || !guest || !role) {
  console.error("Usage: node generate.js --slug <slug> --guest <name> --role <role> [--force]");
  process.exit(1);
}
generate(slug, guest, role, force).catch(err => { console.error("❌", err.message); process.exit(1); });
