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
