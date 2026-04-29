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
