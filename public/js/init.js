// ── Initialization ───────────────────────────────────────────────────────────

// Initialize
async function init() {
    console.log('🚀 init() starting...');
    await setupProfiles();
    await loadGuestHistory();
    await loadTranscriptionConfig();
    await loadGenKeyStatus();
    loadVersionChip();
    console.log('✅ loadGuestHistory done, calling refresh...');
    await refresh();
    console.log('✅ refresh done, episodes:', episodes.length);

    // Restore guest filter from localStorage
    var savedGuestFilter = localStorage.getItem('tajarib-guest-filter');
    if (savedGuestFilter) {
        var filterInput = document.getElementById('ep-guest-filter');
        if (filterInput) filterInput.value = savedGuestFilter;
        setGuestFilter(savedGuestFilter);
    }

    // Restore selected episode and reel from URL params (deep-link share), then
    // fall back to localStorage. URL params let us send "?slug=X&reel=Y" links
    // to editors so they land on the exact reel.
    var urlParams = new URLSearchParams(window.location.search);
    var urlSlug = urlParams.get('slug');
    var urlReel = urlParams.get('reel');
    var savedSlug = urlSlug || localStorage.getItem('tajarib-selected-slug');
    var savedReel = urlReel || localStorage.getItem('tajarib-selected-reel');
    if (urlSlug || urlReel) {
        // Strip params so a later refresh doesn't keep overriding navigation.
        history.replaceState({}, '', window.location.pathname);
    }
    if (savedSlug && episodes.find(function(e) { return e.slug === savedSlug; })) {
        selectEp(savedSlug);
        if (savedReel) {
            var ep = episodes.find(function(e) { return e.slug === savedSlug; });
            if (ep && ep.reelStatuses && ep.reelStatuses.find(function(r) { return r.id === savedReel; })) {
                selectReel(savedReel);
            }
        }
    }

    setInterval(refresh, 5000);
    loadStorageInfo();
    loadPendingUploads();
}

// Setup socket handlers
setupSocketHandlers();

// Run syncSettingsDots periodically so header dots stay fresh
setInterval(syncSettingsDots, 1000);

// Restore collapsed sidebar sections
['publishing','transcription','storage'].forEach(function(name) {
    const saved = localStorage.getItem('tajarib-section-' + name);
    if (saved === 'true') {
        const el = document.getElementById('section-' + name);
        if (el) el.classList.add('open');
    }
});

// Restore saved default media type on load
(function restoreMediaType() {
    const saved = localStorage.getItem('tajarib-default-media');
    if (saved) setMediaType(saved);
})();

// Sync video quality toggle button to persisted state
(function initVideoQualityToggle() {
    const btn = document.getElementById('video-quality-toggle');
    if (btn) updateVideoQualityToggle(btn);
})();

// Upload Zone DOM bindings
document.getElementById('upload-zone').onclick = function(e) {
    if (e.target === this || e.target.parentElement === this) {
        document.getElementById('file-input').click();
    }
};

const dropZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');

dropZone.ondragenter = dropZone.ondragover = function(e) {
    e.preventDefault();
    this.classList.add('dragover');
};
dropZone.ondragleave = dropZone.ondrop = function(e) {
    e.preventDefault();
    this.classList.remove('dragover');
};
dropZone.ondrop = function(e) {
    const file = e.dataTransfer.files[0];
    if (file) startUploadFlow(file);
};

fileInput.onchange = function() {
    if (this.files[0]) startUploadFlow(this.files[0]);
    this.value = '';
};

document.getElementById('url-input').onkeydown = function(e) {
    if (e.key === 'Enter') startUrlUploadFlow();
};

document.body.ondragover = e => e.preventDefault();
document.body.ondrop = function(e) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && /\.(mp4|mkv|mov|avi)$/i.test(file.name)) startUploadFlow(file);
};

// Init publish method UI
setPublishMethod(publishMethod);
setBufferMode(bufferMode);
loadBufferConfig();

// Stop button (unified in pipeline bar)
var pipelineStopBtn = document.getElementById('pipeline-stop-btn');
if (pipelineStopBtn) pipelineStopBtn.onclick = function() {
    if (currentSlug) socket.emit('stop-step', {slug: currentSlug});
};

// Start the app
init();
