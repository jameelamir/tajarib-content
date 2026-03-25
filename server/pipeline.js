/**
 * Pipeline step execution — spawns child processes, parallel per-reel processing.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

module.exports = function init(ctx) {
  const { io, WORKSPACE_DIR, EPISODES_DIR, PYTHON_BIN, NODE_BIN,
    activeProcesses, activeSteps, loadJSON, loadMeta, saveMeta, handlePostTranscription, getTranscriptionConfig } = ctx;

  function spawnReelStep(slug, reelId, step, opts = {}) {
    return new Promise((resolve) => {
      const dir = path.join(EPISODES_DIR, slug);
      let cmd = NODE_BIN, args;
      switch (step) {
        case "subtitle": args = ["subtitle.js", "--slug", slug, "--reel-id", reelId, "--force"]; if (opts.subtitleStyle) args.push("--subtitle-style", opts.subtitleStyle); break;
        case "overlay": {
          const hasConfig = fs.existsSync(path.join(dir, "overlay-config.json"));
          args = ["overlay.js", "--slug", slug, hasConfig ? "--config" : "--all", "--reel-id", reelId, "--force"]; break;
        }
        case "crop":
          args = ["crop.js", "--slug", slug, "--reel-id", reelId, "--force"];
          if (opts.ratio) args.push("--ratio", opts.ratio);
          if (opts.faceTrack) args.push("--face-track");
          break;
        default: resolve(-1); return;
      }
      const proc = spawn(cmd, args, { cwd: WORKSPACE_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      // Track with slug:reelId key so stop handler can find and kill all reel processes
      const procKey = `${slug}:${reelId}`;
      activeProcesses[procKey] = proc;
      proc.stdout.on("data", d => io.emit("log", { slug, reelId, text: d.toString() }));
      proc.stderr.on("data", d => io.emit("log", { slug, reelId, text: d.toString() }));
      proc.on("error", (err) => { delete activeProcesses[procKey]; io.emit("log", { slug, reelId, text: `❌ ${step} failed to start: ${err.message}\n` }); resolve(-1); });
      proc.on("close", (code) => { delete activeProcesses[procKey]; resolve(code); });
    });
  }

  async function runReelChain(slug, reelId, opts = {}) {
    const steps = opts.steps || ["subtitle", "overlay", "crop"];
    io.emit("log", { slug, reelId, text: `\n▶ Reel ${reelId}: starting chain [${steps.join(" → ")}]\n` });
    for (const step of steps) {
      io.emit("log", { slug, reelId, text: `\n── Reel ${reelId}: ${step} ──\n` });
      const code = await spawnReelStep(slug, reelId, step, opts);
      if (code !== 0) {
        io.emit("log", { slug, reelId, text: `\n❌ Reel ${reelId}: ${step} failed (exit ${code}), skipping remaining steps\n` });
        return { reelId, success: false, failedStep: step, code };
      }
    }
    io.emit("log", { slug, reelId, text: `\n✅ Reel ${reelId}: chain complete\n` });
    return { reelId, success: true };
  }

  async function runReelsParallel(slug, opts = {}) {
    const maxConcurrent = opts.maxConcurrent || 3;
    const analysisPath = path.join(EPISODES_DIR, slug, "analysis.json");
    if (!fs.existsSync(analysisPath)) { io.emit("log", { slug, text: "❌ No analysis.json found. Run analyze first.\n" }); return; }
    const analysis = loadJSON(analysisPath);
    const reelIds = (analysis.reels || []).map(r => r.id);
    if (reelIds.length === 0) { io.emit("log", { slug, text: "⚠️ No reels found in analysis.\n" }); return; }

    activeSteps[slug] = "process-reels";
    io.emit("process-start", { slug, step: "process-reels" });
    io.emit("log", { slug, text: `\n🚀 Processing ${reelIds.length} reels in parallel (max ${maxConcurrent} concurrent)\n` });

    const results = [], executing = new Set();
    for (const reelId of reelIds) {
      const p = runReelChain(slug, reelId, opts).then(r => { executing.delete(p); return r; });
      executing.add(p); results.push(p);
      if (executing.size >= maxConcurrent) await Promise.race(executing);
    }
    const settled = await Promise.allSettled(results);
    const succeeded = settled.filter(r => r.status === "fulfilled" && r.value.success).length;
    const failed = settled.filter(r => r.status === "fulfilled" && !r.value.success).length;

    delete activeSteps[slug];
    io.emit("log", { slug, text: `\n${"═".repeat(40)}\n✅ Done: ${succeeded}/${reelIds.length} reels succeeded${failed > 0 ? `, ${failed} failed` : ''}\n` });
    io.emit("process-end", { slug, step: "process-reels", code: failed > 0 ? 1 : 0 });
    io.emit("status-update", {});
  }

  const stepQueue = {}; // per-procKey queue of pending steps

  function runStep(params) {
    const { slug, step, reelId } = params;
    const procKey = reelId ? `${slug}:${reelId}` : slug;
    if (activeProcesses[procKey]) {
      // Queue instead of rejecting
      if (!stepQueue[procKey]) stepQueue[procKey] = [];
      stepQueue[procKey].push(params);
      const pos = stepQueue[procKey].length;
      io.emit("log", { slug, reelId: reelId || null, text: `\n⏳ Queued: ${step} (#${pos} in queue)\n` });
      io.emit("toast", { type: "info", message: `${step} queued — will run after current step` });
      return;
    }
    _runStep(params);
  }

  function _runStep({ slug, step, force, more, mediaType, guest, role, model, ratio, faceTrack, reelId, preferSide, resume, resumeRound, burnOnly, subtitleStyle, noTranscribe, youtubeOnly, topic }) {
    const procKey = reelId ? `${slug}:${reelId}` : slug;
    const dir = path.join(EPISODES_DIR, slug);
    let cmd, args;
    let videoFile = "raw.mp4";
    const found = fs.readdirSync(dir).find(f => /\.(mp4|mkv|mov|avi|mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && !f.includes("reel") && !f.includes("final"));
    if (found) videoFile = found;

    switch (step) {
      case "transcribe":
        if (!found) { io.emit("toast", { type: "error", message: `No video/audio in ${slug}/` }); return; }
        cmd = PYTHON_BIN; args = ["-u", "transcribe.py", path.join("episodes", slug, videoFile), "--slug", slug];
        if (force) args.push("--force");
        const tcfg = getTranscriptionConfig();
        let tMethod = tcfg.defaultMethod || (tcfg.groqApiKey ? "groq" : "local");
        // Fall back to local if selected method has no key
        if (tMethod === "groq" && !tcfg.groqApiKey) { tMethod = "local"; io.emit("log", { slug, text: "⚠ Groq selected but no API key — falling back to local\n" }); }
        if (tMethod === "api" && !tcfg.apiKey) { tMethod = "local"; io.emit("log", { slug, text: "⚠ Haimaker selected but no API key — falling back to local\n" }); }
        if (tMethod === "groq") { args.push("--groq"); io.emit("log", { slug, text: "Using Groq API (whisper-large-v3) for transcription...\n" }); }
        else if (tMethod === "api") { args.push("--api"); io.emit("log", { slug, text: "Using Haimaker API for transcription...\n" }); }
        else { if (tcfg.localModel && tcfg.localModel !== "large-v3") args.push("--model", tcfg.localModel); }
        break;
      case "analyze": cmd = NODE_BIN; args = ["analyze.js", "--slug", slug]; if (topic) args.push("--topic", topic); else if (more) args.push("--more"); else if (force) args.push("--force"); if (resume) args.push("--resume"); break;
      case "analyze-clips": cmd = NODE_BIN; args = ["analyze-clips.js", "--slug", slug]; if (force) args.push("--force"); if (resume) args.push("--resume"); break;
      case "generate": cmd = NODE_BIN; { const extraArgs = (mediaType !== "episode") ? ["--reel-only"] : []; const modelArgs = model ? ["--model", model] : []; args = ["generate.js", "--slug", slug, "--guest", guest, "--role", role, ...extraArgs, ...modelArgs]; if (reelId) args.push("--reel-id", reelId); if (youtubeOnly) args.push("--youtube-only"); if (force) args.push("--force"); if (resume) { args.push("--resume", "--resume-round", String(resumeRound || 0)); } } break;
      case "cut":
        if (!found) { io.emit("toast", { type: "error", message: `No video in ${slug}/` }); return; }
        cmd = NODE_BIN; args = ["cut.js", "--slug", slug, "--video", path.join(dir, videoFile)]; if (reelId) args.push("--reel-id", reelId); if (force) args.push("--force"); break;
      case "crop": cmd = NODE_BIN; args = ["crop.js", "--slug", slug]; if (ratio) args.push("--ratio", ratio); if (faceTrack) args.push("--face-track"); if (reelId) args.push("--reel-id", reelId); if (preferSide) args.push("--prefer-side", preferSide); if (force) args.push("--force"); break;
      case "subtitle": cmd = NODE_BIN; args = ["subtitle.js", "--slug", slug]; if (reelId) args.push("--reel-id", reelId); if (force) args.push("--force"); if (burnOnly) args.push("--burn-only"); if (noTranscribe) args.push("--no-transcribe"); if (subtitleStyle) args.push("--subtitle-style", subtitleStyle); break;
      case "overlay": { cmd = NODE_BIN; const hasConfig = fs.existsSync(path.join(dir, "overlay-config.json")); args = ["overlay.js", "--slug", slug, hasConfig ? "--config" : "--all"]; if (reelId) args.push("--reel-id", reelId); if (force) args.push("--force"); break; }
      case "compose": cmd = NODE_BIN; args = ["compose.js", "--slug", slug]; if (force) args.push("--force"); if (resume) args.push("--resume"); if (!fs.existsSync(path.join(dir, "switches.json"))) args.push("--ai-switch"); break;
      default: io.emit("toast", { type: "error", message: `Unknown step: ${step}` }); return;
    }

    activeSteps[procKey] = step;
    const _rid = reelId || null;
    io.emit("log", { slug, reelId: _rid, text: `\n▶ Running: ${step}${_rid ? ' (reel ' + _rid + ')' : ''}\n` });
    io.emit("log", { slug, reelId: _rid, text: `   Command: ${cmd} ${args.join(" ")}\n` });
    io.emit("log", { slug, reelId: _rid, text: `   Working dir: ${WORKSPACE_DIR}\n` });
    io.emit("log", { slug, reelId: _rid, text: `   Starting process...\n\n` });
    io.emit("process-start", { slug, step, reelId: _rid });

    console.log(`[Spawning] ${cmd} ${args.join(" ")} in ${WORKSPACE_DIR}`);
    console.log(`[DEBUG] slug=${slug}, step=${step}, io.connected sockets=${io.engine?.clientsCount || 'unknown'}`);

    const proc = spawn(cmd, args, { cwd: WORKSPACE_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    activeProcesses[procKey] = proc;
    let stdoutBuffer = '', stderrBuffer = '', outputSent = false;

    proc.on("error", (err) => {
      console.error(`[Spawn Error] ${err.message}`);
      io.emit("log", { slug, text: `\n❌ Failed to start process: ${err.message}\n` });
      io.emit("process-end", { slug, step, code: -1, reelId: _rid });
      delete activeProcesses[procKey]; delete activeSteps[procKey];
    });

    let heartbeatTimer = null, gotFirstOutput = false;
    if (step === "transcribe") {
      heartbeatTimer = setInterval(() => { if (!gotFirstOutput) io.emit("log", { slug, text: `⏳ Loading Whisper model... (this can take up to a minute)\n` }); }, 10000);
    }

    proc.stdout.on("data", d => { gotFirstOutput = true; outputSent = true; if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } const text = d.toString(); stdoutBuffer += text; io.emit("log", { slug, reelId: _rid, text }); });
    proc.stderr.on("data", d => { gotFirstOutput = true; outputSent = true; if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } const text = d.toString(); stderrBuffer += text; io.emit("log", { slug, reelId: _rid, text }); });
    proc.stdout.on("end", () => { if (stdoutBuffer && !outputSent) io.emit("log", { slug, text: stdoutBuffer }); });
    proc.stderr.on("end", () => { if (stderrBuffer && !outputSent) io.emit("log", { slug, text: stderrBuffer }); });

    proc.on("close", async (code) => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      delete activeProcesses[procKey]; delete activeSteps[procKey];

      if (code === 42) {
        const promptPath = path.join(EPISODES_DIR, slug, "llm-prompt.json");
        if (fs.existsSync(promptPath)) {
          const promptData = loadJSON(promptPath);
          io.emit("log", { slug, text: `\n📋 Manual LLM mode — paste the response in the popup\n` });
          io.emit("llm-prompt", { slug, step, ...promptData });
        } else {
          io.emit("log", { slug, text: `\n❌ Exit 42 but no llm-prompt.json found\n` });
        }
        io.emit("process-end", { slug, step, code: 42, reelId: _rid });
        return;
      }

      io.emit("log", { slug, reelId: _rid, text: `\nExit code: ${code}\n${"─".repeat(40)}\n` });
      if (step === "crop" && code === 0 && ratio) saveMeta(slug, { cropRatio: ratio });
      io.emit("process-end", { slug, step, code, reelId: _rid });
      io.emit("status-update", {});
      if (step === "transcribe" && code === 0) await handlePostTranscription(slug);

      // Drain queue — run next queued step for this procKey
      if (stepQueue[procKey] && stepQueue[procKey].length > 0) {
        const next = stepQueue[procKey].shift();
        if (stepQueue[procKey].length === 0) delete stepQueue[procKey];
        io.emit("log", { slug, reelId: _rid, text: `\n▶ Running queued step: ${next.step}\n` });
        _runStep(next);
      }
    });
  }

  return { runStep, runReelsParallel, spawnReelStep, runReelChain };
};
