#!/usr/bin/env node
/**
 * suggest-clips.js - Upload MP3, get AI-suggested clip timestamps
 * 
 * Usage:
 *   node suggest-clips.js <mp3-file> [episode-slug]
 * 
 * Example:
 *   node suggest-clips.js interview.mp3 muhannad-full
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const FormData = require("form-data");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const DASHBOARD_URL = "http://76.13.145.146:7430";
const WORKSPACE_DIR = "/root/.openclaw/workspace/tajarib";
const EPISODES_DIR = path.join(WORKSPACE_DIR, "episodes");

function loadJSON(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}

function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

async function transcribeAudio(mp3Path, slug) {
  console.log("🎙️  Transcribing audio...\n");
  
  const epDir = path.join(EPISODES_DIR, slug);
  fs.mkdirSync(epDir, { recursive: true });
  
  // Copy MP3 to episode dir
  const destMp3 = path.join(epDir, "audio.mp3");
  fs.copyFileSync(mp3Path, destMp3);
  
  // Save meta
  saveJSON(path.join(epDir, "meta.json"), {
    originalFilename: path.basename(mp3Path),
    createdAt: new Date().toISOString(),
    mediaType: "audio_preview"
  });
  
  // Run transcription
  return new Promise((resolve, reject) => {
    const python = path.join(WORKSPACE_DIR, ".venv", "bin", "python3");
    const proc = spawn(python, [
      "-u", "transcribe.py", destMp3, "--slug", slug
    ], { cwd: WORKSPACE_DIR, stdio: "inherit" });
    
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Transcription failed with code ${code}`));
    });
  });
}

async function analyzeForClips(slug, guest, role) {
  console.log("\n🤖 Analyzing for best clips...\n");
  
  // Load transcript
  const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
  const transcript = loadJSON(transcriptPath);
  if (!transcript) throw new Error("Transcript not found");
  
  const AUTH_FILE = "/root/.openclaw/agents/main/agent/models.json";
  const AUTH_FALLBACK = "/root/.openclaw/agents/main/agent/auth.json";
  const BASE_URL = "https://api.haimaker.ai/v1";
  
  let apiKey;
  try {
    const m = loadJSON(AUTH_FILE);
    apiKey = m?.providers?.haimaker?.apiKey;
  } catch (_) {}
  if (!apiKey) {
    const auth = loadJSON(AUTH_FALLBACK);
    apiKey = auth?.haimaker?.key || auth?.anthropic?.key;
  }
  
  const fullText = transcript.full_text || transcript.segments.map(s => s.text).join(' ');
  
  const prompt = `You are a video editor for the Tajarib podcast. Analyze this transcript and identify the 3 best clips for social media reels.

Guest: ${guest || "Unknown"}
Role: ${role || "Unknown"}

Transcript with timestamps:
${transcript.segments.map(s => `[${formatTime(s.start)}] ${s.text}`).join('\n')}

For each clip, provide:
1. Start time (timestamp)
2. End time (timestamp) 
3. Duration
4. Why this clip works (hook explanation)
5. A suggested caption for social media

Consider:
- Strong openings/hooks that grab attention in first 3 seconds
- Complete thoughts that don't need context
- Emotional or surprising moments
- Valuable insights or tips
- Natural breakpoints in speech

Return as JSON array:
[
  {
    "start": "00:02:15",
    "start_seconds": 135,
    "end": "00:02:52",
    "end_seconds": 172,
    "duration_seconds": 37,
    "hook": "One sentence hook explaining why this clip works",
    "caption": "Arabic caption with emojis for social media"
  }
]

Include 1 short clip (30-45s), 1 medium (45-90s), and 1 longer (90-180s) if content supports it.`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "auto",
      max_tokens: 2048,
      messages: [
        { role: "system", content: "You are an expert video editor and social media strategist for the Tajarib Arabic podcast." },
        { role: "user", content: prompt }
      ]
    })
  });
  
  if (!res.ok) throw new Error("AI analysis failed");
  
  const data = await res.json();
  const content = data.choices[0].message.content;
  
  // Extract JSON
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Could not parse AI response");
  
  const clips = JSON.parse(jsonMatch[0]);
  
  // Save suggestions
  saveJSON(path.join(EPISODES_DIR, slug, "clip-suggestions.json"), {
    createdAt: new Date().toISOString(),
    guest,
    role,
    clips
  });
  
  return clips;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function generateFfmpegCommand(videoPath, clip, outputName) {
  return `ffmpeg -ss ${clip.start} -i "${videoPath}" -t ${clip.duration_seconds} \\
  -c:v libx264 -preset fast -crf 23 \\
  -c:a aac -b:a 128k \\
  -movflags +faststart \\
  "${outputName}.mp4"`;
}

function generateUploadCommand(slug, guest, role, outputName) {
  return `curl -X POST "${DASHBOARD_URL}/api/upload" \\
  -F "slug=${slug}" \\
  -F "video=@${outputName}.mp4" \\
  -F "mediaType=reel_cut" \\
  -F "transcribeMethod=local" \\
  -F "guest=${guest}" \\
  -F "role=${role}"`;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log(`Usage: node suggest-clips.js <mp3-file> [episode-slug]`);
    console.log(`Example: node suggest-clips.js interview.mp3 muhannad-full`);
    process.exit(1);
  }
  
  const [mp3Path, slugArg] = args;
  const slug = slugArg || path.basename(mp3Path, path.extname(mp3Path));
  
  if (!fs.existsSync(mp3Path)) {
    console.error("❌ File not found:", mp3Path);
    process.exit(1);
  }
  
  // Check if already transcribed
  const transcriptPath = path.join(EPISODES_DIR, slug, "transcript.json");
  if (!fs.existsSync(transcriptPath)) {
    console.log(`📁 Episode: ${slug}\n`);
    await transcribeAudio(mp3Path, slug);
  } else {
    console.log(`✅ Using existing transcript for ${slug}\n`);
  }
  
  // Get guest info
  const meta = loadJSON(path.join(EPISODES_DIR, slug, "meta.json")) || {};
  let guest = meta.guest;
  let role = meta.role;
  
  if (!guest) {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q) => new Promise(r => rl.question(q, r));
    
    guest = await question("Guest name (Arabic): ");
    role = await question("Guest role: ");
    rl.close();
    
    // Save to meta
    saveJSON(path.join(EPISODES_DIR, slug, "meta.json"), {
      ...meta,
      guest,
      role
    });
  }
  
  // Analyze for clips
  const clips = await analyzeForClips(slug, guest, role);
  
  // Display results
  console.log("\n" + "=".repeat(60));
  console.log("🎯 SUGGESTED CLIPS");
  console.log("=".repeat(60) + "\n");
  
  clips.forEach((clip, i) => {
    console.log(`${i + 1}. ⏱️  ${clip.start} → ${clip.end} (${clip.duration_seconds}s)`);
    console.log(`   🪝 ${clip.hook}`);
    console.log(`   📝 ${clip.caption.substring(0, 80)}${clip.caption.length > 80 ? '...' : ''}\n`);
  });
  
  // Show ffmpeg commands
  console.log("=".repeat(60));
  console.log("🎬 CUT & UPLOAD COMMANDS");
  console.log("=".repeat(60));
  console.log("\nReplace VIDEO_PATH with your actual video file path:\n");
  
  clips.forEach((clip, i) => {
    const outputName = `${slug}-clip-${i + 1}`;
    console.log(`\n--- Clip ${i + 1}: ${clip.duration_seconds}s ---`);
    console.log("\n# Cut the clip:");
    console.log(generateFfmpegCommand("VIDEO_PATH", clip, outputName));
    console.log("\n# Upload to dashboard:");
    console.log(generateUploadCommand(slug + `-clip-${i + 1}`, guest, role, outputName));
    console.log("");
  });
  
  // One-liner option
  console.log("=".repeat(60));
  console.log("⚡ ONE-CLICK OPTION (copy & edit VIDEO_PATH):");
  console.log("=".repeat(60) + "\n");
  
  console.log("# Cut all clips then upload:");
  console.log(`VIDEO_PATH="your-video.mp4" && \\
${clips.map((clip, i) => {
  const outputName = `${slug}-clip-${i + 1}`;
  return `  ffmpeg -ss ${clip.start} -i "$VIDEO_PATH" -t ${clip.duration_seconds} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${outputName}.mp4" && \\
  curl -X POST "${DASHBOARD_URL}/api/upload" -F "slug=${slug}-clip-${i + 1}" -F "video=@${outputName}.mp4" -F "mediaType=reel_cut" -F "transcribeMethod=local" -F "guest=${guest}" -F "role=${role}"`;
}).join(" && \\
")}`);
  
  console.log("\n✅ Done! Edit VIDEO_PATH and run the command.");
  console.log(`🌐 Dashboard: ${DASHBOARD_URL}`);
  console.log(`\n💡 Tip: To extract a 5-min segment first:`);
  console.log(`   ffmpeg -ss 00:10:00 -i "big-video.mp4" -t 300 -c copy "segment.mp4"`);
  console.log(`   Then use "segment.mp4" as VIDEO_PATH above.\n`);
}

main().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
