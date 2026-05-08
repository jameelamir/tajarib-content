// ── Global State ──────────────────────────────────────────────────────────────
const socket = io();
let episodes = [];
let currentSlug = null;
let currentFile = null;
let logs = {};
let runningStep = {};  // processKey (slug or slug:reelId) -> step name currently running

function isSlugRunning(slug) {
    if (runningStep[slug]) return true;
    for (var k in runningStep) { if (k.startsWith(slug + ':')) return true; }
    return false;
}

function isStepRunning(slug, stepId) {
    if (runningStep[slug] === stepId) return true;
    for (var k in runningStep) { if (k.startsWith(slug + ':') && runningStep[k] === stepId) return true; }
    return false;
}
let pendingRun = null;
let pendingFile = null;
let selectedMediaType = 'episode';
let contentEditorData = null;
let textEditorData = null;
let guestHistory = [];
let pendingSpeakerFile = null;
let pendingGuestFile = null;
let pendingSrtFile = null;
let pendingUrl = null;
let selectedReelId = null;
let transcriptDocked = false;
let reelLogs = {};
let storageData = null;
let storageSortBy = 'size';
let switchPointsData = [];
let overlayConfig = null;
let overlayDragging = null;
let overlayCanvasCtx = null;
let overlayCanvasRatio = '9:16';
let availableModels = [];
let modelListLoaded = false;
let modelValidationTimer = null;

// ── Video quality toggle ──────────────────────────────────────────────────────
// 'full' (default) or 'low'. When 'low', /api/video URLs are tagged with q=low;
// the server transcodes a 540p/CRF30 cached derivative on first request and
// falls back to the original until that derivative is ready. The client polls
// `&probe=1` so once ffmpeg finishes, the player swaps to the small file mid-
// session (otherwise the first watch would always pay the full-file cost).
let videoQuality = localStorage.getItem('tajarib-video-quality') === 'low' ? 'low' : 'full';

function videoQualityParam() {
    return videoQuality === 'low' ? '&q=low' : '';
}

function setVideoQuality(q) {
    videoQuality = q === 'low' ? 'low' : 'full';
    localStorage.setItem('tajarib-video-quality', videoQuality);
    refreshVisibleVideos();
    var btn = document.getElementById('video-quality-toggle');
    if (btn) updateVideoQualityToggle(btn);
}

function reloadVideoSrc(v) {
    try {
        var u = new URL(v.getAttribute('src') || '', location.origin);
        u.searchParams.set('t', Date.now());
        var resumeAt = v.currentTime;
        var wasPaused = v.paused;
        v.src = u.pathname + u.search;
        v.addEventListener('loadedmetadata', function once() {
            v.removeEventListener('loadedmetadata', once);
            try { if (resumeAt > 0) v.currentTime = resumeAt; } catch (e) {}
            if (!wasPaused) v.play().catch(function() {});
        });
    } catch (e) {}
}

// Poll the server until the .low.mp4 derivative is ready, then reload the
// video so the player switches from the original to the small file.
function attachLdProbe(v) {
    if (videoQuality !== 'low') return;
    var src = v.getAttribute('src') || '';
    if (src.indexOf('/api/video') === -1 || src.indexOf('q=low') === -1) return;
    if (v._ldProbeTimer) return;
    var attempts = 0;
    function poll() {
        v._ldProbeTimer = null;
        if (videoQuality !== 'low' || !v.isConnected) return;
        var u;
        try { u = new URL(v.getAttribute('src') || '', location.origin); } catch (e) { return; }
        if (u.searchParams.get('q') !== 'low') return;
        u.searchParams.set('probe', '1');
        u.searchParams.delete('t');
        fetch(u.pathname + u.search, { cache: 'no-store' })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (videoQuality !== 'low' || !v.isConnected) return;
                if (data && data.quality === 'low') {
                    reloadVideoSrc(v);
                } else if (data && data.quality === 'preparing' && attempts < 120) {
                    attempts++;
                    v._ldProbeTimer = setTimeout(poll, 5000);
                }
            })
            .catch(function() {
                if (attempts < 60) { attempts++; v._ldProbeTimer = setTimeout(poll, 10000); }
            });
    }
    v._ldProbeTimer = setTimeout(poll, 1500);
}

