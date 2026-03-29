/**
 * Publishing — video compression, Zapier webhooks, Buffer API integration.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MAX_PUBLISH_SIZE = 95 * 1024 * 1024; // 95MB

module.exports = function init(ctx) {
  const { io, EPISODES_DIR, loadMeta, buffer } = ctx;

  function compressForPublish(videoPath, slug) {
    return new Promise((resolve, reject) => {
      const stat = fs.statSync(videoPath);
      if (stat.size <= MAX_PUBLISH_SIZE) {
        console.log(`[Compress] ${slug}: ${(stat.size/1024/1024).toFixed(1)}MB — already under limit, skipping`);
        return resolve(videoPath);
      }

      const dir = path.dirname(videoPath);
      const compressedPath = path.join(dir, "publish-compressed.mp4");

      if (fs.existsSync(compressedPath)) {
        const cStat = fs.statSync(compressedPath);
        if (cStat.size <= MAX_PUBLISH_SIZE && cStat.size > 0) {
          console.log(`[Compress] ${slug}: reusing existing compressed file (${(cStat.size/1024/1024).toFixed(1)}MB)`);
          return resolve(compressedPath);
        }
        fs.unlinkSync(compressedPath);
      }

      const { execFileSync } = require("child_process");
      let duration;
      try {
        const probe = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", videoPath], { encoding: "utf8" });
        duration = parseFloat(JSON.parse(probe).format.duration);
      } catch (e) { return reject(new Error("Could not probe video duration")); }

      const targetBytes = 90 * 1024 * 1024;
      const targetBitrate = Math.floor((targetBytes * 8) / duration / 1000);
      const audioBitrate = 128;
      const videoBitrate = Math.max(500, targetBitrate - audioBitrate);

      console.log(`[Compress] ${slug}: ${(stat.size/1024/1024).toFixed(1)}MB → target ${videoBitrate}k video + ${audioBitrate}k audio (${duration.toFixed(1)}s)`);
      io.emit("log", { slug, text: `\n🗜️ Compressing for publish: ${(stat.size/1024/1024).toFixed(0)}MB → ~90MB target...\n` });

      const ffArgs = ["-i", videoPath, "-c:v", "libx264", "-b:v", `${videoBitrate}k`,
        "-maxrate", `${Math.floor(videoBitrate * 1.5)}k`, "-bufsize", `${videoBitrate * 2}k`,
        "-preset", "fast", "-c:a", "aac", "-b:a", `${audioBitrate}k`,
        "-movflags", "+faststart", "-y", compressedPath];

      const proc = spawn("ffmpeg", ffArgs, { cwd: dir });
      proc.stderr.on("data", d => {
        const line = d.toString();
        if (line.includes("frame=") || line.includes("time=")) io.emit("log", { slug, text: line });
      });
      proc.on("error", err => reject(new Error(`ffmpeg failed to start: ${err.message}`)));
      proc.on("close", code => {
        if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));
        const finalMB = (fs.statSync(compressedPath).size / 1024 / 1024).toFixed(1);
        console.log(`[Compress] ${slug}: compressed to ${finalMB}MB`);
        io.emit("log", { slug, text: `\n✅ Compressed: ${finalMB}MB\n` });
        resolve(compressedPath);
      });
    });
  }

  async function publishViaZapier(slug, caption, videoPath) {
    const ZAPIER_WEBHOOK_URL = "https://hooks.zapier.com/hooks/catch/25372282/uc0sion/";
    const meta = loadMeta(slug);
    const dir = path.join(EPISODES_DIR, slug);
    const compressedPath = path.join(dir, "publish-compressed.mp4");
    let videoType;
    if (fs.existsSync(compressedPath)) videoType = "compressed";
    else videoType = meta.mediaType === "reel_full" ? "raw" : "subtitled";
    const videoUrl = `http://76.13.145.146:7430/api/video?slug=${slug}&type=${videoType}`;

    const res = await fetch(ZAPIER_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, caption, videoUrl, videoFilename: path.basename(videoPath), timestamp: new Date().toISOString(), source: "tajarib-dashboard" })
    });
    if (!res.ok) throw new Error(`Zapier webhook failed: ${res.status}`);
    return { success: true, service: "zapier" };
  }

  async function publishViaBuffer(slug, caption, videoPath, bufferMode, channelIds) {
    const sizeMB = (require("fs").statSync(videoPath).size / 1024 / 1024).toFixed(1);
    io.emit("log", { slug, text: `\n📤 Uploading ${sizeMB}MB video to temp host...\n` });
    const publicVideoUrl = await buffer.uploadToTempHost(videoPath);
    console.log(`[Buffer] Uploaded to: ${publicVideoUrl}`);
    io.emit("log", { slug, text: `✅ Uploaded: ${publicVideoUrl}\n` });
    io.emit("toast", { type: "success", message: "Upload done — posting to Buffer channels..." });
    const results = await buffer.publish({ caption, videoUrl: publicVideoUrl, mode: bufferMode, channelIds });
    const failed = results.filter(r => !r.success);
    if (failed.length > 0 && failed.length === results.length) {
      throw new Error(`All Buffer posts failed: ${failed.map(f => `${f.service}: ${f.error}`).join("; ")}`);
    }
    return { success: true, service: "buffer", results };
  }

  return { compressForPublish, publishViaZapier, publishViaBuffer };
};
