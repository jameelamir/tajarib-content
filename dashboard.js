#!/usr/bin/env node
/**
 * Tajarib Pipeline Dashboard
 * Run: node dashboard.js
 * Visit: http://76.13.145.146:3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const EPISODES_DIR = path.join(__dirname, "episodes");
const FORMATS_DIR = path.join(__dirname, "formats");

function getEpisodes() {
  if (!fs.existsSync(EPISODES_DIR)) return [];
  return fs.readdirSync(EPISODES_DIR)
    .filter(d => fs.statSync(path.join(EPISODES_DIR, d)).isDirectory())
    .map(slug => {
      const dir = path.join(EPISODES_DIR, slug);
      const transcript = fs.existsSync(path.join(dir, "transcript.json"))
        ? JSON.parse(fs.readFileSync(path.join(dir, "transcript.json"), "utf8"))
        : null;
      const analysis = fs.existsSync(path.join(dir, "analysis.json"))
        ? JSON.parse(fs.readFileSync(path.join(dir, "analysis.json"), "utf8"))
        : null;
      const content = fs.existsSync(path.join(dir, "content.json"))
        ? JSON.parse(fs.readFileSync(path.join(dir, "content.json"), "utf8"))
        : null;
      const reelsDir = path.join(dir, "reels");
      const reelFiles = fs.existsSync(reelsDir)
        ? fs.readdirSync(reelsDir).filter(f => f.endsWith(".mp4"))
        : [];
      const finalDir = path.join(dir, "final");
      const finalFiles = fs.existsSync(finalDir)
        ? fs.readdirSync(finalDir).filter(f => f.endsWith(".mp4"))
        : [];

      return {
        slug,
        transcript: transcript ? { ok: true, duration: Math.round(transcript.duration_seconds / 60), words: transcript.word_count } : null,
        analysis: analysis ? { ok: true, cuts: analysis.cuts?.length || 0, reels: analysis.reels?.length || 0, chapters: analysis.chapters?.length || 0, tokens: analysis.tokens?.total || 0 } : null,
        content: content ? { ok: true, titles: content.youtube_titles?.length || 0, reels: content.reels?.length || 0, tokens: content.total_tokens_used || 0, guest: content.guest, role: content.role } : null,
        cut: { ok: reelFiles.length > 0, count: reelFiles.length },
        overlay: { ok: finalFiles.length > 0, count: finalFiles.length }
      };
    });
}

function stepBadge(step, label) {
  if (!step) return `<span class="badge pending">— ${label}</span>`;
  if (step.ok === false) return `<span class="badge error">❌ ${label}</span>`;
  return `<span class="badge done">✅ ${label}</span>`;
}

function getFormats() {
  if (!fs.existsSync(FORMATS_DIR)) return [];
  return fs.readdirSync(FORMATS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => ({
      name: f.replace(".md", ""),
      content: fs.readFileSync(path.join(FORMATS_DIR, f), "utf8"),
      modified: fs.statSync(path.join(FORMATS_DIR, f)).mtime.toISOString()
    }));
}

function episodeDetailJSON(slug) {
  const dir = path.join(EPISODES_DIR, slug);
  const files = ["transcript.json", "analysis.json", "content.json"];
  const out = {};
  for (const f of files) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      // Truncate heavy fields for display
      if (f === "transcript.json") {
        out[f] = { ...data, segments: `[${data.segments?.length} segments — truncated]`, words: `[${data.words?.length} words — truncated]`, full_text: data.full_text?.slice(0, 500) + "..." };
      } else {
        out[f] = data;
      }
    }
  }
  return out;
}

function html() {
  const episodes = getEpisodes();
  const formats = getFormats();
  const totalTokens = episodes.reduce((sum, ep) => {
    return sum + (ep.analysis?.tokens || 0) + (ep.content?.tokens || 0);
  }, 0);

  const rows = episodes.map(ep => `
    <tr onclick="showDetail('${ep.slug}')" style="cursor:pointer">
      <td><code>${ep.slug}</code></td>
      <td>${ep.content?.guest || "—"}</td>
      <td>${ep.transcript ? `✅ ${ep.transcript.duration} min` : "—"}</td>
      <td>${ep.analysis ? `✅ ${ep.analysis.reels} reels / ${ep.analysis.cuts} cuts` : "—"}</td>
      <td>${ep.content ? `✅ ${ep.content.reels} captions` : "—"}</td>
      <td>${ep.cut.ok ? `✅ ${ep.cut.count} files` : "—"}</td>
      <td>${ep.overlay.ok ? `✅ ${ep.overlay.count} files` : "—"}</td>
      <td>${((ep.analysis?.tokens || 0) + (ep.content?.tokens || 0)).toLocaleString()}</td>
    </tr>
  `).join("") || `<tr><td colspan="8" style="text-align:center;color:#555;padding:40px">No episodes yet. Drop a video into episodes/ and run transcribe.py</td></tr>`;

  const formatCards = formats.map(f => `
    <div class="format-card">
      <div class="format-header">
        <strong>${f.name}</strong>
        <span class="format-date">Updated: ${f.modified.slice(0, 10)}</span>
      </div>
      <pre class="format-body">${f.content.replace(/</g, "&lt;").slice(0, 800)}${f.content.length > 800 ? "\n[...]" : ""}</pre>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>Tajarib Pipeline</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #eee; }
    .header { background: #111; border-bottom: 1px solid #222; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    .header h1 { color: #a855f7; font-size: 1.3rem; }
    .header .sub { color: #555; font-size: 0.8rem; }
    .stats-bar { display: flex; gap: 24px; padding: 16px 24px; background: #111; border-bottom: 1px solid #1a1a1a; flex-wrap: wrap; }
    .stat { text-align: center; }
    .stat .val { font-size: 1.5rem; font-weight: 700; color: #a855f7; }
    .stat .lbl { font-size: 0.7rem; color: #555; text-transform: uppercase; letter-spacing: 1px; }
    .tabs { display: flex; gap: 0; border-bottom: 1px solid #222; background: #111; }
    .tab { padding: 12px 24px; cursor: pointer; color: #666; font-size: 0.85rem; border-bottom: 2px solid transparent; }
    .tab.active { color: #a855f7; border-bottom-color: #a855f7; }
    .tab:hover { color: #ddd; }
    .section { display: none; padding: 24px; }
    .section.active { display: block; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { background: #1a1a1a; padding: 10px 12px; text-align: left; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; color: #666; position: sticky; top: 0; }
    td { padding: 10px 12px; border-bottom: 1px solid #1a1a1a; vertical-align: middle; }
    tr:hover td { background: #131313; }
    .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; }
    .badge.done { background: #0d2b0d; color: #4ade80; }
    .badge.error { background: #2b0d0d; color: #f87171; }
    .badge.pending { background: #1a1a1a; color: #555; }
    .format-card { background: #1a1a1a; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
    .format-header { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #222; }
    .format-date { color: #555; font-size: 0.75rem; }
    .format-body { padding: 16px; font-size: 0.8rem; color: #aaa; white-space: pre-wrap; overflow-x: auto; }
    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 100; padding: 40px; overflow-y: auto; }
    .modal.open { display: block; }
    .modal-inner { background: #1a1a1a; border-radius: 12px; max-width: 900px; margin: 0 auto; overflow: hidden; }
    .modal-header { padding: 16px 20px; background: #111; display: flex; justify-content: space-between; align-items: center; }
    .modal-body { padding: 20px; }
    pre { background: #111; border-radius: 6px; padding: 16px; overflow-x: auto; font-size: 0.78rem; color: #ccc; white-space: pre-wrap; }
    .close-btn { background: #333; border: none; color: #aaa; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
    .close-btn:hover { background: #555; }
    code { background: #222; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; color: #a855f7; }
  </style>
</head>
<body>

<div class="header">
  <div>
    <h1>🎙️ Tajarib Pipeline</h1>
    <div class="sub">Auto-refreshes every 15s · ${new Date().toLocaleString()}</div>
  </div>
</div>

<div class="stats-bar">
  <div class="stat"><div class="val">${episodes.length}</div><div class="lbl">Episodes</div></div>
  <div class="stat"><div class="val">${episodes.filter(e => e.transcript).length}</div><div class="lbl">Transcribed</div></div>
  <div class="stat"><div class="val">${episodes.filter(e => e.analysis).length}</div><div class="lbl">Analyzed</div></div>
  <div class="stat"><div class="val">${episodes.filter(e => e.content).length}</div><div class="lbl">Generated</div></div>
  <div class="stat"><div class="val">${episodes.filter(e => e.cut.ok).length}</div><div class="lbl">Cut</div></div>
  <div class="stat"><div class="val">${totalTokens.toLocaleString()}</div><div class="lbl">Total Tokens</div></div>
</div>

<div class="tabs">
  <div class="tab active" onclick="switchTab('episodes', this)">📁 Episodes</div>
  <div class="tab" onclick="switchTab('formats', this)">📝 Formats</div>
  <div class="tab" onclick="switchTab('howto', this)">⚡ How to Run</div>
</div>

<div id="episodes" class="section active">
  <table>
    <thead>
      <tr>
        <th>Slug</th>
        <th>Guest</th>
        <th>1. Transcribe</th>
        <th>2. Analyze</th>
        <th>3. Generate</th>
        <th>4. Cut</th>
        <th>5. Overlay</th>
        <th>Tokens</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#555;font-size:0.75rem;margin-top:12px">💡 Click any row to inspect its outputs.</p>
</div>

<div id="formats" class="section">
  <h2 style="margin-bottom:16px;color:#a855f7;font-size:1rem">📝 Active Format Specs</h2>
  <p style="color:#666;font-size:0.82rem;margin-bottom:20px">These are the live prompt formats used by generate.js. Edit them to refine output.</p>
  ${formatCards || '<p style="color:#555">No format files found in formats/</p>'}
</div>

<div id="howto" class="section">
  <h2 style="margin-bottom:16px;color:#a855f7;font-size:1rem">⚡ How to Run</h2>
  <pre># Step 1: Transcribe (Python — word-level timestamps)
cd /root/.openclaw/workspace/tajarib
.venv/bin/python3 transcribe.py /path/to/episode.mp4 --slug my-episode

# Step 2: Analyze (Claude AI — cuts, reels, chapters)
node analyze.js --slug my-episode

# Step 3: Generate captions + YouTube content
node generate.js --slug my-episode --guest "اسم الضيف" --role "المنصب"

# Step 4: Cut reels (FFmpeg)
node cut.js --slug my-episode

# Run from a specific step (skips completed steps unless --force)
node pipeline.js --slug my-episode --from transcribe
node pipeline.js --slug my-episode --from analyze
node pipeline.js --slug my-episode --from generate

# Force re-run a specific step
node analyze.js --slug my-episode --force
node generate.js --slug my-episode --guest "..." --role "..." --force</pre>
</div>

<!-- Detail Modal -->
<div class="modal" id="modal">
  <div class="modal-inner">
    <div class="modal-header">
      <strong id="modal-title">Episode Detail</strong>
      <button class="close-btn" onclick="closeModal()">✕ Close</button>
    </div>
    <div class="modal-body">
      <pre id="modal-content">Loading...</pre>
    </div>
  </div>
</div>

<script>
function switchTab(id, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
}

function showDetail(slug) {
  document.getElementById('modal-title').textContent = '📁 ' + slug;
  document.getElementById('modal-content').textContent = 'Loading...';
  document.getElementById('modal').classList.add('open');
  fetch('/detail/' + encodeURIComponent(slug))
    .then(r => r.json())
    .then(d => {
      document.getElementById('modal-content').textContent = JSON.stringify(d, null, 2);
    });
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
</script>

</body>
</html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/episodes") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getEpisodes(), null, 2));
  } else if (req.url.startsWith("/detail/")) {
    const slug = decodeURIComponent(req.url.replace("/detail/", ""));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(episodeDetailJSON(slug), null, 2));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html());
  }
});

server.listen(3000, "0.0.0.0", () => {
  console.log("🎙️  Tajarib Pipeline Dashboard → http://76.13.145.146:3000");
});
