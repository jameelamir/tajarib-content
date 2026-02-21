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
const Anthropic = require("@anthropic-ai/sdk");

const AUTH_FILE = "/root/.openclaw/agents/main/agent/auth.json";
const EPISODES_DIR = path.join(__dirname, "episodes");

function getApiKey() {
  const auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  return auth.anthropic.key;
}

function loadTranscript(slug) {
  const p = path.join(EPISODES_DIR, slug, "transcript.json");
  if (!fs.existsSync(p)) {
    console.error(`❌ No transcript found: ${p}`);
    console.error("   Run transcribe.py first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function formatTranscriptForPrompt(transcript) {
  // Compact format: [MM:SS] segment text
  return transcript.segments.map(seg => {
    const mins = Math.floor(seg.start / 60).toString().padStart(2, "0");
    const secs = Math.floor(seg.start % 60).toString().padStart(2, "0");
    return `[${mins}:${secs}] ${seg.text}`;
  }).join("\n");
}

const SYSTEM_PROMPT = `أنت محلل محتوى متخصص لبودكاست "تجارب" العراقي — أبرز بودكاست اقتصادي في العراق.
مهمتك: تحليل نص الحلقة المدموغ بالتوقيتات وإخراج تحليل منظم بصيغة JSON.

ستقوم بـ:
1. تحديد أجزاء يمكن حذفها (ممل، مكرر، تقني بدون قيمة)
2. تحديد أفضل 3-6 لحظات مناسبة للريلز (مثيرة، مفيدة، مثيرة للجدل، ممتعة)
3. اقتراح أقسام للحلقة (chapters)
4. ملاحظات عامة

أخرج JSON بالهيكل التالي بالضبط (بدون أي نص خارج JSON):
{
  "cuts": [
    {
      "start": "MM:SS",
      "end": "MM:SS",
      "reason": "سبب الحذف بالعربي"
    }
  ],
  "reels": [
    {
      "id": 1,
      "start": "MM:SS",
      "end": "MM:SS",
      "duration_seconds": 45,
      "hook": "الفكرة المحورية للريل — جملة واحدة",
      "transcript_excerpt": "مقتطف من النص الذي يمثل هذه اللحظة",
      "why": "لماذا هذه اللحظة مناسبة للريلز"
    }
  ],
  "chapters": [
    {
      "start": "MM:SS",
      "title": "عنوان القسم"
    }
  ],
  "general_notes": "ملاحظات عامة عن الحلقة"
}

قواعد مهمة:
- الريلز المثالي: 30-90 ثانية
- اختر لحظات فيها رأي جريء أو معلومة مفاجئة أو موقف إنساني أو جدل بنّاء
- التوقيتات تكون بصيغة MM:SS أو HH:MM:SS إذا تجاوزت ساعة
- لا تُرجع أي شيء خارج الـ JSON`;

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
  const client = new Anthropic.default({ apiKey: getApiKey() });

  const userMessage = `فيما يلي نص حلقة بودكاست "تجارب" مع التوقيتات. حللها وأخرج JSON بالهيكل المطلوب:

المدة الإجمالية: ${Math.round(transcript.duration_seconds / 60)} دقيقة

---
${formattedTranscript}
---`;

  console.log("🤖 Sending to Claude for analysis...");
  const startTime = Date.now();

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }]
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rawContent = response.content[0].text;

  // Parse JSON response
  let analysis;
  try {
    // Strip any markdown fences if present
    const cleaned = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    analysis = JSON.parse(cleaned);
  } catch (e) {
    console.error("❌ Failed to parse Claude response as JSON:");
    console.error(rawContent.slice(0, 500));
    process.exit(1);
  }

  // Augment with metadata
  const output = {
    slug,
    analyzed_at: new Date().toISOString(),
    model: response.model,
    tokens: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      total: response.usage.input_tokens + response.usage.output_tokens
    },
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
const args = process.argv.slice(2);
const slugIdx = args.indexOf("--slug");
const force = args.includes("--force");
if (slugIdx === -1 || !args[slugIdx + 1]) {
  console.error("Usage: node analyze.js --slug <episode-slug> [--force]");
  process.exit(1);
}
const slug = args[slugIdx + 1];
analyze(slug, force).catch(err => { console.error("❌", err.message); process.exit(1); });
