#!/usr/bin/env node
/**
 * cut-and-upload.js - Cut video locally, upload only the clip
 * Usage: node cut-and-upload.js <video.mp4> <start-time> <duration> <slug>
 * Example: node cut-and-upload.js interview.mp4 00:05:30 45 reel-muhannad-quote
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const DASHBOARD_URL = "http://76.13.145.146:7430";
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(q) {
  return new Promise(resolve => rl.question(q, resolve));
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function parseTime(timeStr) {
  // Accepts: 45 (seconds), 1:30, 01:30, 00:01:30
  if (!isNaN(timeStr)) return parseInt(timeStr);
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

async function cutVideo(inputPath, startTime, duration, outputPath) {
  console.log(`\n✂️  Cutting video...`);
  console.log(`   From: ${formatTime(startTime)}`);
  console.log(`   Duration: ${duration}s`);
  console.log(`   Output: ${outputPath}\n`);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-ss", String(startTime),
      "-i", inputPath,
      "-t", String(duration),
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y",
      outputPath
    ], { stdio: "inherit" });

    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

async function uploadClip(clipPath, slug, guest, role) {
  const fileSize = fs.statSync(clipPath).size;
  const filename = path.basename(clipPath);
  
  console.log(`\n📤 Uploading clip...`);
  console.log(`   File: ${filename}`);
  console.log(`   Size: ${(fileSize / 1024 / 1024).toFixed(1)} MB\n`);

  // Initialize upload
  const initRes = await fetch(`${DASHBOARD_URL}/api/upload-init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename,
      fileSize,
      slug,
      guest,
      role,
      mediaType: "reel_cut",
      transcribeMethod: "local"
    })
  });
  
  const initData = await initRes.json();
  if (!initData.success) throw new Error(initData.error);
  const { uploadId, totalChunks } = initData;

  // Upload chunks
  const file = fs.openSync(clipPath, "r");
  const buffer = Buffer.alloc(CHUNK_SIZE);
  
  for (let i = 0; i < totalChunks; i++) {
    const bytesRead = fs.readSync(file, buffer, 0, CHUNK_SIZE, i * CHUNK_SIZE);
    const chunk = buffer.slice(0, bytesRead);
    
    process.stdout.write(`   Uploading chunk ${i + 1}/${totalChunks}... `);
    
    const chunkRes = await fetch(`${DASHBOARD_URL}/api/upload-chunk?uploadId=${uploadId}&chunkIndex=${i}`, {
      method: "POST",
      body: chunk
    });
    
    if (!chunkRes.ok) throw new Error(`Chunk ${i} upload failed`);
    console.log("✓");
  }
  
  fs.closeSync(file);

  // Complete upload
  process.stdout.write("\n   Finalizing... ");
  const completeRes = await fetch(`${DASHBOARD_URL}/api/upload-complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId })
  });
  
  const completeData = await completeRes.json();
  if (!completeData.success) throw new Error(completeData.error);
  console.log("✓\n");

  return completeData.slug;
}

async function main() {
  const args = process.argv.slice(2);
  
  let inputFile, startTime, duration, slug;
  
  if (args.length >= 3) {
    // Command line mode
    [inputFile, startTime, duration, slug] = args;
  } else {
    // Interactive mode
    console.log("🎬 Tajarib Local Cutter\n");
    
    inputFile = await question("Video file path: ");
    if (!fs.existsSync(inputFile)) {
      console.error("❌ File not found");
      process.exit(1);
    }
    
    console.log("\n⏱️  Use HH:MM:SS or seconds");
    const startStr = await question("Start time (e.g., 00:05:30 or 330): ");
    startTime = parseTime(startStr);
    
    const durationStr = await question("Duration in seconds (e.g., 45): ");
    duration = parseInt(durationStr);
    
    const defaultSlug = path.basename(inputFile, path.extname(inputFile)) + "-clip-" + startTime;
    slug = await question(`Slug [${defaultSlug}]: `);
    if (!slug) slug = defaultSlug;
  }

  if (!fs.existsSync(inputFile)) {
    console.error("❌ File not found:", inputFile);
    process.exit(1);
  }

  const guest = await question("Guest name (Arabic): ");
  const role = await question("Guest role: ");
  
  // Create temp output
  const tempDir = path.join(require("os").tmpdir(), "tajarib-cuts");
  fs.mkdirSync(tempDir, { recursive: true });
  const outputFile = path.join(tempDir, `${slug}.mp4`);

  try {
    // Cut locally
    await cutVideo(inputFile, parseTime(startTime), parseInt(duration), outputFile);
    
    const outputSize = fs.statSync(outputFile).size;
    const inputSize = fs.statSync(inputFile).size;
    const savings = ((1 - outputSize / inputSize) * 100).toFixed(1);
    
    console.log(`💾 Space saved: ${savings}% (${(inputSize / 1024 / 1024 / 1024).toFixed(1)}GB → ${(outputSize / 1024 / 1024).toFixed(1)}MB)\n`);

    // Upload
    const uploadedSlug = await uploadClip(outputFile, slug, guest, role);
    
    console.log(`✅ Done! Clip uploaded as: ${uploadedSlug}`);
    console.log(`🌐 Dashboard: ${DASHBOARD_URL}`);
    
    // Cleanup
    fs.unlinkSync(outputFile);
    console.log("🧹 Local temp file cleaned up");
    
  } catch (err) {
    console.error("\n❌ Error:", err.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