function refreshVisibleVideos() {
    document.querySelectorAll('video').forEach(function(v) {
        var src = v.getAttribute('src') || '';
        if (src.indexOf('/api/video') === -1) return;
        if (v._ldProbeTimer) { clearTimeout(v._ldProbeTimer); v._ldProbeTimer = null; }
        try {
            var u = new URL(src, location.origin);
            if (videoQuality === 'low') u.searchParams.set('q', 'low');
            else u.searchParams.delete('q');
            u.searchParams.set('t', Date.now());
            var resumeAt = v.currentTime;
            var wasPaused = v.paused;
            v.src = u.pathname + u.search;
            v.addEventListener('loadedmetadata', function once() {
                v.removeEventListener('loadedmetadata', once);
                try { if (resumeAt > 0) v.currentTime = resumeAt; } catch (e) {}
                if (!wasPaused) v.play().catch(function() {});
                attachLdProbe(v);
            });
        } catch (e) {}
    });
}

// Catch videos that load with q=low already in their src (page-load case where
// refreshVisibleVideos isn't triggered) — without this, first-watch never auto-
// swaps to the small file.
document.addEventListener('loadedmetadata', function(e) {
    var v = e.target;
    if (v && v.tagName === 'VIDEO') attachLdProbe(v);
}, true);

function updateVideoQualityToggle(btn) {
    var on = videoQuality === 'low';
    btn.textContent = on ? '📶 LD' : '📶 HD';
    btn.title = on
        ? 'Low-quality preview (saves data) — click for full quality'
        : 'Full quality — click to switch to low-quality preview';
    btn.style.background = on ? '#1f2d3d' : '#1a1a1a';
    btn.style.borderColor = on ? '#3a5a7a' : '#333';
    btn.style.color = on ? '#7dd3fc' : '#aaa';
}

// ── Prompt ownership ──────────────────────────────────────────────────────────
// The server broadcasts `llm-prompt` modals to every connected client (no
// per-user identity). This set tracks slugs *this* browser tab initiated
// action on, so multiple admins on the dashboard don't all get the same
// popup. Persisted to sessionStorage so a tab reload keeps its claims.
const myPromptSlugs = new Set(JSON.parse(sessionStorage.getItem('tajarib-prompt-slugs') || '[]'));

function _persistPromptSlugs() {
    try { sessionStorage.setItem('tajarib-prompt-slugs', JSON.stringify([...myPromptSlugs])); } catch (e) {}
}

function claimPromptSlug(slug) {
    if (!slug || typeof slug !== 'string') return;
    myPromptSlugs.add(slug);
    _persistPromptSlugs();
}

function dropPromptSlug(slug) {
    if (!slug) return;
    if (myPromptSlugs.delete(slug)) _persistPromptSlugs();
}

function ownsPromptSlug(slug) {
    // No slug = manual LLM dashboard tool, treat as local action and show.
    if (!slug) return true;
    return myPromptSlugs.has(slug);
}

// ── Hybrid-mode choice modal ─────────────────────────────────────────────────
// In hybrid LLM mode, every LLM-using step pops this modal so the user picks
// "AI" or "manual" once per step. Resolved via POST /api/llm-step-decision.
let pendingChoiceRequest = null;

function openLlmChoiceModal(data) {
    pendingChoiceRequest = data;
    const modal = document.getElementById('llm-choice-modal');
    const title = document.getElementById('llm-choice-title');
    const desc = document.getElementById('llm-choice-desc');
    if (title) title.textContent = `Run "${data.step}" with AI or fill in manually?`;
    if (desc) desc.textContent = data.description || '';
    if (modal) modal.classList.add('open');
}

function resolveLlmChoice(choice) {
    if (!pendingChoiceRequest) return;
    const requestId = pendingChoiceRequest.requestId;
    pendingChoiceRequest = null;
    const modal = document.getElementById('llm-choice-modal');
    if (modal) modal.classList.remove('open');
    fetch('/api/llm-step-decision', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ requestId, choice }),
    }).catch(err => console.error('llm-step-decision failed:', err));
}

// Auto-claim slug on outgoing fetch to pipeline endpoints. Covers
// /api/run-step, /api/feedback, /api/download-url. The XHR-based
// /api/upload path claims separately in upload.js.
(function patchFetchForPromptOwnership() {
    const origFetch = window.fetch.bind(window);
    const triggers = ['/api/run-step', '/api/feedback', '/api/upload', '/api/download-url'];
    window.fetch = async function(input, init) {
        const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
        const matches = triggers.some(p => urlStr.indexOf(p) !== -1);
        if (matches && init && typeof init.body === 'string') {
            try {
                const parsed = JSON.parse(init.body);
                if (parsed && parsed.slug) claimPromptSlug(parsed.slug);
            } catch (e) {}
        }
        const res = await origFetch(input, init);
        if (matches && (urlStr.indexOf('/api/upload') !== -1 || urlStr.indexOf('/api/download-url') !== -1)) {
            try {
                const data = await res.clone().json();
                if (data && data.slug) claimPromptSlug(data.slug);
            } catch (e) {}
        }
        return res;
    };
})();
