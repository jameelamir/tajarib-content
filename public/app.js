const socket = io();
let episodes = [];
let currentSlug = null;
let currentFile = null;
let logs = {};
let runningStep = {};  // slug -> step name currently running
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

// Initialize
async function init() {
    console.log('🚀 init() starting...');
    await loadGuestHistory();
    await loadTranscriptionConfig();
    await loadGenKeyStatus();
    console.log('✅ loadGuestHistory done, calling refresh...');
    await refresh();
    console.log('✅ refresh done, episodes:', episodes.length);

    // Restore selected episode and reel from localStorage
    var savedSlug = localStorage.getItem('tajarib-selected-slug');
    var savedReel = localStorage.getItem('tajarib-selected-reel');
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
}

// Transcription Config
let transcriptionConfig = { hasApiKey: false, defaultMethod: 'local' };

async function loadTranscriptionConfig() {
    try {
        const res = await fetch('/api/transcription-config');
        transcriptionConfig = await res.json();
        updateTranscriptionUI();
    } catch (e) {
        console.error('Failed to load transcription config:', e);
    }
}

function updateTranscriptionUI() {
    const dot = document.getElementById('api-status-dot');
    const text = document.getElementById('api-status-text');
    
    if (transcriptionConfig.hasApiKey) {
        dot.style.background = 'var(--success)';
        text.textContent = transcriptionConfig.defaultMethod === 'api' ? 'API Ready (Default)' : 'API Key Set';
        text.style.color = '#4ade80';
    } else {
        dot.style.background = '#f59e0b';
        text.textContent = 'Local Only';
        text.style.color = '#fbbf24';
    }
}

function openTranscriptionModal() {
    document.getElementById('transcription-modal').classList.add('open');
    document.getElementById('transcription-api-key').value = '';
    document.getElementById('transcription-default-method').value = transcriptionConfig.defaultMethod || 'local';
    document.getElementById('api-key-status').style.display = 'none';
}

function closeTranscriptionModal() {
    document.getElementById('transcription-modal').classList.remove('open');
}

async function saveTranscriptionConfig() {
    const apiKey = document.getElementById('transcription-api-key').value.trim();
    const defaultMethod = document.getElementById('transcription-default-method').value;
    const statusDiv = document.getElementById('api-key-status');
    
    const payload = { defaultMethod };
    if (apiKey) payload.apiKey = apiKey;
    
    try {
        const res = await fetch('/api/transcription-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (data.success) {
            transcriptionConfig.hasApiKey = data.hasApiKey;
            transcriptionConfig.defaultMethod = defaultMethod;
            updateTranscriptionUI();
            
            // Also update the default in upload modal
            const radio = document.querySelector(`input[name="transcribe-method"][value="${defaultMethod}"]`);
            if (radio) radio.checked = true;
            
            statusDiv.style.display = 'block';
            statusDiv.style.background = '#064e3b';
            statusDiv.style.color = '#6ee7b7';
            statusDiv.textContent = '✓ Settings saved successfully';
            
            setTimeout(() => {
                closeTranscriptionModal();
            }, 1000);
        }
    } catch (err) {
        statusDiv.style.display = 'block';
        statusDiv.style.background = '#7f1d1d';
        statusDiv.style.color = '#fca5a5';
        statusDiv.textContent = '✗ Failed to save: ' + err.message;
    }
}

// LLM Config (API key + base URL + model)
async function loadGenKeyStatus() {
    try {
        const res = await fetch('/api/llm-config');
        const data = await res.json();
        const dot = document.getElementById('gen-key-dot');
        const status = document.getElementById('gen-key-status');
        const toggle = document.getElementById('manual-mode-toggle');
        // Populate fields with current config (but not the key)
        if (data.baseUrl) document.getElementById('gen-base-url').value = data.baseUrl;
        if (data.model) document.getElementById('sidebar-model-select').value = data.model;
        if (toggle) toggle.checked = !!data.manualMode;
        if (data.manualMode) {
            dot.style.background = '#a78bfa';
            status.innerHTML = '📋 Manual mode — paste prompts into your own Claude';
            status.style.color = '#a78bfa';
        } else if (data.hasKey) {
            dot.style.background = 'var(--success)';
            const provider = data.baseUrl ? new URL(data.baseUrl).hostname : 'Anthropic direct';
            status.innerHTML = '✓ Connected — <span style="color:#888;">' + provider + '</span>';
            status.style.color = '#4ade80';
        } else {
            dot.style.background = '#f59e0b';
            status.textContent = 'No API key — set up a provider to enable generation';
            status.style.color = '#fbbf24';
        }
    } catch (e) {
        console.error('Failed to load LLM config:', e);
    }
}

async function saveLLMConfig() {
    const keyInput = document.getElementById('gen-api-key');
    const baseUrlInput = document.getElementById('gen-base-url');
    const modelInput = document.getElementById('sidebar-model-select');
    const status = document.getElementById('gen-key-status');

    const payload = {};
    const key = keyInput.value.trim();
    const baseUrl = baseUrlInput.value.trim();
    const model = modelInput.value.trim();

    // Only send key if user typed one (don't overwrite existing with empty)
    if (key) payload.apiKey = key;
    if (baseUrl !== undefined) payload.baseUrl = baseUrl;
    if (model !== undefined) payload.model = model;

    if (!key && !baseUrl && !model) {
        status.textContent = '⚠ Nothing to save';
        status.style.color = '#f59e0b';
        return;
    }

    status.textContent = 'Saving...';
    status.style.color = '#888';
    try {
        const res = await fetch('/api/llm-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            keyInput.value = '';
            status.textContent = '✓ LLM settings saved!';
            status.style.color = '#4ade80';
            document.getElementById('gen-key-dot').style.background = 'var(--success)';
            // Refresh to show updated provider info
            setTimeout(loadGenKeyStatus, 500);
        } else {
            throw new Error(data.error || 'Save failed');
        }
    } catch (err) {
        status.textContent = '✗ ' + err.message;
        status.style.color = '#ef4444';
    }
}

async function toggleManualMode(enabled) {
    try {
        const res = await fetch('/api/llm-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ manualMode: enabled })
        });
        const data = await res.json();
        if (data.success) {
            showToast(enabled ? 'Manual mode enabled' : 'Manual mode disabled', 'success');
            loadGenKeyStatus();
        } else {
            throw new Error(data.error || 'Failed');
        }
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
        // Revert toggle
        document.getElementById('manual-mode-toggle').checked = !enabled;
    }
}

// ── Storage Management ──────────────────────────────────────────────────────

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

async function loadStorageInfo() {
    try {
        const res = await fetch('/api/storage');
        storageData = await res.json();
        updateStorageSidebar();
    } catch (e) {
        console.error('Storage load error:', e);
    }
}

function updateStorageSidebar() {
    if (!storageData) return;
    var d = storageData;
    document.getElementById('storage-used-label').textContent = d.usedGB + ' GB used';
    document.getElementById('storage-quota-label').textContent = '/ ' + d.quotaGB + ' GB';
    document.getElementById('storage-percent-label').textContent = d.percentUsed + '%';
    document.getElementById('storage-quota-input').value = d.quotaGB;

    var fill = document.getElementById('storage-bar-fill');
    fill.style.width = Math.min(d.percentUsed, 100) + '%';

    // Color thresholds
    fill.classList.remove('storage-bar-warning', 'storage-bar-danger');
    var dot = document.getElementById('storage-status-dot');
    if (d.percentUsed >= 90) {
        fill.classList.add('storage-bar-danger');
        dot.style.background = 'var(--error)';
    } else if (d.percentUsed >= 75) {
        fill.classList.add('storage-bar-warning');
        dot.style.background = 'var(--warning)';
    } else {
        fill.style.background = '';
        dot.style.background = 'var(--success)';
    }
}

async function saveStorageQuota() {
    var input = document.getElementById('storage-quota-input');
    var quotaGB = parseInt(input.value);
    if (!quotaGB || quotaGB < 1) { showToast('Invalid quota', 'error'); return; }
    try {
        var res = await fetch('/api/storage-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quotaGB: quotaGB })
        });
        if (res.ok) await loadStorageInfo();
    } catch (e) {
        showToast('Failed to save quota', 'error');
    }
}

async function openStorageBrowser() {
    await loadStorageInfo();
    renderStorageBrowser();
    document.getElementById('storage-modal').classList.add('open');
}

function closeStorageBrowser() {
    document.getElementById('storage-modal').classList.remove('open');
}

function sortStorageBy(key) {
    storageSortBy = key;
    ['size','date','name'].forEach(function(k) {
        var btn = document.getElementById('sort-' + k + '-btn');
        if (btn) btn.className = k === key ? 'primary' : '';
    });
    renderStorageBrowser();
}

function renderStorageBrowser() {
    if (!storageData) return;
    var d = storageData;

    document.getElementById('storage-modal-summary').textContent =
        d.usedGB + ' GB used of ' + d.quotaGB + ' GB (' + d.percentUsed + '%) — ' +
        d.episodes.length + ' project' + (d.episodes.length !== 1 ? 's' : '');

    var eps = d.episodes.slice();
    if (storageSortBy === 'size') eps.sort(function(a, b) { return b.totalBytes - a.totalBytes; });
    else if (storageSortBy === 'date') eps.sort(function(a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    else eps.sort(function(a, b) { return a.slug.localeCompare(b.slug); });

    var list = document.getElementById('storage-browser-list');
    list.innerHTML = eps.map(function(ep) {
        var chips = Object.entries(ep.breakdown)
            .filter(function(e) { return e[1] > 0; })
            .map(function(e) { return '<span class="storage-breakdown-chip ' + e[0] + '">' + e[0] + ': ' + formatBytes(e[1]) + '</span>'; })
            .join('');

        var files = ep.files.slice().sort(function(a, b) { return b.size - a.size; });
        var fileRows = files.map(function(f) {
            return '<div class="storage-file-row">' +
                '<span class="storage-file-name" title="' + f.path + '">' + f.path + '</span>' +
                '<span class="storage-file-size">' + formatBytes(f.size) + '</span>' +
                '<button class="storage-file-del" onclick="deleteStorageFile(\'' + ep.slug + '\',\'' + f.path.replace(/'/g, "\\'") + '\',' + f.size + ')">del</button>' +
            '</div>';
        }).join('');

        return '<div class="storage-ep-card" id="storage-card-' + ep.slug + '">' +
            '<div class="storage-ep-header" onclick="toggleStorageCard(\'' + ep.slug + '\')">' +
                '<div style="min-width:0; flex:1;">' +
                    '<div class="storage-ep-title">' + ep.slug + (ep.guest ? ' &middot; ' + ep.guest : '') + '</div>' +
                    '<div class="storage-breakdown">' + chips + '</div>' +
                '</div>' +
                '<div style="text-align:right; flex-shrink:0; margin-left:12px;">' +
                    '<div class="storage-ep-size">' + formatBytes(ep.totalBytes) + '</div>' +
                    '<button class="danger" style="font-size:0.55rem; padding:2px 6px; margin-top:4px;" onclick="event.stopPropagation(); deleteStorageEpisode(\'' + ep.slug + '\')">Delete All</button>' +
                '</div>' +
            '</div>' +
            '<div class="storage-file-list">' + fileRows + '</div>' +
        '</div>';
    }).join('');
}

function toggleStorageCard(slug) {
    var card = document.getElementById('storage-card-' + slug);
    if (card) card.classList.toggle('expanded');
}

async function deleteStorageFile(slug, filePath, size) {
    if (!confirm('Delete ' + filePath + ' from ' + slug + '? (' + formatBytes(size) + ')')) return;
    try {
        var res = await fetch('/api/delete-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: slug, files: [filePath] })
        });
        var result = await res.json();
        if (result.success) {
            await loadStorageInfo();
            renderStorageBrowser();
        } else {
            showToast(result.error || 'Delete failed', 'error');
        }
    } catch (e) {
        showToast('Delete failed', 'error');
    }
}

async function deleteStorageEpisode(slug) {
    if (!confirm('Delete entire project "' + slug + '" and all its files?')) return;
    try {
        var res = await fetch('/api/episodes?slug=' + encodeURIComponent(slug), { method: 'DELETE' });
        var result = await res.json();
        if (result.success) {
            await loadStorageInfo();
            renderStorageBrowser();
            await refresh();
        } else {
            showToast(result.error || 'Delete failed', 'error');
        }
    } catch (e) {
        showToast('Delete failed', 'error');
    }
}

init();

socket.on('connect', () => console.log('Socket connected'));
socket.on('restore-state', ({activeSteps: steps, logs: serverLogs}) => {
    console.log('🔄 Restoring state:', Object.keys(steps).length, 'running,', Object.keys(serverLogs).length, 'log buffers');
    // Restore running step indicators
    Object.assign(runningStep, steps);
    // Restore buffered logs (don't overwrite if we already have newer data)
    for (const [slug, text] of Object.entries(serverLogs)) {
        if (!logs[slug]) logs[slug] = text;
    }
    // Update UI if we're viewing a running episode
    if (currentSlug && runningStep[currentSlug]) {
        var stopBtn = document.getElementById('stop-btn');
        if (stopBtn) stopBtn.style.display = '';
    }
    if (currentSlug) updateLogs();
    refresh();
});
socket.on('status-update', function() {
    refresh();
    clearTimeout(window._storageReloadTimer);
    window._storageReloadTimer = setTimeout(loadStorageInfo, 2000);
});
socket.on('log', function(data) {
    if (!logs[data.slug]) logs[data.slug] = '';
    logs[data.slug] += data.text;
    if (data.reelId) {
        var key = data.slug + ':' + data.reelId;
        if (!reelLogs[key]) reelLogs[key] = '';
        reelLogs[key] += data.text;
    }
    if (currentSlug === data.slug) updateLogs();
});
socket.on('process-start', function(data) {
    runningStep[data.slug] = data.step;
    if (currentSlug === data.slug) renderMain(currentSlug);
});
socket.on('process-end', function(data) {
    delete runningStep[data.slug];
    refresh();
    if (data.step === 'cut' && data.code === 0 && currentSlug === data.slug) {
        setTimeout(function() { selectedReelId = null; renderMain(currentSlug); }, 500);
    }
    // Auto-refresh video preview when a reel processing step completes
    if (data.code === 0 && currentSlug === data.slug && selectedReelId) {
        // Refresh if this specific reel was processed, OR if a bulk step (no reelId) completed
        if (data.reelId === selectedReelId || (!data.reelId && ['subtitle', 'crop', 'overlay'].includes(data.step))) {
            setTimeout(function() {
                var previewEl = document.getElementById('reel-preview');
                if (previewEl) {
                    // Force video reload by clearing cached reel ID
                    previewEl.dataset.reelId = '';
                    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
                    if (ep) renderReelDetail(ep, selectedReelId);
                }
            }, 600);
        }
    }
    // Auto-switch to caption tab when generate completes for reel_full
    if (data.step === 'generate' && data.code === 0 && currentSlug === data.slug) {
        var epCheck = episodes.find(function(e) { return e.slug === data.slug; });
        if (epCheck && epCheck.mediaType === 'reel_full') {
            setTimeout(function() { switchReelFullTab('caption'); }, 700);
        }
    }
    // Advance step queue if this step succeeded
    if (data.code === 0) {
        // Check per-reel queue, then bulk queue
        var qKeys = [
            data.slug + (data.reelId ? ':' + data.reelId : ''),
            data.slug + ':__bulk__'
        ];
        for (var qi = 0; qi < qKeys.length; qi++) {
            var qKey = qKeys[qi];
            if (stepQueue[qKey] && stepQueue[qKey].length > 0 && stepQueue[qKey][0].step === data.step) {
                stepQueue[qKey].shift();
                if (stepQueue[qKey].length > 0) {
                    var nextItem = stepQueue[qKey][0];
                    setTimeout(function() { runReelStep(nextItem.reelId, nextItem.step); }, 500);
                } else {
                    delete stepQueue[qKey];
                    showToast('Finalize complete', 'success');
                }
                break;
            }
        }
    } else {
        // Step failed — clear any matching queue
        var qKeysFail = [
            data.slug + (data.reelId ? ':' + data.reelId : ''),
            data.slug + ':__bulk__'
        ];
        for (var qf = 0; qf < qKeysFail.length; qf++) {
            if (stepQueue[qKeysFail[qf]]) {
                var remaining = stepQueue[qKeysFail[qf]].length;
                delete stepQueue[qKeysFail[qf]];
                showToast('Pipeline stopped — ' + data.step + ' failed (' + remaining + ' steps skipped)', 'error');
                break;
            }
        }
    }
});
// ── Step queue: chain steps sequentially per slug ──────────────────────
var stepQueue = {};  // { slug: [{ reelId, step, opts }] }

function queueSteps(slug, reelId, steps, opts) {
    var key = slug + (reelId ? ':' + reelId : '');
    stepQueue[key] = steps.map(function(s) { return { reelId: reelId, step: s, opts: opts || {} }; });
    runNextQueued(key, slug);
}

function runNextQueued(key, slug) {
    if (!stepQueue[key] || stepQueue[key].length === 0) {
        delete stepQueue[key];
        return;
    }
    var next = stepQueue[key][0];
    if (next.reelId) {
        runReelStep(next.reelId, next.step);
    } else {
        runStep(next.step);
    }
}

function finalizeReel(reelId) {
    if (!currentSlug) return;
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    if (!ep) return;
    var r = ep.reelStatuses.find(function(x) { return x.id === reelId; });
    if (!r) return;
    // Build list of remaining steps: crop → subtitle → overlay
    var remaining = [];
    if (!r.cropped) remaining.push('crop');
    if (!r.subtitled) remaining.push('subtitle');
    if (!r.final) remaining.push('overlay');
    if (remaining.length === 0) {
        showToast('Reel ' + reelId + ' is already finalized', 'success');
        return;
    }
    showToast('Finalizing Reel ' + reelId + ': ' + remaining.join(' → '), 'success');
    queueSteps(currentSlug, reelId, remaining);
}

async function finalizeAll() {
    if (!currentSlug) return;
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    if (!ep || !ep.reelStatuses) return;
    var reels = ep.reelStatuses.filter(function(r) { return !r.hidden && r.cut; });
    if (reels.length === 0) { showToast('No cut reels to finalize', 'error'); return; }
    // Build a flat sequence: reel1 crop, reel1 sub, reel1 overlay, reel2 crop, ...
    // But since only one process can run per slug, we chain all reels sequentially
    var allSteps = [];
    reels.forEach(function(r) {
        if (!r.cropped) allSteps.push({ reelId: r.id, step: 'crop' });
        if (!r.subtitled) allSteps.push({ reelId: r.id, step: 'subtitle' });
        if (!r.final) allSteps.push({ reelId: r.id, step: 'overlay' });
    });
    if (allSteps.length === 0) { showToast('All reels already finalized', 'success'); return; }
    showToast('Finalizing ' + reels.length + ' reels (' + allSteps.length + ' steps)', 'success');
    // Use slug-level queue (no reelId in key) so steps chain across reels
    var key = currentSlug + ':__bulk__';
    stepQueue[key] = allSteps;
    var first = allSteps[0];
    runReelStep(first.reelId, first.step);
}

socket.on('toast', ({type, message}) => showToast(message, type));

// Download progress (from URL downloads)
socket.on('download-progress', ({slug, percent, speed, eta, status}) => {
    const progressEl = document.getElementById('upload-progress');
    const fillEl = document.getElementById('progress-fill');
    const textEl = document.getElementById('progress-text');

    if (status === 'done') {
        progressEl.classList.remove('active');
        document.getElementById('upload-zone').style.display = '';
        showToast('Download complete!', 'success');
        refresh().then(() => selectEp(slug));
        return;
    }
    if (status === 'error') {
        progressEl.classList.remove('active');
        document.getElementById('upload-zone').style.display = '';
        showToast('Download failed', 'error');
        return;
    }
    // Update progress bar
    fillEl.style.width = Math.round(percent) + '%';
    const label = speed ? `Downloading: ${Math.round(percent)}% at ${speed}` + (eta ? ` — ETA ${eta}` : '') : `Downloading: ${Math.round(percent)}%`;
    textEl.textContent = label;
});

// Manual LLM mode
let pendingLlmData = null;
socket.on('llm-prompt', (data) => {
    console.log('📋 LLM prompt received:', data.step);
    pendingLlmData = data;
    openLlmModal(data);
});
socket.on('episode-renamed', ({oldSlug, newSlug}) => {
    // If we're viewing the old slug, switch to the new one
    if (currentSlug === oldSlug) {
        currentSlug = newSlug;
        // Transfer logs
        if (logs[oldSlug]) {
            logs[newSlug] = (logs[newSlug] || '') + logs[oldSlug];
            delete logs[oldSlug];
        }
    }
    refresh().then(() => {
        if (currentSlug === newSlug) selectEp(newSlug);
    });
});

// Guest History
async function loadGuestHistory() {
    try {
        const res = await fetch('/api/guests');
        guestHistory = await res.json();
        populateGuestSelect();
    } catch (e) {}
}

function populateGuestSelect() {
    const select = document.getElementById('upload-guest-select');
    select.innerHTML = '<option value="">-- Select or type new --</option>';
    guestHistory.sort((a, b) => b.used - a.used).forEach(g => {
        const option = document.createElement('option');
        option.value = g.name;
        option.textContent = g.name + (g.role ? ' (' + g.role + ')' : '');
        option.dataset.role = g.role;
        select.appendChild(option);
    });
}

function onGuestSelect() {
    const select = document.getElementById('upload-guest-select');
    const input = document.getElementById('upload-guest-input');
    const roleInput = document.getElementById('upload-role');
    
    if (select.value) {
        input.value = select.value;
        const option = select.options[select.selectedIndex];
        if (option.dataset.role) {
            roleInput.value = option.dataset.role;
        }
    }
}

function toggleGuestInput() {
    const select = document.getElementById('upload-guest-select');
    const input = document.getElementById('upload-guest-input');
    
    if (input.style.display === 'none') {
        input.style.display = 'block';
        select.style.display = 'none';
        input.focus();
    } else {
        input.style.display = 'none';
        select.style.display = 'block';
    }
}

function getSelectedGuest() {
    const input = document.getElementById('upload-guest-input');
    const select = document.getElementById('upload-guest-select');
    return input.style.display !== 'none' ? input.value.trim() : select.value;
}

// Media Type Selection — simplified cycle-through default
const mediaTypeOrder = ['episode', 'reel_cut', 'reel_full'];
const mediaTypeLabels = { episode: 'Episode', reel_cut: 'Reel (no subs)', reel_full: 'Reel (done)' };
const mediaTypeIcons = { episode: '📺', reel_cut: '✂️', reel_full: '✅' };

function cycleMediaType() {
    const idx = mediaTypeOrder.indexOf(selectedMediaType);
    const next = mediaTypeOrder[(idx + 1) % mediaTypeOrder.length];
    setMediaType(next);
}

function setMediaType(type) {
    selectedMediaType = type;
    document.getElementById('media-default-icon').textContent = mediaTypeIcons[type] || '📺';
    document.getElementById('media-default-label').textContent = mediaTypeLabels[type] || 'Episode';
    localStorage.setItem('tajarib-default-media', type);
}

// Collapsible sidebar sections
function toggleSection(name) {
    const el = document.getElementById('section-' + name);
    if (!el) return;
    el.classList.toggle('open');
    localStorage.setItem('tajarib-section-' + name, el.classList.contains('open'));
}
// Restore collapsed state
['publishing','transcription','storage'].forEach(function(name) {
    const saved = localStorage.getItem('tajarib-section-' + name);
    if (saved === 'true') {
        const el = document.getElementById('section-' + name);
        if (el) el.classList.add('open');
    }
});

// Settings modal
function openSettingsModal() {
    document.getElementById('settings-modal').classList.add('open');
}
function closeSettingsModal() {
    document.getElementById('settings-modal').classList.remove('open');
}

// Prompts modal
var promptsData = [];          // [{name, content}, ...]
var promptsOriginal = {};      // name -> original content (for revert)
var currentPromptName = null;

var PROMPT_GROUPS = {
    'Generation': ['generate-reels-system', 'generate-reels-user', 'generate-youtube-system', 'generate-youtube-user'],
    'Analysis': ['analyze-system', 'analyze-user', 'reel-suggest-system', 'reel-suggest-user', 'topic-clip-system', 'topic-clip-user'],
    'Formats': ['reel-caption-format', 'youtube-description-format'],
    'Revision': ['revision-system', 'revision-user', 'slug-system', 'slug-user'],
    'Compose': ['compose-system', 'compose-user'],
    'Other': [] // catch-all
};

function categorizePrompt(name) {
    for (var group in PROMPT_GROUPS) {
        if (PROMPT_GROUPS[group].indexOf(name) !== -1) return group;
    }
    return 'Other';
}

async function openPromptsModal() {
    document.getElementById('prompts-modal').classList.add('open');
    document.getElementById('prompts-save-status').textContent = 'Loading...';
    try {
        var res = await fetch('/api/prompts');
        promptsData = await res.json();
        promptsOriginal = {};
        promptsData.forEach(function(p) { promptsOriginal[p.name] = p.content; });
        renderPromptsSidebar();
        // Auto-select first generation prompt
        if (!currentPromptName && promptsData.length) {
            selectPrompt(promptsData.find(function(p) { return p.name === 'generate-reels-system'; }) ? 'generate-reels-system' : promptsData[0].name);
        } else if (currentPromptName) {
            selectPrompt(currentPromptName);
        }
        document.getElementById('prompts-save-status').textContent = '';
    } catch (err) {
        document.getElementById('prompts-save-status').textContent = 'Failed to load prompts';
        document.getElementById('prompts-save-status').style.color = 'var(--error)';
    }
}

function closePromptsModal() {
    document.getElementById('prompts-modal').classList.remove('open');
}

function renderPromptsSidebar() {
    var sidebar = document.getElementById('prompts-sidebar');
    var grouped = {};
    // Initialize groups
    for (var g in PROMPT_GROUPS) grouped[g] = [];
    promptsData.forEach(function(p) {
        var group = categorizePrompt(p.name);
        grouped[group].push(p.name);
    });
    var html = '';
    var groupOrder = ['Generation', 'Analysis', 'Formats', 'Revision', 'Compose', 'Other'];
    groupOrder.forEach(function(group) {
        var items = grouped[group];
        if (!items || !items.length) return;
        html += '<div class="prompts-group-label">' + group + '</div>';
        items.forEach(function(name) {
            var label = name.replace(/^(generate|analyze|compose|revision|reel|slug|topic-clip|youtube)-?/, function(m) { return ''; }) || name;
            // Clean up label
            label = name.split('-').slice(-2).join(' ');
            var active = name === currentPromptName ? ' active' : '';
            html += '<div class="prompts-item' + active + '" data-prompt="' + name + '" onclick="selectPrompt(\'' + name + '\')">' + name + '</div>';
        });
    });
    sidebar.innerHTML = html;
}

function selectPrompt(name) {
    currentPromptName = name;
    var prompt = promptsData.find(function(p) { return p.name === name; });
    if (!prompt) return;
    var textarea = document.getElementById('prompts-textarea');
    textarea.value = prompt.content;
    textarea.disabled = false;
    document.getElementById('prompts-editor-name').textContent = name + '.md';
    // Show template variables
    var vars = (prompt.content.match(/\{\{(\w+)\}\}/g) || []);
    var unique = vars.filter(function(v, i, a) { return a.indexOf(v) === i; });
    var varsEl = document.getElementById('prompts-vars');
    if (unique.length) {
        varsEl.innerHTML = 'Variables: ' + unique.map(function(v) { return '<code>' + v + '</code>'; }).join(' ');
        varsEl.style.display = '';
    } else {
        varsEl.style.display = 'none';
    }
    document.getElementById('prompts-save-status').textContent = '';
    // Update sidebar active state
    document.querySelectorAll('.prompts-item').forEach(function(el) {
        el.classList.toggle('active', el.dataset.prompt === name);
    });
}

async function saveCurrentPrompt() {
    if (!currentPromptName) return;
    var textarea = document.getElementById('prompts-textarea');
    var status = document.getElementById('prompts-save-status');
    status.textContent = 'Saving...';
    status.style.color = '#888';
    try {
        var res = await fetch('/api/prompts/' + encodeURIComponent(currentPromptName), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ content: textarea.value })
        });
        var data = await res.json();
        if (data.success) {
            status.textContent = 'Saved';
            status.style.color = 'var(--success)';
            // Update local cache
            var p = promptsData.find(function(p) { return p.name === currentPromptName; });
            if (p) p.content = textarea.value;
            promptsOriginal[currentPromptName] = textarea.value;
        } else {
            status.textContent = data.error || 'Save failed';
            status.style.color = 'var(--error)';
        }
    } catch (err) {
        status.textContent = 'Network error';
        status.style.color = 'var(--error)';
    }
}

function revertPrompt() {
    if (!currentPromptName) return;
    var original = promptsOriginal[currentPromptName];
    if (original !== undefined) {
        document.getElementById('prompts-textarea').value = original;
        var p = promptsData.find(function(p) { return p.name === currentPromptName; });
        if (p) p.content = original;
        document.getElementById('prompts-save-status').textContent = 'Reverted';
        document.getElementById('prompts-save-status').style.color = '#888';
    }
}

// Sync header status dots with the settings modal dots
function syncSettingsDots() {
    var pairs = [
        ['buffer-status-dot', 'settings-dot-publishing'],
        ['api-status-dot', 'settings-dot-transcription'],
        ['gen-key-dot', 'settings-dot-generation'],
        ['storage-status-dot', 'settings-dot-storage']
    ];
    pairs.forEach(function(p) {
        var src = document.getElementById(p[0]);
        var dst = document.getElementById(p[1]);
        if (src && dst) dst.style.background = src.style.background;
    });
}
// Run syncSettingsDots periodically so header dots stay fresh
setInterval(syncSettingsDots, 1000);

// Restore saved default media type on load
(function restoreMediaType() {
    const saved = localStorage.getItem('tajarib-default-media');
    if (saved) setMediaType(saved);
})();

// Upload Zone
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
    if (file && /\\.(mp4|mkv|mov|avi)$/i.test(file.name)) startUploadFlow(file);
};

function startUploadFlow(file) {
    pendingFile = file;
    pendingUrl = null;
    document.getElementById('upload-modal-title').textContent = '📁 Upload Episode';
    document.getElementById('upload-confirm-btn').textContent = 'Upload';
    // Leave slug empty by default — AI will generate from transcript
    // User can still type their own if they want
    document.getElementById('upload-slug').value = '';
    
    // Reset guest inputs
    document.getElementById('upload-guest-select').value = '';
    document.getElementById('upload-guest-input').value = '';
    document.getElementById('upload-guest-input').style.display = 'none';
    document.getElementById('upload-guest-select').style.display = 'block';
    document.getElementById('upload-role').value = '';
    
    // Set default transcription method from config
    const defaultMethod = transcriptionConfig.defaultMethod || 'local';
    document.getElementById('radio-local').checked = defaultMethod === 'local';
    document.getElementById('radio-api').checked = defaultMethod === 'api';
    
    // Show warning if API selected but no key
    const apiWarning = document.getElementById('api-key-warning');
    if (defaultMethod === 'api' && !transcriptionConfig.hasApiKey) {
        apiWarning.style.display = 'block';
    } else {
        apiWarning.style.display = 'none';
    }
    
    // Update warning when selection changes
    document.querySelectorAll('input[name="transcribe-method"]').forEach(radio => {
        radio.onchange = () => {
            if (radio.value === 'api' && !transcriptionConfig.hasApiKey) {
                apiWarning.style.display = 'block';
            } else {
                apiWarning.style.display = 'none';
            }
        };
    });
    
    // Pre-select media type radio based on current default
    const typeRadio = document.getElementById('upload-type-' + (selectedMediaType === 'reel_cut' ? 'reel-cut' : selectedMediaType === 'reel_full' ? 'reel-full' : 'episode'));
    if (typeRadio) typeRadio.checked = true;

    // Restore fields that URL mode hides
    document.getElementById('srt-upload-field').style.display = '';

    // Show multi-track toggle only for episodes
    updateMultiTrackVisibility();
    document.querySelectorAll('input[name="upload-media-type"]').forEach(r => {
        r.onchange = updateMultiTrackVisibility;
    });

    // Reset multi-track state
    document.getElementById('upload-multi-track').checked = false;
    document.getElementById('multi-track-zones').style.display = 'none';
    document.getElementById('track-speaker-name').textContent = '';
    document.getElementById('track-guest-name').textContent = '';
    pendingSpeakerFile = null;
    pendingGuestFile = null;

    document.getElementById('upload-modal').classList.add('open');
}

function startUrlUploadFlow() {
    const urlInput = document.getElementById('url-input');
    const url = urlInput.value.trim();
    if (!url) { urlInput.focus(); return; }
    if (!/^https?:\/\/.+/.test(url)) { showToast('Enter a valid URL', 'error'); return; }

    pendingUrl = url;
    pendingFile = null; // URL mode, not file mode
    urlInput.value = '';
    document.getElementById('upload-modal-title').textContent = '🔗 Download Video';
    document.getElementById('upload-confirm-btn').textContent = 'Download';

    // Reuse same modal reset as file upload
    document.getElementById('upload-slug').value = '';
    document.getElementById('upload-guest-select').value = '';
    document.getElementById('upload-guest-input').value = '';
    document.getElementById('upload-guest-input').style.display = 'none';
    document.getElementById('upload-guest-select').style.display = 'block';
    document.getElementById('upload-role').value = '';

    const defaultMethod = transcriptionConfig.defaultMethod || 'local';
    document.getElementById('radio-local').checked = defaultMethod === 'local';
    document.getElementById('radio-api').checked = defaultMethod === 'api';

    const apiWarning = document.getElementById('api-key-warning');
    apiWarning.style.display = (defaultMethod === 'api' && !transcriptionConfig.hasApiKey) ? 'block' : 'none';
    document.querySelectorAll('input[name="transcribe-method"]').forEach(radio => {
        radio.onchange = () => {
            apiWarning.style.display = (radio.value === 'api' && !transcriptionConfig.hasApiKey) ? 'block' : 'none';
        };
    });

    const typeRadio = document.getElementById('upload-type-' + (selectedMediaType === 'reel_cut' ? 'reel-cut' : selectedMediaType === 'reel_full' ? 'reel-full' : 'episode'));
    if (typeRadio) typeRadio.checked = true;

    // Hide SRT and multi-track in URL mode (not applicable)
    document.getElementById('srt-upload-field').style.display = 'none';
    document.getElementById('multi-track-field').style.display = 'none';
    document.getElementById('upload-multi-track').checked = false;
    document.getElementById('multi-track-zones').style.display = 'none';
    pendingSpeakerFile = null;
    pendingGuestFile = null;

    document.getElementById('upload-modal').classList.add('open');
}

function closeUploadModal() {
    pendingFile = null;
    pendingUrl = null;
    document.getElementById('upload-modal').classList.remove('open');
}

function updateMultiTrackVisibility() {
    const selected = document.querySelector('input[name="upload-media-type"]:checked')?.value;
    const mtField = document.getElementById('multi-track-field');
    if (selected === 'episode') {
        mtField.style.display = '';
    } else {
        mtField.style.display = 'none';
        document.getElementById('upload-multi-track').checked = false;
        document.getElementById('multi-track-zones').style.display = 'none';
    }
}

function toggleMultiTrackUpload() {
    const checked = document.getElementById('upload-multi-track').checked;
    document.getElementById('multi-track-zones').style.display = checked ? '' : 'none';
}

function onTrackFileSelect(track, input) {
    if (!input.files[0]) return;
    if (track === 'speaker') {
        pendingSpeakerFile = input.files[0];
        document.getElementById('track-speaker-name').textContent = input.files[0].name;
    } else {
        pendingGuestFile = input.files[0];
        document.getElementById('track-guest-name').textContent = input.files[0].name;
    }
}

function onSrtFileSelect(input) {
    if (!input.files[0]) return;
    pendingSrtFile = input.files[0];
    document.getElementById('srt-filename').textContent = pendingSrtFile.name;
    document.getElementById('srt-drop-zone').style.borderColor = 'var(--accent)';
    document.getElementById('srt-clear-btn').style.display = '';
    // Grey out transcription method radios since SRT will be used
    document.querySelectorAll('input[name="transcribe-method"]').forEach(r => r.disabled = true);
    document.querySelector('.field:has(#radio-local)').style.opacity = '0.4';
}

function clearSrtFile() {
    pendingSrtFile = null;
    document.getElementById('upload-srt-input').value = '';
    document.getElementById('srt-filename').textContent = 'Choose .srt or .vtt file (optional)';
    document.getElementById('srt-drop-zone').style.borderColor = '#333';
    document.getElementById('srt-clear-btn').style.display = 'none';
    // Re-enable transcription method radios
    document.querySelectorAll('input[name="transcribe-method"]').forEach(r => r.disabled = false);
    document.querySelector('.field:has(#radio-local)').style.opacity = '1';
}

function confirmUpload() {
    const slug = document.getElementById('upload-slug').value.trim();
    const guest = getSelectedGuest();
    const role = document.getElementById('upload-role').value.trim();
    const transcribeMethod = document.querySelector('input[name="transcribe-method"]:checked')?.value || 'local';
    const uploadMediaType = document.querySelector('input[name="upload-media-type"]:checked')?.value || selectedMediaType;

    // ── URL download mode ──
    if (pendingUrl) {
        document.getElementById('upload-modal').classList.remove('open');

        const progressEl = document.getElementById('upload-progress');
        const fillEl = document.getElementById('progress-fill');
        const textEl = document.getElementById('progress-text');
        progressEl.classList.add('active');
        dropZone.style.display = 'none';
        fillEl.style.width = '0%';
        textEl.textContent = 'Starting download...';

        fetch('/api/download-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: pendingUrl, slug, guest, role, mediaType: uploadMediaType, transcribeMethod })
        }).then(r => r.json()).then(data => {
            if (!data.success) {
                progressEl.classList.remove('active');
                dropZone.style.display = '';
                showToast('Download failed: ' + (data.error || 'Unknown error'), 'error');
            }
            // Progress updates come via socket events — slug is in data.slug
        }).catch(err => {
            progressEl.classList.remove('active');
            dropZone.style.display = '';
            showToast('Download failed: ' + err.message, 'error');
        });

        pendingUrl = null;
        pendingSrtFile = null;
        return;
    }

    // ── File upload mode ──
    if (!pendingFile) return;

    document.getElementById('upload-modal').classList.remove('open');

    const isMultiTrack = document.getElementById('upload-multi-track').checked && uploadMediaType === 'episode';

    if (isMultiTrack) {
        if (!pendingSpeakerFile || !pendingGuestFile) {
            alert('Multi-track requires both speaker and guest video files');
            return;
        }
    } else {
        if (!pendingFile) return;
    }

    const formData = new FormData();
    formData.append('slug', slug);
    formData.append('mediaType', uploadMediaType);
    formData.append('transcribeMethod', transcribeMethod);
    formData.append('multiTrack', isMultiTrack ? 'true' : 'false');
    if (guest) formData.append('guest', guest);
    if (role) formData.append('role', role);

    if (pendingSrtFile) {
        formData.append('srt', pendingSrtFile);
    }

    if (isMultiTrack) {
        formData.append('speaker', pendingSpeakerFile);
        formData.append('guestTrack', pendingGuestFile);
    } else {
        formData.append('video', pendingFile);
    }

    const xhr = new XMLHttpRequest();
    const progressEl = document.getElementById('upload-progress');
    const fillEl = document.getElementById('progress-fill');
    const textEl = document.getElementById('progress-text');

    progressEl.classList.add('active');
    dropZone.style.display = 'none';

    xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            fillEl.style.width = pct + '%';
            const mb = (e.loaded / 1024 / 1024).toFixed(0);
            const totalMb = (e.total / 1024 / 1024).toFixed(0);
            textEl.textContent = 'Uploading: ' + mb + ' / ' + totalMb + ' MB (' + pct + '%)';
        }
    };

    xhr.onload = function() {
        progressEl.classList.remove('active');
        dropZone.style.display = '';
        if (xhr.status === 200) {
            showToast('Upload complete!', 'success');
            refresh().then(() => selectEp(slug.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()));
        } else {
            showToast('Upload failed: ' + xhr.responseText, 'error');
        }
        pendingFile = null;
        pendingSrtFile = null;
    };

    xhr.onerror = function() {
        progressEl.classList.remove('active');
        dropZone.style.display = '';
        showToast('Upload failed', 'error');
        pendingFile = null;
        pendingSrtFile = null;
    };

    xhr.open('POST', '/api/upload');
    xhr.send(formData);
}

// Data functions
async function refresh() {
    console.log('🔄 refresh() called');
    try {
        const res = await fetch('/api/episodes');
        episodes = await res.json();
        console.log('📊 fetched', episodes.length, 'episodes');
    } catch(e) {
        console.error('❌ refresh error:', e);
        return;
    }
    renderSidebar();
    if (currentSlug) renderMain(currentSlug);
}

function renderSidebar() {
    console.log('📋 renderSidebar(), episodes:', episodes.length);
    const list = document.getElementById('ep-list');
    console.log('📋 ep-list element:', list ? 'found' : 'NOT FOUND');
    if (episodes.length === 0) {
        list.innerHTML = '<div class="empty-state" style="padding:40px 20px; height:auto;"><div class="icon" style="font-size:2rem;">📂</div><div class="subtitle">No episodes yet. Upload a video to get started.</div></div>';
        return;
    }

    list.innerHTML = episodes.map(ep => {
        const steps = stepsForType(ep.mediaType, ep);
        const applicableSteps = steps.filter(s => s.applicable);
        const stepKeys = applicableSteps.map(s => s.id === 'transcribe' ? 'transcribed' : s.id === 'analyze' ? 'analyzed' : s.id === 'generate' ? 'generated' : s.id === 'compose' ? 'composed' : s.id === 'overlay' ? 'overlaid' : s.id);
        const done = stepKeys.filter(k => ep.steps[k]).length;
        const total = applicableSteps.length;
        const sizeMb = ep.videoSize ? (ep.videoSize / 1024 / 1024).toFixed(0) + 'MB' : '';
        const typeClass = ep.mediaType;
        const typeLabel = ep.mediaType === 'episode' ? 'EP' : ep.mediaType === 'reel_full' ? 'RF' : 'RC';
        const mtLabel = ep.multiTrack ? ' MT' : '';
        const guestSnippet = ep.guest ? ' &middot; ' + ep.guest : '';
        const hoverTitle = (ep.guest || '') + (ep.role ? ' (' + ep.role + ')' : '');

        return '<div class="ep-item ' + (currentSlug === ep.slug ? 'active' : '') + '" onclick="selectEp(\'' + ep.slug + '\')" title="' + hoverTitle + '">' +
            '<div class="ep-slug">' +
                '<span class="ep-type-badge ' + typeClass + '">' + typeLabel + mtLabel + '</span>' +
                '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;">' + ep.slug + '</span>' +
            '</div>' +
            '<div class="ep-info">' +
                '<span>' + done + '/' + total + guestSnippet + '</span>' +
                (sizeMb ? '<span>' + sizeMb + '</span>' : '') +
            '</div>' +
            (ep.steps.published ? '<div class="ep-published" title="Published"></div>' : '') +
        '</div>';
    }).join('');
}

function stepsForType(mediaType, ep) {
    const all = [
        {id: 'transcribe',   label: '1. Transcribe',   desc: 'Whisper ASR'},
        {id: 'analyze',      label: '2. Analyze',      desc: 'AI analysis'},
        {id: 'cut',          label: '3. Cut',          desc: 'FFmpeg clips'},
        {id: 'generate',     label: '4. Caption',      desc: 'Generate captions & copy'},
        {id: 'crop',         label: '5. Crop',         desc: 'Aspect ratio crop (optional)'},
        {id: 'subtitle',     label: '6. Subtitle',     desc: 'Burn subs'},
        {id: 'overlay',      label: '7. Overlay',      desc: 'CG, logos & CTA'},
    ];

    // Add compose step for multi-track episodes
    if (ep && ep.multiTrack) {
        all.splice(4, 0, {id: 'compose', label: '4b. Compose', desc: 'Multi-track mix'});
    }

    if (mediaType === 'reel_full') {
        return all.map(s => Object.assign({}, s, {applicable: ['transcribe', 'generate'].includes(s.id)}));
    } else if (mediaType === 'reel_cut') {
        return all.map(s => Object.assign({}, s, {applicable: ['transcribe', 'generate', 'subtitle', 'overlay'].includes(s.id)}));
    }
    return all.map(s => Object.assign({}, s, {applicable: true}));
}

function selectEp(slug) {
    currentSlug = slug;
    selectedReelId = null;
    reelFullTranscriptData = null;
    localStorage.setItem('tajarib-selected-slug', slug);
    localStorage.removeItem('tajarib-selected-reel');
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('episode-view').style.display = 'flex';
    renderSidebar();
    renderMain(slug);
    updateLogs();
    loadContentEditor();
}

function updateLogs() {
    // Pre-cut console (episodes)
    var el = document.getElementById('logs-output');
    if (el) {
        el.textContent = logs[currentSlug] || '';
        el.scrollTop = el.scrollHeight;
    }
    // Reel-full console
    var rfEl = document.getElementById('logs-output-rf');
    if (rfEl) {
        rfEl.textContent = logs[currentSlug] || '';
        rfEl.scrollTop = rfEl.scrollHeight;
    }
    // Per-reel console (also shows episode-level logs as fallback)
    var reelEl = document.getElementById('logs-output-reel');
    if (reelEl) {
        var reelKey = selectedReelId ? (currentSlug + ':' + selectedReelId) : '';
        reelEl.textContent = (reelKey && reelLogs[reelKey]) || logs[currentSlug] || '';
        reelEl.scrollTop = reelEl.scrollHeight;
    }
}

function clearLogs() {
    if (currentSlug) {
        logs[currentSlug] = '';
        if (selectedReelId) {
            var reelKey = currentSlug + ':' + selectedReelId;
            reelLogs[reelKey] = '';
        }
        updateLogs();
    }
}

async function runClipsAnalysis() {
    if (!currentSlug) return;
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    var force = ep && ep.steps.clipsAnalyzed;
    try {
        var res = await fetch('/api/run-step', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ slug: currentSlug, step: 'analyze-clips', force: force })
        });
        var data = await res.json();
        if (!data.success) showToast(data.error, 'error');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function handleReplaceSrt(input) {
    var file = input.files[0];
    if (!file || !currentSlug) return;
    if (!confirm('Replace transcript for "' + currentSlug + '" with this SRT?\n\nYou can re-analyze and re-cut afterwards.')) {
        input.value = '';
        return;
    }
    var formData = new FormData();
    formData.append('slug', currentSlug);
    formData.append('srt', file);
    try {
        var res = await fetch('/api/replace-srt', { method: 'POST', body: formData });
        var data = await res.json();
        if (!data.success) throw new Error(data.error || 'Replace failed');
        await refresh();
        if (currentSlug) renderMain(currentSlug);
    } catch (err) {
        alert('Failed to replace SRT: ' + err.message);
    }
    input.value = '';
}

async function deleteEpisode(slug) {
    if (!confirm('Delete episode "' + slug + '"?\n\nThis will permanently remove all files (video, transcript, reels, etc). This cannot be undone.')) return;
    try {
        const res = await fetch('/api/episodes?slug=' + encodeURIComponent(slug), { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Delete failed');
        currentSlug = null;
        document.getElementById('episode-view').style.display = 'none';
        document.getElementById('empty-state').style.display = '';
        await refresh();
    } catch (err) {
        alert('Failed to delete: ' + err.message);
    }
}

function renderMain(slug) {
    const ep = episodes.find(e => e.slug === slug);
    if (!ep) return;

    // Header
    document.getElementById('ep-title').textContent = slug;
    const typeLabels = {episode: 'Full Episode', reel_full: 'Reel (fully done)', reel_cut: 'Reel (cut, no subs)'};
    document.getElementById('ep-type-display').innerHTML = '<span class="ep-type-badge ' + ep.mediaType + '">' + typeLabels[ep.mediaType] + '</span>';
    document.getElementById('ep-meta').innerHTML =
        '<span>Guest: <strong>' + (ep.guest || '—') + '</strong></span>' +
        '<span>Role: <strong>' + (ep.role || '—') + '</strong></span>' +
        '<button class="text-btn" onclick="editMeta()">Edit</button>' +
        '<select onchange="changeMediaType(currentSlug, this.value)" style="background:#111; border:1px solid #333; color:#888; padding:4px 8px; border-radius:4px; font-size:0.75rem;">' +
            '<option value="episode" ' + (ep.mediaType === 'episode' ? 'selected' : '') + '>Episode</option>' +
            '<option value="reel_full" ' + (ep.mediaType === 'reel_full' ? 'selected' : '') + '>Reel (Full)</option>' +
            '<option value="reel_cut" ' + (ep.mediaType === 'reel_cut' ? 'selected' : '') + '>Reel (Cut)</option>' +
        '</select>' +
        '<span style="color:#333; margin-left:4px;">|</span>' +
        '<button class="header-delete" onclick="deleteEpisode(\'' + ep.slug + '\')" title="Delete episode">🗑</button>';

    // Episode pipeline bar
    renderEpisodePipelineBar(ep);

    // Show Replace SRT button if episode is transcribed
    var replaceSrtBtn = document.getElementById('replace-srt-btn');
    if (replaceSrtBtn) replaceSrtBtn.style.display = ep.steps.transcribed ? '' : 'none';

    // Show Clips button if analyzed (only for episodes)
    var clipsBtn = document.getElementById('analyze-clips-btn');
    if (clipsBtn) {
        clipsBtn.style.display = (ep.mediaType === 'episode' && ep.steps.analyzed) ? '' : 'none';
        clipsBtn.textContent = ep.steps.clipsAnalyzed ? 'Clips ✓' : 'Clips';
        clipsBtn.style.background = ep.steps.clipsAnalyzed ? '#1a0f2e' : '#222';
    }

    // Mode switch — show reel list if any reels exist (from files or analysis)
    const isCut = ep.reelStatuses && ep.reelStatuses.length > 0;

    if (isCut) {
        document.getElementById('pre-cut-view').style.display = 'none';
        document.getElementById('post-cut-view').style.display = 'flex';
        renderReelList(ep);
        if (selectedReelId) {
            renderReelDetail(ep, selectedReelId);
        } else {
            document.getElementById('reel-detail-empty').style.display = 'flex';
            document.getElementById('reel-detail').style.display = 'none';
        }
        // Topic clip
        var tcSection = document.getElementById('topic-clip-section');
        if (tcSection) tcSection.style.display = (ep.mediaType === 'episode' && ep.steps.transcribed) ? '' : 'none';
        // YouTube clips
        var clipsSection = document.getElementById('clips-section');
        if (clipsSection) {
            if (ep.clipsAnalysis && ep.clipsAnalysis.clips && ep.clipsAnalysis.clips.length > 0) {
                clipsSection.style.display = '';
                renderClipsList(ep);
            } else {
                clipsSection.style.display = 'none';
            }
        }
    } else {
        document.getElementById('pre-cut-view').style.display = 'flex';
        document.getElementById('post-cut-view').style.display = 'none';

        var isReelFull = ep.mediaType === 'reel_full';
        document.getElementById('precut-console-only').style.display = isReelFull ? 'none' : 'flex';
        document.getElementById('reel-full-layout').style.display = isReelFull ? 'flex' : 'none';

        if (isReelFull) {
            renderReelFullView(ep);
            var stopRf = document.getElementById('stop-btn-rf');
            if (stopRf) stopRf.style.display = ep.isRunning ? '' : 'none';
        } else {
            document.getElementById('stop-btn').style.display = ep.isRunning ? '' : 'none';
        }
    }
}

function renderEpisodePipelineBar(ep) {
    const bar = document.getElementById('episode-pipeline-bar');
    const steps = stepsForType(ep.mediaType, ep);
    const stepKeyMap = {transcribe:'transcribed', analyze:'analyzed', generate:'generated', cut:'cut', crop:'cropped', subtitle:'subtitled', overlay:'overlaid', compose:'composed'};
    const isCut = ep.steps.cut && ep.reelStatuses && ep.reelStatuses.length > 0;

    // For reels, all applicable steps are shown in the pipeline bar (no per-reel breakdown)
    // For episodes, only episode-level steps; per-reel steps appear in reel detail
    const isReel = ep.mediaType === 'reel_full' || ep.mediaType === 'reel_cut';
    const episodeLevelSteps = ['transcribe', 'analyze', 'cut', 'compose'];
    const stepsToShow = steps.filter(function(s) {
        return s.applicable && (isReel || episodeLevelSteps.includes(s.id));
    });

    var nextFound = false;
    bar.innerHTML = stepsToShow.map(function(s, i) {
        var done = ep.steps[stepKeyMap[s.id] || s.id];
        var isRunning = runningStep[ep.slug] === s.id;
        var cls = 'ep-step-chip';
        if (isRunning) cls += ' running';
        else if (done) cls += ' done';
        else if (!nextFound && !ep.isRunning) { cls += ' next'; nextFound = true; }

        var icon = done ? '✓' : (isRunning ? '⏳' : '○');
        var label = s.label.replace(/^\d+[b]?\.\s*/, '');

        var onclick = 'runStep(\'' + s.id + '\')';

        var connector = (i > 0) ? '<div class="ep-step-connector' + (done ? ' done' : '') + '"></div>' : '';
        return connector +
            '<div class="' + cls + '" onclick="' + onclick + '" title="Click to run: ' + s.desc + '">' +
            '<span class="chip-icon">' + icon + '</span>' +
            '<span>' + label + '</span>' +
        '</div>';
    }).join('');
}

var showHiddenReels = false;

function renderClipsList(ep) {
    var listEl = document.getElementById('clips-list');
    if (!listEl || !ep.clipsAnalysis || !ep.clipsAnalysis.clips) return;
    listEl.innerHTML = ep.clipsAnalysis.clips.map(function(clip) {
        var padded = String(clip.id).padStart(2, '0');
        var duration = clip.duration_minutes ? clip.duration_minutes + ' min' : '';
        var time = (clip.start || '') + (clip.end ? ' → ' + clip.end : '');
        return '<div style="padding:6px 0; border-bottom:1px solid #222; font-size:0.72rem;">' +
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                '<strong style="color:#ddd;">Clip ' + padded + '</strong>' +
                '<span style="color:#666; font-size:0.6rem;">' + duration + '</span>' +
            '</div>' +
            '<div style="color:#aaa; margin-top:2px; direction:rtl;">' + escHtml(clip.title || '') + '</div>' +
            '<div style="color:#666; font-size:0.6rem; margin-top:2px;">' + time + '</div>' +
            (clip.thumbnail_text ? '<div style="color:#a855f7; font-size:0.6rem; margin-top:2px;">Thumb: ' + escHtml(clip.thumbnail_text) + '</div>' : '') +
        '</div>';
    }).join('');
}

function renderReelList(ep) {
    var listEl = document.getElementById('reel-list');
    var hiddenCount = ep.reelStatuses.filter(function(r) { return r.hidden; }).length;
    var visibleReels = showHiddenReels ? ep.reelStatuses : ep.reelStatuses.filter(function(r) { return !r.hidden; });
    document.getElementById('reel-list-count').textContent = visibleReels.length + ' reels' + (hiddenCount > 0 ? ' (' + hiddenCount + ' hidden)' : '');

    // Bulk actions
    var bulkEl = document.getElementById('reel-list-bulk');
    bulkEl.innerHTML =
        '<button onclick="openFindReel()" style="color:var(--accent); border-color:var(--accent);">+ Find & Create</button>' +
        '<button onclick="getMoreReels()" style="color:#a855f7; font-weight:600;">+ More Reels</button>' +
        '<button onclick="runStep(\'crop\')">Crop All</button>' +
        '<button onclick="runStep(\'subtitle\')">Sub All</button>' +
        '<button onclick="runStep(\'overlay\')">Overlay All</button>' +
        '<button onclick="finalizeAll()" style="color:#f59e0b; font-weight:600;">Finalize All</button>' +
        (hiddenCount > 0 ? '<button onclick="showHiddenReels=!showHiddenReels; var ep=episodes.find(function(e){return e.slug===currentSlug;}); if(ep) renderReelList(ep);" style="font-size:0.65rem; opacity:0.6;">' + (showHiddenReels ? 'Hide Hidden' : 'Show Hidden') + '</button>' : '');

    listEl.innerHTML = visibleReels.map(function(r) {
        var isActive = selectedReelId === r.id;
        var chipDefs = [
            {key: 'cut', label: 'CUT'},
            {key: 'generated', label: 'CAP'},
            {key: 'cropped', label: 'CROP'},
            {key: 'subtitled', label: 'SUB'},
            {key: 'final', label: 'OVR'}
        ];
        var chips = chipDefs.map(function(c) {
            var cls = r[c.key] ? 'done' : 'pending';
            if (c.key === 'cut' && !r.cut) cls = 'missing';
            return '<span class="reel-chip ' + cls + '">' + c.label + '</span>';
        }).join('');

        return '<div class="reel-list-item ' + (isActive ? 'active' : '') + (r.hidden ? ' hidden-reel' : '') + '" onclick="selectReel(\'' + r.id + '\')" style="' + (r.hidden ? 'opacity:0.4;' : '') + '">' +
            '<div class="reel-list-item-title">Reel ' + r.id + (r.hidden ? ' (hidden)' : '') + '</div>' +
            (r.hook ? '<div class="reel-list-item-hook">' + r.hook + '</div>' : '') +
            '<div class="reel-list-item-chips">' + chips + '</div>' +
        '</div>';
    }).join('');
}

function selectReel(reelId) {
    selectedReelId = reelId;
    localStorage.setItem('tajarib-selected-reel', reelId);
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    if (ep) {
        renderReelList(ep);
        renderReelDetail(ep, reelId);
    }
}

function renderReelDetail(ep, reelId) {
    document.getElementById('reel-detail-empty').style.display = 'none';
    document.getElementById('reel-detail').style.display = 'flex';
    document.getElementById('find-reel-panel').style.display = 'none';

    var r = ep.reelStatuses.find(function(x) { return x.id === reelId; });
    if (!r) return;

    // Warning if source clip is missing/empty
    var warningEl = document.getElementById('reel-cut-warning');
    if (!warningEl) {
        warningEl = document.createElement('div');
        warningEl.id = 'reel-cut-warning';
        var modularEl = document.getElementById('reel-detail-modular');
        modularEl.insertBefore(warningEl, document.getElementById('reel-preview'));
    }
    if (!r.cut && r.cropped) {
        // Only show warning when there's an orphaned crop from a previous run
        warningEl.style.display = '';
        warningEl.innerHTML = '<div style="background:#4a1c1c; color:#f87171; padding:8px 12px; border-radius:6px; font-size:0.75rem; margin-bottom:8px;">Source clip missing — preview shows an orphaned crop from a previous run. Use Cut below to regenerate.</div>';
    } else {
        warningEl.style.display = 'none';
    }

    // Video preview — only recreate if reel changed to avoid interrupting playback
    var previewEl = document.getElementById('reel-preview');
    if (!r.cut && !r.cropped) {
        // Uncut reel — show placeholder instead of broken video player
        previewEl.innerHTML =
            '<div style="background:#111; border:1px solid var(--border); border-radius:8px; padding:24px 20px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; min-height:120px;">' +
                '<div style="font-size:1.6rem; opacity:0.4;">&#9988;</div>' +
                '<div style="font-size:0.8rem; color:#666; text-align:center;">Not cut yet</div>' +
                (r.start && r.end ? '<div style="font-size:0.7rem; color:#555; font-family:\'Fira Code\',monospace;">' + escHtml(r.start) + ' &ndash; ' + escHtml(r.end) + '</div>' : '') +
                '<button class="primary" onclick="runReelStep(\'' + reelId + '\', \'cut\')" style="font-size:0.75rem; margin-top:4px;">&#9654; Cut from source</button>' +
            '</div>';
        previewEl.dataset.reelId = reelId;
        previewEl.dataset.slug = ep.slug;
        // Reset portrait layout since there's no video
        var modular = document.getElementById('reel-detail-modular');
        if (modular) modular.classList.remove('portrait');
    } else if (previewEl.dataset.reelId !== reelId || previewEl.dataset.slug !== ep.slug) {
        var videoUrl = '/api/video?slug=' + encodeURIComponent(ep.slug) + '&reel=' + encodeURIComponent(reelId) + '&t=' + Date.now();
        previewEl.innerHTML = '<video controls preload="metadata" src="' + videoUrl + '" style="max-width:100%; max-height:300px; border-radius:8px; background:#000;"></video>';
        previewEl.dataset.reelId = reelId;
        previewEl.dataset.slug = ep.slug;
        // Detect portrait video and switch to side-by-side layout
        var vid = previewEl.querySelector('video');
        if (vid) vid.addEventListener('loadedmetadata', function() {
            var modular = document.getElementById('reel-detail-modular');
            if (modular) modular.classList.toggle('portrait', this.videoHeight > this.videoWidth);
        });
    }

    // Trim editor
    renderTrimEditor(ep, r);

    // Transcript context for extending reel boundaries
    renderTranscriptContext(ep, r);

    // Per-reel action buttons
    var actionsEl = document.getElementById('reel-actions');
    actionsEl.innerHTML = buildReelActions(ep, r);

    // Transcript editor button — show if episode has transcript
    var transcriptBtn = document.getElementById('reel-transcript-btn');
    if (transcriptBtn) transcriptBtn.style.display = ep.steps.transcribed ? '' : 'none';

    // Caption editor — show generated caption if available
    var captionEl = document.getElementById('reel-caption-editor');
    if (captionEl) {
        var reelContent = null;
        if (ep.content && ep.content.reels) {
            var reelNum = parseInt(reelId, 10);
            reelContent = ep.content.reels.find(function(rc) { return rc.id === reelNum || String(rc.id).padStart(2, '0') === reelId; });
        }
        captionEl.style.display = '';
        var captionBtn = '<button class="' + (r.generated ? '' : 'primary') + '" onclick="runReelStep(\'' + reelId + '\', \'generate\')" style="font-size:0.7rem;">' +
            (r.generated ? '↻ Generate' : '▶ Generate') + '</button>';
        if (reelContent) {
            captionEl.innerHTML =
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' +
                    '<div style="font-size:0.7rem; color:#666; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Caption</div>' +
                    captionBtn +
                '</div>' +
                '<textarea id="reel-caption-text" class="content-textarea" rows="4" style="direction:rtl; font-size:0.8rem;" placeholder="No caption yet — type one or run Caption">' + escHtml(reelContent.caption || '') + '</textarea>' +
                '<div style="display:flex; gap:6px; margin-top:6px;">' +
                    '<button onclick="saveReelCaption(\'' + reelId + '\')" style="font-size:0.7rem;">Save</button>' +
                    '<button onclick="copyToClipboard(document.getElementById(\'reel-caption-text\').value)" style="font-size:0.7rem;">Copy</button>' +
                '</div>';
        } else {
            captionEl.innerHTML =
                '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                    '<div style="font-size:0.7rem; color:#666; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Caption</div>' +
                    captionBtn +
                '</div>';
        }
    }

    // Subtitle editor — show if ASS/SRT file exists
    var subEditorEl = document.getElementById('reel-subtitle-editor');
    if (subEditorEl) {
        if (r.subtitled) {
            subEditorEl.style.display = '';
            subEditorEl.innerHTML =
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' +
                    '<div style="font-size:0.7rem; color:#666; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Subtitles</div>' +
                    '<button onclick="loadReelSubtitles(\'' + reelId + '\')" style="font-size:0.65rem;">Load / Edit</button>' +
                '</div>' +
                '<div id="reel-subtitle-content" style="display:none;">' +
                    '<textarea id="reel-subtitle-text" class="content-textarea" rows="8" style="font-family:monospace; font-size:0.72rem; direction:ltr;"></textarea>' +
                    '<div style="display:flex; gap:6px; margin-top:6px;">' +
                        '<button onclick="saveReelSubtitles(\'' + reelId + '\')" style="font-size:0.7rem;">Save & Re-burn</button>' +
                    '</div>' +
                '</div>';
        } else {
            subEditorEl.style.display = 'none';
            subEditorEl.innerHTML = '';
        }
    }

    // Console
    document.getElementById('reel-console-title').textContent = 'Console — Reel ' + reelId;
    var reelKey = currentSlug + ':' + reelId;
    document.getElementById('logs-output-reel').textContent = reelLogs[reelKey] || logs[currentSlug] || '';
    var logsEl = document.getElementById('logs-output-reel');
    logsEl.scrollTop = logsEl.scrollHeight;
}

// ─── Reel-Full View ───────────────────────────────────────────────────────────

var reelFullTranscriptData = null;

function renderReelFullView(ep) {
    // Video preview — only recreate if slug changed
    var videoEl = document.getElementById('reel-full-video');
    if (videoEl.dataset.slug !== ep.slug) {
        var videoUrl = '/api/video?slug=' + encodeURIComponent(ep.slug) + '&type=raw&t=' + Date.now();
        videoEl.innerHTML = '<video controls preload="metadata" style="max-height:250px; max-width:100%;" src="' + videoUrl + '"></video>';
        videoEl.dataset.slug = ep.slug;
        // Detect portrait video and switch to side-by-side layout
        var vid = videoEl.querySelector('video');
        if (vid) vid.addEventListener('loadedmetadata', function() {
            var layout = document.getElementById('reel-full-layout');
            if (layout) layout.classList.toggle('portrait', this.videoHeight > this.videoWidth);
        });
    }

    // Caption tab — skip rebuild only if user is actively editing (preserves focus/input state)
    var captionBody = document.getElementById('reel-full-caption-body');
    var captionActions = document.getElementById('reel-full-caption-actions');
    var existingTextarea = document.getElementById('reel-full-caption-textarea');
    if (ep.content && ep.content.reels && ep.content.reels.length > 0) {
        var caption = ep.content.reels[0].caption || '';
        var fieldPath = 'reels.0.caption';
        var textareaId = 'reel-full-caption-textarea';
        var fbInput = document.getElementById('fb-' + textareaId);
        var isUserEditing = fbInput && (fbInput.value.trim() || document.activeElement === fbInput || document.activeElement === existingTextarea);
        if (!existingTextarea) {
            // First render — build the editor
            captionBody.innerHTML =
                '<div class="content-field" data-field="' + fieldPath + '">' +
                    '<div class="content-label" style="font-size:0.75rem; color:#888; margin-bottom:6px;">Reel Caption</div>' +
                    '<textarea class="content-textarea" id="' + textareaId + '" rows="6" dir="rtl" style="text-align:right;" oninput="autoResize(this)">' + escHtml(caption) + '</textarea>' +
                    feedbackRow(fieldPath, textareaId) +
                    '<div class="content-hint" id="hint-' + textareaId + '"></div>' +
                '</div>';
            captionBody.querySelectorAll('.content-textarea').forEach(autoResize);
        } else if (!isUserEditing && existingTextarea.value !== caption) {
            // Caption changed on server (e.g. after generate) and user isn't editing — update
            existingTextarea.value = caption;
            autoResize(existingTextarea);
        }
        captionActions.style.display = 'flex';
    } else {
        captionBody.innerHTML = '<div style="color:#555; font-size:0.8rem; text-align:center; padding:20px;">Run the Caption step to generate a caption.</div>';
        captionActions.style.display = 'none';
    }

    // Transcript tab
    renderReelFullTranscript(ep);
}

async function renderReelFullTranscript(ep) {
    // Pre-load transcript data so modal can open instantly
    if (!ep.steps.transcribed) {
        reelFullTranscriptData = null;
        return;
    }
    if (reelFullTranscriptData) return; // already loaded
    try {
        var res = await fetch('/api/file?slug=' + encodeURIComponent(ep.slug) + '&file=transcript.json');
        if (!res.ok) throw new Error('Not found');
        reelFullTranscriptData = JSON.parse(await res.text());
    } catch (e) {
        reelFullTranscriptData = null;
    }
}

function switchReelFullTab(tab) {
    document.querySelectorAll('.reel-full-tab').forEach(function(el) {
        el.classList.toggle('active', el.dataset.tab === tab);
    });
    ['caption', 'transcript', 'console'].forEach(function(t) {
        var body = document.getElementById('rfTab-' + t);
        if (body) {
            body.classList.toggle('active', t === tab);
            body.style.display = t === tab ? 'flex' : 'none';
        }
    });
}

async function saveReelFullCaption() {
    if (!currentSlug) return;
    var textEl = document.getElementById('reel-full-caption-textarea');
    if (!textEl) return;
    // Visual feedback on Save button
    var saveBtn = document.querySelector('#reel-full-caption-actions button');
    var origText = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) { saveBtn.textContent = 'Saving...'; saveBtn.disabled = true; }
    try {
        var res = await fetch('/api/save-content', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ slug: currentSlug, field: 'reels.0.caption', value: textEl.value })
        });
        var data = await res.json();
        if (data.success) {
            showToast('Caption saved', 'success');
            if (saveBtn) { saveBtn.textContent = 'Saved!'; saveBtn.style.color = 'var(--success)'; }
            setTimeout(function() { if (saveBtn) { saveBtn.textContent = origText; saveBtn.style.color = ''; saveBtn.disabled = false; } }, 2000);
            await refresh();
        } else {
            if (saveBtn) { saveBtn.textContent = origText; saveBtn.disabled = false; }
            showToast(data.error || 'Save failed', 'error');
        }
    } catch (err) {
        if (saveBtn) { saveBtn.textContent = origText; saveBtn.disabled = false; }
        showToast('Save failed: ' + err.message, 'error');
    }
}

function copyReelFullCaption() {
    var textEl = document.getElementById('reel-full-caption-textarea');
    if (textEl) copyToClipboard(textEl.value);
}

// ─── Transcript Editor Modal ─────────────────────────────────────────────────

var tmReelStart = 0, tmReelEnd = Infinity;

async function openTranscriptModal() {
    if (!currentSlug) return;
    var segList = document.getElementById('transcript-modal-seg-list');
    var videoContainer = document.getElementById('transcript-modal-video');

    document.getElementById('transcript-modal').classList.add('open');

    // Load transcript
    if (!reelFullTranscriptData) {
        segList.innerHTML = '<div style="color:#555; font-size:0.8rem; text-align:center; padding:20px;">Loading transcript...</div>';
        try {
            var res = await fetch('/api/file?slug=' + encodeURIComponent(currentSlug) + '&file=transcript.json');
            if (!res.ok) throw new Error('Not found');
            reelFullTranscriptData = JSON.parse(await res.text());
        } catch (e) {
            segList.innerHTML = '<div style="color:#555; font-size:0.8rem; text-align:center; padding:20px;">Transcript not available. Run Transcribe first.</div>';
            return;
        }
    }

    // Load full episode video (only once)
    if (!document.getElementById('tm-video')) {
        var videoUrl = '/api/video?slug=' + encodeURIComponent(currentSlug) + '&type=raw&t=' + Date.now();
        videoContainer.innerHTML = '<video id="tm-video" controls preload="metadata" src="' + videoUrl + '" style="width:100%; display:block;"></video>';
    }

    // Get current reel range
    tmReelStart = 0; tmReelEnd = Infinity;
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    if (selectedReelId && ep && ep.reelStatuses) {
        var reel = ep.reelStatuses.find(function(x) { return x.id === selectedReelId; });
        if (reel) {
            tmReelStart = reel.start ? parseTrimTime(reel.start) : 0;
            tmReelEnd = reel.end ? parseTrimTime(reel.end) : Infinity;
        }
    }

    tmRenderSegments();

    // Seek video to reel start
    var video = document.getElementById('tm-video');
    if (video && tmReelStart > 0) {
        if (video.readyState >= 1) { video.currentTime = tmReelStart; }
        else { video.addEventListener('loadedmetadata', function() { video.currentTime = tmReelStart; }, { once: true }); }
    }

    // Highlight playing segment on timeupdate
    if (video && !video._tmBound) {
        video._tmBound = true;
        video.addEventListener('timeupdate', function() {
            var t = video.currentTime;
            var segs = reelFullTranscriptData ? reelFullTranscriptData.segments : [];
            segList.querySelectorAll('.tm-seg').forEach(function(el, idx) {
                var segStart = segs[idx] ? segs[idx].start : 0;
                var segEnd = segs[idx] ? (segs[idx].end || (segs[idx + 1] ? segs[idx + 1].start : segStart + 5)) : 0;
                var isPlaying = t >= segStart && t < segEnd;
                el.classList.toggle('playing', isPlaying);
                // Auto-scroll to playing segment
                if (isPlaying && !el._scrolled) {
                    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    el._scrolled = true;
                } else if (!isPlaying) {
                    el._scrolled = false;
                }
            });
        });
    }
}

function tmRenderSegments() {
    var segList = document.getElementById('transcript-modal-seg-list');
    var segs = reelFullTranscriptData.segments;
    var html = [];

    for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        var mins = String(Math.floor(seg.start / 60)).padStart(2, '0');
        var secs = String(Math.floor(seg.start % 60)).padStart(2, '0');
        var inRange = seg.start >= tmReelStart && seg.start < tmReelEnd;
        var prevInRange = i > 0 && segs[i - 1].start >= tmReelStart && segs[i - 1].start < tmReelEnd;
        var nextInRange = i < segs.length - 1 && segs[i + 1].start >= tmReelStart && segs[i + 1].start < tmReelEnd;

        // Insert purple divider at start of range
        if (inRange && !prevInRange) {
            html.push('<div class="tm-divider" data-edge="start" onmousedown="tmStartDrag(event, \'start\')"></div>');
        }

        // In-range segments: editable text block (CapCut style)
        if (inRange) {
            html.push(
                '<div class="tm-seg in-range" data-idx="' + i + '" onclick="tmSeekTo(' + seg.start + ')">' +
                    '<span class="tm-text" contenteditable="true" data-seg="' + i + '" data-original="' + escHtml(seg.text) + '" spellcheck="false">' + escHtml(seg.text) + '</span>' +
                    '<span class="tm-ts">' + mins + ':' + secs + '</span>' +
                '</div>'
            );
        } else {
            html.push(
                '<div class="tm-seg" data-idx="' + i + '" onclick="tmSeekTo(' + seg.start + ')">' +
                    '<span class="tm-text">' + escHtml(seg.text) + '</span>' +
                    '<span class="tm-ts">' + mins + ':' + secs + '</span>' +
                '</div>'
            );
        }

        // Insert purple divider at end of range
        if (inRange && !nextInRange) {
            html.push('<div class="tm-divider" data-edge="end" onmousedown="tmStartDrag(event, \'end\')"></div>');
        }
    }

    segList.innerHTML = html.join('');

    // Wire up inline text editing for in-range segments
    segList.querySelectorAll('.tm-text[contenteditable]').forEach(function(el) {
        el.addEventListener('click', function(e) { e.stopPropagation(); });
        el.addEventListener('focus', function(e) { e.stopPropagation(); });
        el.addEventListener('input', function() {
            this.classList.toggle('edited', this.textContent.trim() !== this.dataset.original);
        });
        el.addEventListener('keydown', function(e) {
            var segIdx = parseInt(this.dataset.seg);
            if (e.key === 'Enter') {
                e.preventDefault();
                tmSplitSegment(segIdx, this);
            } else if (e.key === 'Backspace') {
                var sel = window.getSelection();
                if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
                    var offset = sel.getRangeAt(0).startOffset;
                    if (offset === 0) {
                        e.preventDefault();
                        tmMergeWithPrev(segIdx);
                    }
                }
            }
        });
    });

    // Scroll to first in-range segment
    var first = segList.querySelector('.tm-seg.in-range');
    if (first) setTimeout(function() { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 100);
}

function tmSplitSegment(segIdx, el) {
    var segs = reelFullTranscriptData.segments;
    var seg = segs[segIdx];
    if (!seg) return;

    // Get cursor position in text
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var offset = range.startOffset;
    var fullText = el.textContent;

    // Don't split at start or end
    if (offset === 0 || offset >= fullText.length) return;

    var textBefore = fullText.substring(0, offset).trim();
    var textAfter = fullText.substring(offset).trim();
    if (!textBefore || !textAfter) return;

    // Calculate split time proportionally
    var segDur = (seg.end || seg.start) - seg.start;
    var ratio = offset / fullText.length;
    var splitTime = seg.start + segDur * ratio;

    // Build two new segments
    var seg1 = { start: seg.start, end: splitTime, text: textBefore };
    var seg2 = { start: splitTime, end: seg.end || splitTime, text: textAfter };

    // Rebuild word arrays for each
    var wordsBefore = textBefore.split(/\s+/).filter(function(t) { return t; });
    var wordsAfter = textAfter.split(/\s+/).filter(function(t) { return t; });
    var dur1 = splitTime - seg.start;
    var dur2 = (seg.end || splitTime) - splitTime;
    seg1.words = wordsBefore.map(function(w, i) {
        var wd = wordsBefore.length > 0 ? dur1 / wordsBefore.length : dur1;
        return { word: w, start: seg.start + i * wd, end: seg.start + (i + 1) * wd, probability: 0.5 };
    });
    seg2.words = wordsAfter.map(function(w, i) {
        var wd = wordsAfter.length > 0 ? dur2 / wordsAfter.length : dur2;
        return { word: w, start: splitTime + i * wd, end: splitTime + (i + 1) * wd, probability: 0.5 };
    });

    // Splice into segments array
    segs.splice(segIdx, 1, seg1, seg2);

    // Re-render and focus the second segment
    tmRenderSegments();
    var newEl = document.querySelector('.tm-text[data-seg="' + (segIdx + 1) + '"]');
    if (newEl) {
        newEl.focus();
        // Place cursor at start
        var r = document.createRange();
        r.setStart(newEl.firstChild || newEl, 0);
        r.collapse(true);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
    }
}

function tmMergeWithPrev(segIdx) {
    var segs = reelFullTranscriptData.segments;
    if (segIdx <= 0) return;
    var prev = segs[segIdx - 1];
    var curr = segs[segIdx];

    // Only merge if both are in range
    if (!(prev.start >= tmReelStart && prev.start < tmReelEnd)) return;

    var mergedText = prev.text + ' ' + curr.text;
    var prevLen = prev.text.length;

    // Merge into previous segment
    prev.text = mergedText;
    prev.end = curr.end || curr.start;
    prev.words = (prev.words || []).concat(curr.words || []);

    // Remove current segment
    segs.splice(segIdx, 1);

    // Re-render and place cursor at the join point
    tmRenderSegments();
    var el = document.querySelector('.tm-text[data-seg="' + (segIdx - 1) + '"]');
    if (el && el.firstChild) {
        el.focus();
        var r = document.createRange();
        // Place cursor where the two texts joined (+1 for the space)
        var pos = Math.min(prevLen + 1, el.firstChild.textContent.length);
        r.setStart(el.firstChild, pos);
        r.collapse(true);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
    }
}

function tmSeekTo(timeSec) {
    var video = document.getElementById('tm-video');
    if (video) { video.currentTime = timeSec; video.play(); }
}

function tmStartDrag(e, edge) {
    e.preventDefault();
    var divider = e.target;
    divider.classList.add('dragging');
    var segList = document.getElementById('transcript-modal-seg-list');
    var segs = reelFullTranscriptData.segments;

    function onMove(ev) {
        // Find which segment the mouse is nearest to
        var allSegs = segList.querySelectorAll('.tm-seg');
        var closest = null, closestDist = Infinity;
        for (var i = 0; i < allSegs.length; i++) {
            var rect = allSegs[i].getBoundingClientRect();
            var mid = rect.top + rect.height / 2;
            var dist = Math.abs(ev.clientY - mid);
            if (dist < closestDist) { closestDist = dist; closest = i; }
        }
        if (closest === null) return;

        var seg = segs[closest];
        if (edge === 'start') {
            tmReelStart = seg.start;
        } else {
            var endSec = seg.end || (segs[closest + 1] ? segs[closest + 1].start : seg.start + 10);
            tmReelEnd = endSec;
        }
        tmRenderSegments();
    }

    function onUp() {
        document.querySelectorAll('.tm-divider.dragging').forEach(function(d) { d.classList.remove('dragging'); });
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        // Sync back to trim editor inputs
        var ep = episodes.find(function(e) { return e.slug === currentSlug; });
        var reel = ep && selectedReelId && ep.reelStatuses.find(function(x) { return x.id === selectedReelId; });
        if (reel) {
            reel.start = formatTrimTime(tmReelStart);
            reel.end = formatTrimTime(tmReelEnd);
            var startInput = document.getElementById('reel-trim-start');
            var endInput = document.getElementById('reel-trim-end');
            if (startInput) startInput.value = reel.start;
            if (endInput) endInput.value = reel.end;
        }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

function closeTranscriptModal() {
    document.getElementById('transcript-modal').classList.remove('open');
    var video = document.getElementById('tm-video');
    if (video) video.pause();
}

async function saveTranscriptModal() {
    if (!currentSlug || !selectedReelId) { closeTranscriptModal(); return; }
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    var reel = ep && ep.reelStatuses.find(function(x) { return x.id === selectedReelId; });
    if (!reel) { closeTranscriptModal(); return; }

    try {
        var res = await fetch('/api/save-reel-trim', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ slug: currentSlug, reelId: selectedReelId, start: reel.start, end: reel.end, cuts: reel.cuts || [] })
        });
        var data = await res.json();
        if (!data.success) { showToast(data.error || 'Save failed', 'error'); return; }
        showToast('Trim saved — re-cutting reel...', 'success');
        closeTranscriptModal();
        await fetch('/api/run-step', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ slug: currentSlug, step: 'cut', reelId: selectedReelId, force: true })
        });
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function saveTranscriptWords() {
    if (!currentSlug || !reelFullTranscriptData) return;
    var segList = document.getElementById('transcript-modal-seg-list');
    var segs = reelFullTranscriptData.segments;
    var changed = false;

    // Collect edits from contenteditable text blocks
    segList.querySelectorAll('.tm-text[contenteditable]').forEach(function(el) {
        var segIdx = parseInt(el.dataset.seg);
        var seg = segs[segIdx];
        if (!seg) return;
        var newText = el.textContent.trim();
        if (newText !== (seg.text || '').trim()) {
            changed = true;
            seg.text = newText;

            // Rebuild word-level data from edited text, preserving timing spread
            var tokens = newText.split(/\s+/).filter(function(t) { return t.length > 0; });
            var segDur = (seg.end || seg.start || 0) - (seg.start || 0);

            if (seg.words && seg.words.length > 0) {
                // Redistribute existing timing across new word count
                var totalDur = segDur;
                var wordDur = tokens.length > 0 ? totalDur / tokens.length : totalDur;
                seg.words = tokens.map(function(tok, ti) {
                    return { word: tok, start: seg.start + ti * wordDur, end: seg.start + (ti + 1) * wordDur, probability: 0.5 };
                });
            } else {
                // Synthesize word data
                var wordDur = tokens.length > 0 ? segDur / tokens.length : segDur;
                seg.words = tokens.map(function(tok, ti) {
                    return { word: tok, start: seg.start + ti * wordDur, end: seg.start + (ti + 1) * wordDur, probability: 0.5 };
                });
            }
        }
    });

    if (!changed) { showToast('No changes to save', 'success'); return; }

    // Rebuild flattened words array
    reelFullTranscriptData.words = [];
    segs.forEach(function(seg) {
        if (seg.words) seg.words.forEach(function(w) { reelFullTranscriptData.words.push(w); });
    });
    reelFullTranscriptData.full_text = segs.map(function(s) { return s.text; }).join(' ');

    try {
        await fetch('/api/file', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                slug: currentSlug,
                file: 'transcript.json',
                content: JSON.stringify(reelFullTranscriptData, null, 2)
            })
        });
        showToast('Transcript saved!', 'success');
        // Reset edited markers
        segList.querySelectorAll('.tm-text.edited').forEach(function(el) {
            el.dataset.original = el.textContent.trim();
            el.classList.remove('edited');
        });
    } catch (e) {
        showToast('Save failed: ' + e.message, 'error');
    }
}

// ─── End Reel-Full View ──────────────────────────────────────────────────────

function buildReelActions(ep, reel) {
    var reelId = reel.id;
    var steps = [];

    // Build ordered pipeline steps
    if (ep.mediaType === 'episode') {
        steps.push({ id: 'cut', label: 'Cut', done: reel.cut });
    }
    steps.push({ id: 'crop', label: 'Crop', done: reel.cropped, extra:
        '<select id="reel-crop-ratio" class="pipe-inline-select" style="background:transparent; border:none; color:inherit; font-size:0.6rem; padding:0 2px; cursor:pointer;">' +
            '<option value="9:16" style="background:#111;">9:16</option><option value="1:1" style="background:#111;">1:1</option><option value="4:5" style="background:#111;">4:5</option>' +
        '</select>' +
        '<label style="font-size:0.58rem; cursor:pointer; display:flex; align-items:center; gap:2px;">' +
            '<input type="checkbox" id="reel-face-track" style="accent-color:var(--accent); width:12px; height:12px;" checked>Face' +
        '</label>'
    });
    steps.push({ id: 'subtitle', label: 'Sub', done: reel.subtitled });
    steps.push({ id: 'overlay', label: 'Overlay', done: reel.final, extra:
        '<button onclick="event.stopPropagation(); toggleOverlayConfig()" style="background:transparent; border:none; color:inherit; font-size:0.85rem; padding:0 4px; cursor:pointer; opacity:0.8;" title="Configure overlays">&#9881;</button>'
    });

    // Find next undone step
    var nextIdx = steps.findIndex(function(s) { return !s.done; });

    var html = '<div class="reel-pipeline">';
    steps.forEach(function(s, i) {
        var cls = 'pipe-step';
        if (s.done) cls += ' done';
        else if (i === nextIdx) cls += ' next';
        var icon = s.done ? '&#10003;' : (i === nextIdx ? '&#9654;' : '&#9675;');
        if (i > 0) html += '<span class="pipe-sep">&#8250;</span>';
        html += '<button class="' + cls + '" onclick="runReelStep(\'' + reelId + '\', \'' + s.id + '\')">' +
            '<span class="pipe-icon">' + icon + '</span>' + s.label +
        '</button>';
        if (s.extra) html += s.extra;
    });

    // Finalize button — runs remaining steps in sequence
    var remainingSteps = [];
    if (!reel.cropped) remainingSteps.push('Crop');
    if (!reel.subtitled) remainingSteps.push('Sub');
    if (!reel.final) remainingSteps.push('Overlay');
    if (remainingSteps.length > 0) {
        html += '<span class="pipe-sep">&#8250;</span>' +
            '<button class="pipe-step" style="color:#f59e0b; font-weight:600;" onclick="event.stopPropagation(); finalizeReel(\'' + reelId + '\')" title="Run: ' + remainingSteps.join(' → ') + '">' +
            '&#9889; Finalize</button>';
    }

    // Meta actions (hide/delete) pushed to the right
    html += '<div class="pipe-meta">' +
        '<button onclick="toggleHideReel(\'' + reelId + '\')" title="' + (reel.hidden ? 'Show reel' : 'Hide reel') + '">' +
        (reel.hidden ? 'Show' : 'Hide') + '</button>' +
        '<button onclick="deleteReel(\'' + reelId + '\')" style="color:#f87171;" title="Delete reel files">&#128465;</button>' +
    '</div>';

    html += '</div>';
    return html;
}

var pendingCuts = [];

function renderTrimEditor(ep, reel) {
    var trimEl = document.getElementById('reel-trim-editor');
    if (!trimEl) return;
    // Only show for episodes (not pre-cut reels)
    if (ep.mediaType !== 'episode' || !reel.start || !reel.end) {
        trimEl.style.display = 'none';
        return;
    }
    trimEl.style.display = '';

    // Initialize pendingCuts from reel data
    pendingCuts = (reel.cuts || []).map(function(c) { return { from: c.from, to: c.to }; });

    var cutsHtml = '';
    if (pendingCuts.length > 0) {
        cutsHtml = pendingCuts.map(function(c, i) {
            return '<div class="reel-trim-row" style="margin-top:6px; padding:6px 8px; background:#1a0a0a; border:1px solid #3a1c1c; border-radius:6px;">' +
                '<div class="reel-trim-field">' +
                    '<label style="color:#f87171;">Cut from</label>' +
                    '<input type="text" class="trim-cut-from" data-idx="' + i + '" value="' + escHtml(c.from) + '" placeholder="1:00">' +
                '</div>' +
                '<div class="reel-trim-field">' +
                    '<label style="color:#f87171;">Cut to</label>' +
                    '<input type="text" class="trim-cut-to" data-idx="' + i + '" value="' + escHtml(c.to) + '" placeholder="1:15">' +
                '</div>' +
                '<div class="reel-trim-field">' +
                    '<label>Playhead</label>' +
                    '<div style="display:flex; gap:4px;">' +
                        '<button onclick="setCutFromPlayhead(' + i + ', \'from\')" style="font-size:0.6rem; padding:3px 6px;">From</button>' +
                        '<button onclick="setCutFromPlayhead(' + i + ', \'to\')" style="font-size:0.6rem; padding:3px 6px;">To</button>' +
                    '</div>' +
                '</div>' +
                '<button onclick="removeCut(' + i + ', \'' + reel.id + '\')" style="font-size:0.7rem; padding:3px 6px; color:#f87171; align-self:flex-end;" title="Remove this cut">&times;</button>' +
            '</div>';
        }).join('');
    }

    trimEl.innerHTML =
        '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">' +
            '<div style="font-size:0.7rem; color:#666; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Trim</div>' +
            '<div style="flex:1;"></div>' +
            '<button onclick="seekToTrimStart()" style="font-size:0.6rem; padding:2px 6px; color:#666; background:transparent; border:1px solid #333; border-radius:4px;">Jump to start</button>' +
        '</div>' +
        '<div class="reel-trim-row">' +
            '<div class="reel-trim-field">' +
                '<label>In</label>' +
                '<input type="text" id="reel-trim-start" value="' + escHtml(reel.start) + '" placeholder="0:00">' +
            '</div>' +
            '<div class="reel-trim-field">' +
                '<label>Out</label>' +
                '<input type="text" id="reel-trim-end" value="' + escHtml(reel.end) + '" placeholder="1:30">' +
            '</div>' +
            '<div class="reel-trim-field">' +
                '<label>Set from playhead</label>' +
                '<div style="display:flex; gap:4px;">' +
                    '<button onclick="setTrimFromPlayhead(\'start\')" style="font-size:0.6rem; padding:3px 6px;" title="Set start to current video time">In</button>' +
                    '<button onclick="setTrimFromPlayhead(\'end\')" style="font-size:0.6rem; padding:3px 6px;" title="Set end to current video time">Out</button>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div id="trim-cuts-list">' + cutsHtml + '</div>' +
        '<div style="display:flex; gap:6px; margin-top:8px; align-items:center;">' +
            '<button onclick="addCut(\'' + reel.id + '\')" style="font-size:0.65rem; padding:4px 8px; color:#f87171; border-color:#3a1c1c;">+ Cut from middle</button>' +
            '<div style="flex:1;"></div>' +
            '<button class="primary" onclick="saveReelTrim(\'' + reel.id + '\')" style="font-size:0.7rem;">Save & Re-cut</button>' +
        '</div>';
}

// ─── Transcript Context — document-style selection for extending reel bounds ──

var transcriptCache = {};
var ctxState = {
    segments: [],
    startIdx: 0,
    endIdx: 0,
    dragging: null,
    reelId: null,
    slug: null
};
var ctxListeners = { move: null, up: null };

async function loadTranscriptForSlug(slug) {
    if (transcriptCache[slug]) return transcriptCache[slug];
    try {
        var res = await fetch('/api/file?slug=' + encodeURIComponent(slug) + '&file=transcript.json');
        if (!res.ok) return null;
        var data = JSON.parse(await res.text());
        transcriptCache[slug] = data;
        return data;
    } catch (e) {
        return null;
    }
}

var CONTEXT_SECONDS = 60;

async function renderTranscriptContext(ep, reel) {
    var ctxEl = document.getElementById('reel-transcript-ctx');
    if (!ctxEl) return;

    if (ep.mediaType !== 'episode' || !reel.start || !reel.end) {
        ctxEl.style.display = 'none';
        return;
    }

    // Don't rebuild if same reel already shown (preserves user's drag state)
    var key = ep.slug + ':' + reel.id;
    if (ctxState.slug === ep.slug && ctxState.reelId === reel.id && ctxEl.querySelector('.ctx-doc')) {
        return;
    }

    ctxEl.style.display = '';
    ctxEl.innerHTML = '<div class="ctx-header"><span class="ctx-title">Transcript</span><span class="ctx-hint">loading...</span></div>';

    var transcript = await loadTranscriptForSlug(ep.slug);
    if (!transcript || !transcript.segments || !transcript.segments.length) {
        ctxEl.innerHTML = '<div class="ctx-header"><span class="ctx-title">Transcript</span></div>' +
            '<div style="color:#555; font-size:0.75rem; text-align:center; padding:12px;">No transcript available.</div>';
        return;
    }

    var reelStartSec = parseTrimTime(reel.start);
    var reelEndSec = parseTrimTime(reel.end);
    var windowStart = Math.max(0, reelStartSec - CONTEXT_SECONDS);
    var windowEnd = reelEndSec + CONTEXT_SECONDS;

    var segs = transcript.segments;
    ctxState.segments = [];
    var selStart = -1, selEnd = -1;

    for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (s.end < windowStart) continue;
        if (s.start > windowEnd) break;
        var idx = ctxState.segments.length;
        ctxState.segments.push({ start: s.start, end: s.end, text: s.text });
        if (s.start >= reelStartSec - 0.5 && s.end <= reelEndSec + 0.5) {
            if (selStart === -1) selStart = idx;
            selEnd = idx;
        }
    }

    if (!ctxState.segments.length) {
        ctxEl.innerHTML = '<div class="ctx-header"><span class="ctx-title">Transcript</span></div>' +
            '<div style="color:#555; font-size:0.75rem; text-align:center; padding:12px;">No segments in range.</div>';
        return;
    }

    // Fallback: pick closest segment if none matched exactly
    if (selStart === -1) {
        var bestD = Infinity;
        for (var j = 0; j < ctxState.segments.length; j++) {
            var d = Math.abs(ctxState.segments[j].start - reelStartSec);
            if (d < bestD) { bestD = d; selStart = j; }
        }
        selEnd = selStart;
    }

    ctxState.startIdx = selStart;
    ctxState.endIdx = selEnd;
    ctxState.reelId = reel.id;
    ctxState.slug = ep.slug;

    // Build DOM
    var segHtml = ctxState.segments.map(function(seg, i) {
        var m = Math.floor(seg.start / 60);
        var sc = Math.floor(seg.start % 60);
        var ts = String(m).padStart(2, '0') + ':' + String(sc).padStart(2, '0');
        var cls = 'ctx-seg' + (i >= selStart && i <= selEnd ? ' ctx-selected' : '');
        return '<div class="' + cls + '" data-idx="' + i + '">' +
            '<span class="ctx-ts">' + ts + '</span>' +
            '<span class="ctx-text">' + escHtml(seg.text) + '</span>' +
        '</div>';
    }).join('');

    var videoSrc = '/api/video?slug=' + encodeURIComponent(ep.slug) + '&type=raw';

    ctxEl.innerHTML =
        '<div class="ctx-header">' +
            '<span class="ctx-title">Transcript</span>' +
            '<span class="ctx-hint">drag edges or click to preview</span>' +
        '</div>' +
        '<div class="ctx-player"><video id="ctx-video" controls preload="metadata" src="' + videoSrc + '"></video></div>' +
        '<div class="ctx-doc" id="ctx-doc">' +
            segHtml +
            '<div class="ctx-handle" id="ctx-handle-start"></div>' +
            '<div class="ctx-handle" id="ctx-handle-end"></div>' +
        '</div>';

    // Set up video tracking
    var ctxVid = document.getElementById('ctx-video');
    if (ctxVid) {
        ctxVid.currentTime = reelStartSec;
        ctxVid.addEventListener('timeupdate', ctxTrackPlayback);
        ctxVid.addEventListener('pause', ctxClearPlaying);
    }

    ctxPositionHandles();
    ctxInitEvents();
    ctxScrollToSelection();
}

function ctxPositionHandles() {
    var doc = document.getElementById('ctx-doc');
    if (!doc) return;
    var segEls = doc.querySelectorAll('.ctx-seg');
    var hStart = document.getElementById('ctx-handle-start');
    var hEnd = document.getElementById('ctx-handle-end');
    var startEl = segEls[ctxState.startIdx];
    var endEl = segEls[ctxState.endIdx];
    if (startEl && hStart) hStart.style.top = startEl.offsetTop + 'px';
    if (endEl && hEnd) hEnd.style.top = (endEl.offsetTop + endEl.offsetHeight) + 'px';
}

function ctxUpdateSelection() {
    var doc = document.getElementById('ctx-doc');
    if (!doc) return;
    var segEls = doc.querySelectorAll('.ctx-seg');
    for (var i = 0; i < segEls.length; i++) {
        segEls[i].classList.toggle('ctx-selected', i >= ctxState.startIdx && i <= ctxState.endIdx);
    }
    ctxPositionHandles();
}

function ctxCommitBounds() {
    var startSeg = ctxState.segments[ctxState.startIdx];
    var endSeg = ctxState.segments[ctxState.endIdx];
    if (!startSeg || !endSeg) return;
    var si = document.getElementById('reel-trim-start');
    var ei = document.getElementById('reel-trim-end');
    if (si) { si.value = formatTrimTime(startSeg.start); ctxFlash(si); }
    if (ei) { ei.value = formatTrimTime(endSeg.end); ctxFlash(ei); }
}

function ctxFlash(el) {
    el.style.borderColor = 'var(--accent)';
    el.style.background = '#1a0a2a';
    setTimeout(function() { el.style.borderColor = ''; el.style.background = ''; }, 600);
}

function ctxPlaySegment(idx) {
    var seg = ctxState.segments[idx];
    if (!seg) return;
    var video = document.getElementById('ctx-video');
    if (!video) return;
    video.currentTime = seg.start;
    video.play().catch(function() {});
}

function ctxTrackPlayback() {
    var video = document.getElementById('ctx-video');
    if (!video || video.paused) return;
    var t = video.currentTime;
    var doc = document.getElementById('ctx-doc');
    if (!doc) return;
    var segEls = doc.querySelectorAll('.ctx-seg');
    for (var i = 0; i < segEls.length; i++) {
        var seg = ctxState.segments[i];
        var playing = seg && t >= seg.start - 0.1 && t < seg.end + 0.1;
        segEls[i].classList.toggle('ctx-playing', playing);
        if (playing && !ctxState.dragging) {
            var elRect = segEls[i].getBoundingClientRect();
            var docRect = doc.getBoundingClientRect();
            if (elRect.bottom > docRect.bottom - 5 || elRect.top < docRect.top + 5) {
                segEls[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
    }
}

function ctxClearPlaying() {
    var doc = document.getElementById('ctx-doc');
    if (!doc) return;
    var playing = doc.querySelectorAll('.ctx-seg.ctx-playing');
    for (var i = 0; i < playing.length; i++) playing[i].classList.remove('ctx-playing');
}

function ctxFindSegAtY(clientY) {
    var doc = document.getElementById('ctx-doc');
    if (!doc) return -1;
    var segEls = doc.querySelectorAll('.ctx-seg');
    var best = -1, bestDist = Infinity;
    for (var i = 0; i < segEls.length; i++) {
        var rect = segEls[i].getBoundingClientRect();
        var mid = rect.top + rect.height / 2;
        var dist = Math.abs(clientY - mid);
        if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
}

function ctxInitEvents() {
    var doc = document.getElementById('ctx-doc');
    if (!doc) return;
    var hStart = document.getElementById('ctx-handle-start');
    var hEnd = document.getElementById('ctx-handle-end');

    // Clean up previous global listeners
    if (ctxListeners.move) document.removeEventListener('pointermove', ctxListeners.move);
    if (ctxListeners.up) document.removeEventListener('pointerup', ctxListeners.up);

    function onHandleDown(which, e) {
        e.preventDefault();
        ctxState.dragging = which;
        doc.classList.add('ctx-dragging');
        (which === 'start' ? hStart : hEnd).classList.add('dragging');
    }

    hStart.addEventListener('pointerdown', function(e) { onHandleDown('start', e); });
    hEnd.addEventListener('pointerdown', function(e) { onHandleDown('end', e); });

    function onMove(e) {
        if (!ctxState.dragging) return;
        var idx = ctxFindSegAtY(e.clientY);
        if (idx < 0) return;
        if (ctxState.dragging === 'start' && idx <= ctxState.endIdx) {
            ctxState.startIdx = idx;
        } else if (ctxState.dragging === 'end' && idx >= ctxState.startIdx) {
            ctxState.endIdx = idx;
        }
        ctxUpdateSelection();
        // Auto-scroll near edges
        var docRect = doc.getBoundingClientRect();
        if (e.clientY < docRect.top + 30) doc.scrollTop -= 10;
        else if (e.clientY > docRect.bottom - 30) doc.scrollTop += 10;
    }

    function onUp() {
        if (!ctxState.dragging) return;
        var playIdx = ctxState.dragging === 'start' ? ctxState.startIdx : ctxState.endIdx;
        doc.classList.remove('ctx-dragging');
        hStart.classList.remove('dragging');
        hEnd.classList.remove('dragging');
        ctxState.dragging = null;
        ctxCommitBounds();
        ctxPlaySegment(playIdx);
    }

    ctxListeners.move = onMove;
    ctxListeners.up = onUp;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);

    // Click on any segment to preview; click outside selection to extend it
    var segEls = doc.querySelectorAll('.ctx-seg');
    for (var i = 0; i < segEls.length; i++) {
        (function(idx) {
            segEls[idx].addEventListener('click', function() {
                if (ctxState.dragging) return;
                ctxPlaySegment(idx);
                var changed = false;
                if (idx < ctxState.startIdx) {
                    ctxState.startIdx = idx;
                    changed = true;
                } else if (idx > ctxState.endIdx) {
                    ctxState.endIdx = idx;
                    changed = true;
                }
                if (changed) {
                    ctxUpdateSelection();
                    ctxCommitBounds();
                }
            });
        })(i);
    }
}

function ctxScrollToSelection() {
    setTimeout(function() {
        var doc = document.getElementById('ctx-doc');
        if (!doc) return;
        var segEls = doc.querySelectorAll('.ctx-seg');
        var el = segEls[ctxState.startIdx];
        if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }, 50);
}

// Force re-render transcript context (e.g. after manual trim input change)
function ctxRefresh() {
    ctxState.reelId = null;
    ctxState.slug = null;
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    var r = ep && ep.reelStatuses.find(function(x) { return x.id === selectedReelId; });
    if (ep && r) {
        var tempReel = Object.assign({}, r);
        var si = document.getElementById('reel-trim-start');
        var ei = document.getElementById('reel-trim-end');
        if (si) tempReel.start = si.value;
        if (ei) tempReel.end = ei.value;
        renderTranscriptContext(ep, tempReel);
    }
}

// ─── Find & Create Reel from transcript search ───────────────────────────────

var findState = {
    segments: [],
    startIdx: -1,
    endIdx: -1,
    matches: [],
    matchCursor: 0,
    dragging: null,
    query: ''
};
var findListeners = { move: null, up: null };

function openFindReel() {
    if (!currentSlug) return;
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    if (!ep || ep.mediaType !== 'episode') {
        showToast('Only available for episodes with transcripts', 'error');
        return;
    }

    // Hide reel detail, show find panel
    selectedReelId = null;
    document.getElementById('reel-detail-empty').style.display = 'none';
    document.getElementById('reel-detail').style.display = 'none';
    document.getElementById('find-reel-panel').style.display = 'flex';

    // Deselect reel list items
    document.querySelectorAll('.reel-list-item.active').forEach(function(el) { el.classList.remove('active'); });

    findState = { segments: [], startIdx: -1, endIdx: -1, matches: [], matchCursor: 0, dragging: null, query: '' };

    var panel = document.getElementById('find-reel-panel');
    panel.innerHTML =
        '<div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">' +
            '<div style="font-size:0.8rem; font-weight:600; color:#ddd;">New Reel</div>' +
            '<div style="flex:1;"></div>' +
            '<button onclick="closeFindReel()" style="font-size:0.7rem; color:#666; background:transparent; border:1px solid #333; padding:3px 8px;">Close</button>' +
        '</div>' +
        '<div class="find-reel-search">' +
            '<input type="text" id="find-reel-input" placeholder="Search transcript..." oninput="findReelSearch(this.value)">' +
            '<div class="match-nav">' +
                '<span id="find-match-count"></span>' +
                '<button onclick="findReelNav(-1)" title="Previous">&uarr;</button>' +
                '<button onclick="findReelNav(1)" title="Next">&darr;</button>' +
            '</div>' +
        '</div>' +
        '<div class="find-reel-body" id="find-reel-body">' +
            '<div style="color:#555; font-size:0.75rem; text-align:center; padding:20px;">Loading transcript...</div>' +
        '</div>' +
        '<div class="find-reel-actions" id="find-reel-actions" style="display:none;">' +
            '<input type="text" id="find-reel-hook" placeholder="Reel hook / description (optional)">' +
            '<button class="primary" onclick="createReelFromFind()" style="font-size:0.75rem; white-space:nowrap;">Create Reel</button>' +
        '</div>';

    loadFindTranscript(ep);
}

function closeFindReel() {
    document.getElementById('find-reel-panel').style.display = 'none';
    document.getElementById('reel-detail-empty').style.display = '';
    // Clean up global listeners
    if (findListeners.move) document.removeEventListener('pointermove', findListeners.move);
    if (findListeners.up) document.removeEventListener('pointerup', findListeners.up);
    findListeners = { move: null, up: null };
}

async function loadFindTranscript(ep) {
    var transcript = await loadTranscriptForSlug(ep.slug);
    if (!transcript || !transcript.segments || !transcript.segments.length) {
        document.getElementById('find-reel-body').innerHTML =
            '<div style="color:#555; font-size:0.75rem; text-align:center; padding:20px;">No transcript available.</div>';
        return;
    }

    findState.segments = transcript.segments.map(function(s) {
        return { start: s.start, end: s.end, text: s.text };
    });

    renderFindDoc();
    document.getElementById('find-reel-input').focus();
}

function renderFindDoc() {
    var body = document.getElementById('find-reel-body');
    if (!body) return;

    var videoSrc = '/api/video?slug=' + encodeURIComponent(currentSlug) + '&type=raw';

    var segHtml = findState.segments.map(function(seg, i) {
        var m = Math.floor(seg.start / 60);
        var s = Math.floor(seg.start % 60);
        var ts = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        var selected = findState.startIdx >= 0 && i >= findState.startIdx && i <= findState.endIdx;
        var cls = 'ctx-seg' + (selected ? ' ctx-selected' : '');
        var textHtml = escHtml(seg.text);
        if (findState.query) {
            textHtml = findHighlight(textHtml, findState.query);
        }
        return '<div class="' + cls + '" data-idx="' + i + '">' +
            '<span class="ctx-ts">' + ts + '</span>' +
            '<span class="ctx-text">' + textHtml + '</span>' +
        '</div>';
    }).join('');

    body.innerHTML =
        '<div class="ctx-player"><video id="find-video" controls preload="metadata" src="' + videoSrc + '"></video></div>' +
        '<div class="ctx-doc" id="find-doc" style="flex:1; max-height:none;">' +
            segHtml +
            '<div class="ctx-handle" id="find-handle-start" style="display:none;"></div>' +
            '<div class="ctx-handle" id="find-handle-end" style="display:none;"></div>' +
        '</div>';

    // Video tracking
    var vid = document.getElementById('find-video');
    if (vid) {
        vid.addEventListener('timeupdate', findTrackPlayback);
        vid.addEventListener('pause', findClearPlaying);
    }

    findInitEvents();
    if (findState.startIdx >= 0) {
        findPositionHandles();
        findShowHandles(true);
    }
}

function findHighlight(html, query) {
    if (!query) return html;
    // Escape regex special chars in query
    var escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('(' + escaped + ')', 'gi');
    return html.replace(re, '<mark>$1</mark>');
}

function findReelSearch(q) {
    findState.query = q.trim();
    var countEl = document.getElementById('find-match-count');

    if (!findState.query) {
        findState.matches = [];
        findState.matchCursor = 0;
        if (countEl) countEl.textContent = '';
        findApplyHighlights();
        return;
    }

    // Find matching segment indices
    var lower = findState.query.toLowerCase();
    findState.matches = [];
    for (var i = 0; i < findState.segments.length; i++) {
        if (findState.segments[i].text.toLowerCase().indexOf(lower) !== -1) {
            findState.matches.push(i);
        }
    }
    findState.matchCursor = 0;

    if (countEl) {
        countEl.textContent = findState.matches.length ? (findState.matchCursor + 1) + '/' + findState.matches.length : '0';
    }

    findApplyHighlights();

    // Scroll to first match
    if (findState.matches.length > 0) {
        findScrollToMatch(findState.matchCursor);
    }
}

function findReelNav(dir) {
    if (!findState.matches.length) return;
    findState.matchCursor = (findState.matchCursor + dir + findState.matches.length) % findState.matches.length;
    var countEl = document.getElementById('find-match-count');
    if (countEl) countEl.textContent = (findState.matchCursor + 1) + '/' + findState.matches.length;
    findScrollToMatch(findState.matchCursor);
}

function findScrollToMatch(cursor) {
    var doc = document.getElementById('find-doc');
    if (!doc) return;
    var idx = findState.matches[cursor];
    var segEls = doc.querySelectorAll('.ctx-seg');
    if (segEls[idx]) segEls[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function findApplyHighlights() {
    var doc = document.getElementById('find-doc');
    if (!doc) return;
    var segEls = doc.querySelectorAll('.ctx-seg');
    var matchSet = new Set(findState.matches);
    for (var i = 0; i < segEls.length; i++) {
        segEls[i].classList.toggle('ctx-match', matchSet.has(i));
        // Update text with/without highlights
        var textEl = segEls[i].querySelector('.ctx-text');
        if (textEl) {
            var raw = escHtml(findState.segments[i].text);
            textEl.innerHTML = findState.query ? findHighlight(raw, findState.query) : raw;
        }
    }
}

function findPlaySegment(idx) {
    var seg = findState.segments[idx];
    if (!seg) return;
    var video = document.getElementById('find-video');
    if (!video) return;
    video.currentTime = seg.start;
    video.play().catch(function() {});
}

function findTrackPlayback() {
    var video = document.getElementById('find-video');
    if (!video || video.paused) return;
    var t = video.currentTime;
    var doc = document.getElementById('find-doc');
    if (!doc) return;
    var segEls = doc.querySelectorAll('.ctx-seg');
    for (var i = 0; i < segEls.length; i++) {
        var seg = findState.segments[i];
        var playing = seg && t >= seg.start - 0.1 && t < seg.end + 0.1;
        segEls[i].classList.toggle('ctx-playing', playing);
        if (playing && !findState.dragging) {
            var elRect = segEls[i].getBoundingClientRect();
            var docRect = doc.getBoundingClientRect();
            if (elRect.bottom > docRect.bottom - 5 || elRect.top < docRect.top + 5) {
                segEls[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
    }
}

function findClearPlaying() {
    var doc = document.getElementById('find-doc');
    if (!doc) return;
    var playing = doc.querySelectorAll('.ctx-seg.ctx-playing');
    for (var i = 0; i < playing.length; i++) playing[i].classList.remove('ctx-playing');
}

function findUpdateSelection() {
    var doc = document.getElementById('find-doc');
    if (!doc) return;
    var segEls = doc.querySelectorAll('.ctx-seg');
    for (var i = 0; i < segEls.length; i++) {
        segEls[i].classList.toggle('ctx-selected', findState.startIdx >= 0 && i >= findState.startIdx && i <= findState.endIdx);
    }
    findPositionHandles();

    // Show/hide create actions
    var actionsEl = document.getElementById('find-reel-actions');
    if (actionsEl) actionsEl.style.display = findState.startIdx >= 0 ? 'flex' : 'none';
}

function findPositionHandles() {
    var doc = document.getElementById('find-doc');
    if (!doc || findState.startIdx < 0) return;
    var segEls = doc.querySelectorAll('.ctx-seg');
    var hStart = document.getElementById('find-handle-start');
    var hEnd = document.getElementById('find-handle-end');
    var startEl = segEls[findState.startIdx];
    var endEl = segEls[findState.endIdx];
    if (startEl && hStart) hStart.style.top = startEl.offsetTop + 'px';
    if (endEl && hEnd) hEnd.style.top = (endEl.offsetTop + endEl.offsetHeight) + 'px';
}

function findShowHandles(show) {
    var hStart = document.getElementById('find-handle-start');
    var hEnd = document.getElementById('find-handle-end');
    if (hStart) hStart.style.display = show ? '' : 'none';
    if (hEnd) hEnd.style.display = show ? '' : 'none';
}

function findFindSegAtY(clientY) {
    var doc = document.getElementById('find-doc');
    if (!doc) return -1;
    var segEls = doc.querySelectorAll('.ctx-seg');
    var best = -1, bestDist = Infinity;
    for (var i = 0; i < segEls.length; i++) {
        var rect = segEls[i].getBoundingClientRect();
        var mid = rect.top + rect.height / 2;
        var dist = Math.abs(clientY - mid);
        if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
}

function findInitEvents() {
    var doc = document.getElementById('find-doc');
    if (!doc) return;
    var hStart = document.getElementById('find-handle-start');
    var hEnd = document.getElementById('find-handle-end');

    if (findListeners.move) document.removeEventListener('pointermove', findListeners.move);
    if (findListeners.up) document.removeEventListener('pointerup', findListeners.up);

    function onHandleDown(which, e) {
        e.preventDefault();
        findState.dragging = which;
        doc.classList.add('ctx-dragging');
        (which === 'start' ? hStart : hEnd).classList.add('dragging');
    }

    hStart.addEventListener('pointerdown', function(e) { onHandleDown('start', e); });
    hEnd.addEventListener('pointerdown', function(e) { onHandleDown('end', e); });

    function onMove(e) {
        if (!findState.dragging) return;
        var idx = findFindSegAtY(e.clientY);
        if (idx < 0) return;
        if (findState.dragging === 'start' && idx <= findState.endIdx) {
            findState.startIdx = idx;
        } else if (findState.dragging === 'end' && idx >= findState.startIdx) {
            findState.endIdx = idx;
        }
        findUpdateSelection();
        var docRect = doc.getBoundingClientRect();
        if (e.clientY < docRect.top + 30) doc.scrollTop -= 10;
        else if (e.clientY > docRect.bottom - 30) doc.scrollTop += 10;
    }

    function onUp() {
        if (!findState.dragging) return;
        var playIdx = findState.dragging === 'start' ? findState.startIdx : findState.endIdx;
        doc.classList.remove('ctx-dragging');
        hStart.classList.remove('dragging');
        hEnd.classList.remove('dragging');
        findState.dragging = null;
        findPlaySegment(playIdx);
    }

    findListeners.move = onMove;
    findListeners.up = onUp;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);

    // Click segments: first click sets selection, subsequent clicks extend it
    var segEls = doc.querySelectorAll('.ctx-seg');
    for (var i = 0; i < segEls.length; i++) {
        (function(idx) {
            segEls[idx].addEventListener('click', function() {
                if (findState.dragging) return;
                findPlaySegment(idx);
                if (findState.startIdx < 0) {
                    // First click: start selection at this segment
                    findState.startIdx = idx;
                    findState.endIdx = idx;
                    findShowHandles(true);
                } else if (idx < findState.startIdx) {
                    findState.startIdx = idx;
                } else if (idx > findState.endIdx) {
                    findState.endIdx = idx;
                }
                findUpdateSelection();
            });
        })(i);
    }
}

async function createReelFromFind() {
    if (!currentSlug || findState.startIdx < 0) return;
    var startSeg = findState.segments[findState.startIdx];
    var endSeg = findState.segments[findState.endIdx];
    if (!startSeg || !endSeg) return;

    var start = formatTrimTime(startSeg.start);
    var end = formatTrimTime(endSeg.end);
    var hookEl = document.getElementById('find-reel-hook');
    var hook = hookEl ? hookEl.value.trim() : '';

    try {
        var res = await fetch('/api/add-reel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: currentSlug, start: start, end: end, hook: hook })
        });
        var data = await res.json();
        if (!data.success) { showToast(data.error || 'Failed to create reel', 'error'); return; }

        showToast('Reel created! Cutting...', 'success');
        closeFindReel();
        await refresh();

        // Select the new reel and trigger cut
        selectReel(data.reelId);
        await fetch('/api/run-step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: currentSlug, step: 'cut', reelId: data.reelId, force: true })
        });
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

function addCut(reelId) {
    pendingCuts.push({ from: '', to: '' });
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    var r = ep && ep.reelStatuses.find(function(x) { return x.id === reelId; });
    if (r) {
        // Preserve current input values before re-render
        syncCutInputs();
        r.cuts = pendingCuts;
        renderTrimEditor(ep, r);
    }
}

function removeCut(idx, reelId) {
    syncCutInputs();
    pendingCuts.splice(idx, 1);
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    var r = ep && ep.reelStatuses.find(function(x) { return x.id === reelId; });
    if (r) {
        r.cuts = pendingCuts;
        renderTrimEditor(ep, r);
    }
}

function syncCutInputs() {
    // Sync input values back into pendingCuts and preserve start/end
    document.querySelectorAll('.trim-cut-from').forEach(function(el) {
        var i = parseInt(el.dataset.idx);
        if (pendingCuts[i]) pendingCuts[i].from = el.value.trim();
    });
    document.querySelectorAll('.trim-cut-to').forEach(function(el) {
        var i = parseInt(el.dataset.idx);
        if (pendingCuts[i]) pendingCuts[i].to = el.value.trim();
    });
}

function setCutFromPlayhead(idx, which) {
    var video = getReelVideo();
    if (!video) { showToast('No video loaded', 'error'); return; }

    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    var r = ep && ep.reelStatuses.find(function(x) { return x.id === selectedReelId; });
    var offset = 0;
    if (r && r.cut && r.start) offset = parseTrimTime(r.start);

    var time = formatTrimTime(video.currentTime + offset);
    var selector = which === 'from' ? '.trim-cut-from' : '.trim-cut-to';
    var el = document.querySelector(selector + '[data-idx="' + idx + '"]');
    if (el) el.value = time;
}

function getReelVideo() {
    var previewEl = document.getElementById('reel-preview');
    return previewEl ? previewEl.querySelector('video') : null;
}

function seekToTrimStart() {
    var startInput = document.getElementById('reel-trim-start');
    if (!startInput) return;
    var video = getReelVideo();
    if (!video) return;
    video.currentTime = parseTrimTime(startInput.value);
}

function parseTrimTime(ts) {
    if (!ts) return 0;
    var parts = ts.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parseFloat(ts) || 0;
}

function formatTrimTime(totalSec) {
    totalSec = Math.round(totalSec * 10) / 10;
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(Math.floor(s)).padStart(2, '0');
    return m + ':' + String(Math.floor(s)).padStart(2, '0');
}

function setTrimFromPlayhead(which) {
    var video = getReelVideo();
    if (!video) { showToast('No video loaded', 'error'); return; }

    // If the video is showing a processed reel, we need to get the reel's start offset
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    var r = ep && ep.reelStatuses.find(function(x) { return x.id === selectedReelId; });

    // If the reel has already been cut, the video starts at 0 relative to the reel
    // so we need to add the original start time
    var offset = 0;
    if (r && r.cut && r.start) {
        offset = parseTrimTime(r.start);
    }

    var time = video.currentTime + offset;
    var inputId = which === 'start' ? 'reel-trim-start' : 'reel-trim-end';
    var input = document.getElementById(inputId);
    if (input) input.value = formatTrimTime(time);
}

async function saveReelTrim(reelId) {
    if (!currentSlug) return;
    var startEl = document.getElementById('reel-trim-start');
    var endEl = document.getElementById('reel-trim-end');
    if (!startEl || !endEl) return;

    var start = startEl.value.trim();
    var end = endEl.value.trim();
    if (!start || !end) { showToast('Start and end times are required', 'error'); return; }

    // Validate: end > start
    var startSec = parseTrimTime(start);
    var endSec = parseTrimTime(end);
    if (endSec <= startSec) {
        showToast('End time must be after start time', 'error');
        return;
    }

    // Collect cuts from inputs
    syncCutInputs();
    var cuts = pendingCuts.filter(function(c) { return c.from && c.to; });

    // Validate each cut is within bounds and from < to
    for (var i = 0; i < cuts.length; i++) {
        var cf = parseTrimTime(cuts[i].from);
        var ct = parseTrimTime(cuts[i].to);
        if (ct <= cf) {
            showToast('Cut ' + (i + 1) + ': "to" must be after "from"', 'error');
            return;
        }
        if (cf < startSec || ct > endSec) {
            showToast('Cut ' + (i + 1) + ' is outside the reel range', 'error');
            return;
        }
    }

    try {
        var res = await fetch('/api/save-reel-trim', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ slug: currentSlug, reelId: reelId, start: start, end: end, cuts: cuts })
        });
        var data = await res.json();
        if (!data.success) { showToast(data.error || 'Save failed', 'error'); return; }

        showToast('Trim saved — re-cutting reel...', 'success');

        // Trigger re-cut automatically
        await fetch('/api/run-step', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ slug: currentSlug, step: 'cut', reelId: reelId, force: true })
        });
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function loadReelSubtitles(reelId) {
    if (!currentSlug) return;
    var padded = String(reelId).padStart(2, '0');
    try {
        var res = await fetch('/api/file?slug=' + currentSlug + '&file=reels/reel-' + padded + '.ass');
        if (res.ok) {
            var text = await res.text();
            document.getElementById('reel-subtitle-content').style.display = '';
            document.getElementById('reel-subtitle-text').value = text;
        } else {
            showToast('No subtitle file found for reel ' + reelId, 'error');
        }
    } catch (err) {
        showToast('Failed to load subtitles: ' + err.message, 'error');
    }
}

async function saveReelSubtitles(reelId) {
    if (!currentSlug) return;
    var padded = String(reelId).padStart(2, '0');
    var textEl = document.getElementById('reel-subtitle-text');
    if (!textEl) return;
    var content = textEl.value;
    try {
        // Save the subtitle file
        var res = await fetch('/api/file', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slug: currentSlug, file: 'reels/reel-' + padded + '.ass', content: content})
        });
        var data = await res.json();
        if (data.success) {
            showToast('Subtitles saved. Re-burning...', 'success');
            // Re-burn using existing ASS (burn-only mode preserves edits)
            var burnRes = await fetch('/api/run-step', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    slug: currentSlug,
                    step: 'subtitle',
                    reelId: reelId,
                    force: true,
                    burnOnly: true
                })
            });
        } else {
            showToast(data.error || 'Save failed', 'error');
        }
    } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
    }
}

async function saveReelCaption(reelId) {
    if (!currentSlug) return;
    var textEl = document.getElementById('reel-caption-text');
    if (!textEl) return;
    var caption = textEl.value;
    try {
        var res = await fetch('/api/save-reel-caption', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slug: currentSlug, reelId: reelId, caption: caption})
        });
        var data = await res.json();
        if (data.success) {
            showToast('Caption saved', 'success');
            await refresh();
        } else {
            showToast(data.error || 'Save failed', 'error');
        }
    } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(function() {
        showToast('Copied!', 'success');
    }).catch(function() {
        // Fallback
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Copied!', 'success');
    });
}

async function runReelStep(reelId, step) {
    if (!currentSlug) return;
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    if (!ep) return;

    if (step === 'generate' && (!ep.guest || !ep.role)) {
        showToast('Set guest name and role first', 'error');
        editMeta();
        return;
    }

    var body = {
        slug: currentSlug,
        step: step,
        reelId: reelId,
        force: true
    };

    if (step === 'crop') {
        var ratioEl = document.getElementById('reel-crop-ratio');
        body.ratio = ratioEl ? ratioEl.value : '9:16';
        var ftEl = document.getElementById('reel-face-track');
        body.faceTrack = ftEl ? ftEl.checked : false;
    }

    try {
        var res = await fetch('/api/run-step', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
        var data = await res.json();
        if (!data.success) showToast(data.error, 'error');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── Overlay Config Panel ─────────────────────────────────────────────────

async function toggleOverlayConfig() {
    const section = document.getElementById('overlay-config-section');
    if (section.style.display !== 'none' && section.innerHTML) {
        section.style.display = 'none';
        section.innerHTML = '';
        return;
    }
    section.style.display = '';
    overlayImageCache = {}; // clear image cache so fresh previews load
    // Load config
    try {
        const res = await fetch('/api/overlay-config/' + encodeURIComponent(currentSlug));
        overlayConfig = await res.json();
    } catch (e) {
        overlayConfig = {
            sponsor: { enabled: true, x: 1.3, y: 1.2, scale: 180 },
            logo: { enabled: true, x: 92.3, y: 1.2, scale: 140 },
            lowerThird: { enabled: false, startTime: 2, endTime: 8 },
            cta: { enabled: false, mode: 'text', text: 'www.tajarib.show', fontSize: 28, fontColor: '#ffffff', imagePath: '', x: 50, y: 85, scale: 200, startTime: 50, endTime: 58 }
        };
    }
    renderOverlayConfig();
}

function renderOverlayConfig() {
    const section = document.getElementById('overlay-config-section');
    const c = overlayConfig;
    section.innerHTML =
        '<div class="overlay-config">' +
            '<h3>Overlay Configuration</h3>' +
            '<div style="display:flex; gap:16px; flex-wrap:wrap;">' +
                // Canvas
                '<div style="flex:1; min-width:180px; max-width:300px;">' +
                    '<div style="display:flex; gap:4px; margin-bottom:6px;">' +
                        '<button class="' + (overlayCanvasRatio === '16:9' ? 'primary' : '') + '" onclick="overlayCanvasRatio=\'16:9\'; renderOverlayConfig();" style="font-size:0.65rem; padding:3px 8px;">16:9</button>' +
                        '<button class="' + (overlayCanvasRatio === '9:16' ? 'primary' : '') + '" onclick="overlayCanvasRatio=\'9:16\'; renderOverlayConfig();" style="font-size:0.65rem; padding:3px 8px;">9:16</button>' +
                        '<button class="' + (overlayCanvasRatio === '1:1' ? 'primary' : '') + '" onclick="overlayCanvasRatio=\'1:1\'; renderOverlayConfig();" style="font-size:0.65rem; padding:3px 8px;">1:1</button>' +
                    '</div>' +
                    '<div class="overlay-canvas-wrap">' +
                        '<canvas id="overlay-canvas" width="' + (overlayCanvasRatio === '9:16' ? 270 : overlayCanvasRatio === '1:1' ? 300 : 640) + '" height="' + (overlayCanvasRatio === '9:16' ? 480 : overlayCanvasRatio === '1:1' ? 300 : 360) + '"></canvas>' +
                    '</div>' +
                    '<div style="font-size:0.65rem; color:#555; margin-top:4px;">Drag elements to reposition</div>' +
                '</div>' +
                // Controls
                '<div style="flex:1; min-width:260px;" class="overlay-elements">' +
                    // Sponsor
                    '<div class="overlay-el">' +
                        '<div class="overlay-el-header">' +
                            '<label>Sponsor</label>' +
                            '<input type="checkbox" id="ov-sponsor-on" ' + (c.sponsor.enabled ? 'checked' : '') + ' onchange="overlayConfig.sponsor.enabled=this.checked; drawOverlayCanvas();">' +
                        '</div>' +
                        '<div class="overlay-el-body">' +
                            '<div class="overlay-row"><label>X</label><input type="range" min="0" max="100" step="0.5" value="' + c.sponsor.x + '" oninput="overlayConfig.sponsor.x=+this.value; this.nextSibling.textContent=this.value+\'%\'; drawOverlayCanvas();"><span>' + c.sponsor.x + '%</span></div>' +
                            '<div class="overlay-row"><label>Y</label><input type="range" min="0" max="100" step="0.5" value="' + c.sponsor.y + '" oninput="overlayConfig.sponsor.y=+this.value; this.nextSibling.textContent=this.value+\'%\'; drawOverlayCanvas();"><span>' + c.sponsor.y + '%</span></div>' +
                            '<div class="overlay-row"><label>Scale</label><input type="range" min="80" max="300" value="' + c.sponsor.scale + '" oninput="overlayConfig.sponsor.scale=+this.value; this.nextSibling.textContent=this.value+\'px\'; drawOverlayCanvas();"><span>' + c.sponsor.scale + 'px</span></div>' +
                        '</div>' +
                    '</div>' +
                    // Logo
                    '<div class="overlay-el">' +
                        '<div class="overlay-el-header">' +
                            '<label>Logo</label>' +
                            '<input type="checkbox" id="ov-logo-on" ' + (c.logo.enabled ? 'checked' : '') + ' onchange="overlayConfig.logo.enabled=this.checked; drawOverlayCanvas();">' +
                        '</div>' +
                        '<div class="overlay-el-body">' +
                            '<div class="overlay-row"><label>X</label><input type="range" min="0" max="100" step="0.5" value="' + c.logo.x + '" oninput="overlayConfig.logo.x=+this.value; this.nextSibling.textContent=this.value+\'%\'; drawOverlayCanvas();"><span>' + c.logo.x + '%</span></div>' +
                            '<div class="overlay-row"><label>Y</label><input type="range" min="0" max="100" step="0.5" value="' + c.logo.y + '" oninput="overlayConfig.logo.y=+this.value; this.nextSibling.textContent=this.value+\'%\'; drawOverlayCanvas();"><span>' + c.logo.y + '%</span></div>' +
                            '<div class="overlay-row"><label>Scale</label><input type="range" min="60" max="250" value="' + c.logo.scale + '" oninput="overlayConfig.logo.scale=+this.value; this.nextSibling.textContent=this.value+\'px\'; drawOverlayCanvas();"><span>' + c.logo.scale + 'px</span></div>' +
                        '</div>' +
                    '</div>' +
                    // Lower Third
                    '<div class="overlay-el">' +
                        '<div class="overlay-el-header">' +
                            '<label>Lower Third (Guest CG)</label>' +
                            '<input type="checkbox" id="ov-lt-on" ' + (c.lowerThird.enabled ? 'checked' : '') + ' onchange="overlayConfig.lowerThird.enabled=this.checked; drawOverlayCanvas();">' +
                        '</div>' +
                        '<div class="overlay-el-body">' +
                            '<div class="cta-mode-toggle" style="margin-bottom:6px;">' +
                                '<button class="' + (c.lowerThird.mode !== 'custom' ? 'active' : '') + '" onclick="overlayConfig.lowerThird.mode=\'auto\'; renderOverlayConfig();" style="font-size:0.65rem;">Auto</button>' +
                                '<button class="' + (c.lowerThird.mode === 'custom' ? 'active' : '') + '" onclick="overlayConfig.lowerThird.mode=\'custom\'; renderOverlayConfig();" style="font-size:0.65rem;">Custom File</button>' +
                            '</div>' +
                            (c.lowerThird.mode === 'custom' ?
                                '<div class="overlay-row"><label>File</label>' +
                                    '<select id="lt-asset-picker" onchange="selectLowerThirdAsset(this.value)" style="font-size:0.65rem; flex:1; background:#222; color:#ccc; border:1px solid #444; border-radius:4px; padding:2px 4px;">' +
                                        '<option value="">' + (c.lowerThird.customFile ? c.lowerThird.customFile : '-- Select file --') + '</option>' +
                                    '</select>' +
                                    '<button onclick="document.getElementById(\'lt-upload-input\').click()" style="font-size:0.6rem; padding:2px 6px; margin-left:4px; cursor:pointer;" title="Upload new file">+</button>' +
                                    '<input type="file" id="lt-upload-input" accept=".mov,.mp4,.png,.gif" onchange="uploadLowerThirdAsset(this.files[0]);" style="display:none;">' +
                                '</div>' +
                                (c.lowerThird.customFile ? '<div style="font-size:0.6rem; color:var(--success); margin-bottom:4px;">&#10003; ' + c.lowerThird.customFile + '</div>' : '') +
                                '<div class="overlay-row"><label>Scale</label><input type="range" min="100" max="600" value="' + (c.lowerThird.scale || 300) + '" oninput="overlayConfig.lowerThird.scale=+this.value; this.nextSibling.textContent=this.value+\'px\'; drawOverlayCanvas();"><span>' + (c.lowerThird.scale || 300) + 'px</span></div>' +
                                '<div class="overlay-row"><label>X</label><input type="range" min="0" max="100" step="0.5" value="' + (c.lowerThird.x || 5) + '" oninput="overlayConfig.lowerThird.x=+this.value; this.nextSibling.textContent=this.value+\'%\'; drawOverlayCanvas();"><span>' + (c.lowerThird.x || 5) + '%</span></div>' +
                                '<div class="overlay-row"><label>Y</label><input type="range" min="0" max="100" step="0.5" value="' + (c.lowerThird.y || 80) + '" oninput="overlayConfig.lowerThird.y=+this.value; this.nextSibling.textContent=this.value+\'%\'; drawOverlayCanvas();"><span>' + (c.lowerThird.y || 80) + '%</span></div>'
                            : '') +
                            '<div class="overlay-row"><label>Start</label><input type="range" min="0" max="300" step="0.5" value="' + c.lowerThird.startTime + '" oninput="overlayConfig.lowerThird.startTime=+this.value; this.nextSibling.textContent=this.value+\'s\'; drawOverlayCanvas();"><span>' + c.lowerThird.startTime + 's</span></div>' +
                            '<div class="overlay-row"><label>End</label><input type="range" min="1" max="300" step="0.5" value="' + c.lowerThird.endTime + '" oninput="overlayConfig.lowerThird.endTime=+this.value; this.nextSibling.textContent=this.value+\'s\'; drawOverlayCanvas();"><span>' + c.lowerThird.endTime + 's</span></div>' +
                        '</div>' +
                    '</div>' +
                    // CTA
                    '<div class="overlay-el">' +
                        '<div class="overlay-el-header">' +
                            '<label>CTA</label>' +
                            '<input type="checkbox" id="ov-cta-on" ' + (c.cta.enabled ? 'checked' : '') + ' onchange="overlayConfig.cta.enabled=this.checked; drawOverlayCanvas();">' +
                        '</div>' +
                        '<div class="overlay-el-body">' +
                            '<div class="cta-mode-toggle">' +
                                '<button class="' + (c.cta.mode === 'text' ? 'active' : '') + '" onclick="overlayConfig.cta.mode=\'text\'; renderOverlayConfig();">Text</button>' +
                                '<button class="' + (c.cta.mode === 'image' ? 'active' : '') + '" onclick="overlayConfig.cta.mode=\'image\'; renderOverlayConfig();">Image</button>' +
                            '</div>' +
                            (c.cta.mode === 'text' ?
                                '<div class="overlay-row"><label>Text</label><input type="text" value="' + (c.cta.text || '').replace(/"/g, '&quot;') + '" oninput="overlayConfig.cta.text=this.value; drawOverlayCanvas();"></div>' +
                                '<div class="overlay-row"><label>Size</label><input type="range" min="14" max="48" value="' + c.cta.fontSize + '" oninput="overlayConfig.cta.fontSize=+this.value; this.nextSibling.textContent=this.value+\'pt\'; drawOverlayCanvas();"><span>' + c.cta.fontSize + 'pt</span></div>' +
                                '<div class="overlay-row"><label>Color</label><input type="color" value="' + (c.cta.fontColor || '#ffffff') + '" oninput="overlayConfig.cta.fontColor=this.value; drawOverlayCanvas();"></div>'
                            :
                                '<div class="overlay-row"><label>File</label><input type="file" accept=".png,.mov,.mp4,.gif" onchange="uploadCTAAsset(this.files[0]);" style="font-size:0.65rem; color:#888;"></div>' +
                                '<div class="overlay-row"><label>Scale</label><input type="range" min="50" max="400" value="' + c.cta.scale + '" oninput="overlayConfig.cta.scale=+this.value; this.nextSibling.textContent=this.value+\'px\'; drawOverlayCanvas();"><span>' + c.cta.scale + 'px</span></div>'
                            ) +
                            '<div class="overlay-row"><label>Show</label><input type="range" min="0" max="120" step="1" value="' + c.cta.startTime + '" oninput="overlayConfig.cta.startTime=+this.value; this.nextSibling.textContent=this.value+\'s\'; drawOverlayCanvas();"><span>' + c.cta.startTime + 's</span></div>' +
                            '<div class="overlay-row"><label>Hide</label><input type="range" min="1" max="120" step="1" value="' + c.cta.endTime + '" oninput="overlayConfig.cta.endTime=+this.value; this.nextSibling.textContent=this.value+\'s\'; drawOverlayCanvas();"><span>' + c.cta.endTime + 's</span></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            // Action buttons
            '<div style="display:flex; gap:8px; margin-top:14px;">' +
                '<button class="primary" onclick="saveAndRunOverlay()">Save & Run Overlay</button>' +
                '<button onclick="saveOverlayConfig()">Save Config</button>' +
            '</div>' +
        '</div>';

    initOverlayCanvas();
    // Populate the asset file browser dropdown if lower-third custom mode is active
    if (overlayConfig.lowerThird.mode === 'custom') {
        populateLTAssetPicker();
    }
}

function initOverlayCanvas() {
    const canvas = document.getElementById('overlay-canvas');
    if (!canvas) return;
    overlayCanvasCtx = canvas.getContext('2d');
    drawOverlayCanvas();

    canvas.addEventListener('mousedown', function(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;
        const elements = getOverlayElements();
        for (let i = elements.length - 1; i >= 0; i--) {
            const el = elements[i];
            if (mx >= el.x && mx <= el.x + el.w && my >= el.y && my <= el.y + el.h) {
                overlayDragging = { key: el.key, offsetX: mx - el.x, offsetY: my - el.y };
                break;
            }
        }
    });

    canvas.addEventListener('mousemove', function(e) {
        if (!overlayDragging) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;
        const nx = mx - overlayDragging.offsetX;
        const ny = my - overlayDragging.offsetY;
        const pctX = Math.max(0, Math.min(95, (nx / canvas.width) * 100));
        const pctY = Math.max(0, Math.min(95, (ny / canvas.height) * 100));
        if (overlayConfig[overlayDragging.key]) {
            overlayConfig[overlayDragging.key].x = pctX;
            overlayConfig[overlayDragging.key].y = pctY;
        }
        drawOverlayCanvas();
    });

    canvas.addEventListener('mouseup', function() { overlayDragging = null; });
    canvas.addEventListener('mouseleave', function() { overlayDragging = null; });
}

// Image cache for overlay asset previews
var overlayImageCache = {};

function loadOverlayImage(name) {
    if (overlayImageCache[name]) return overlayImageCache[name];
    var img = new Image();
    img._failed = false;
    img.onload = function() { drawOverlayCanvas(); };
    img.onerror = function() { img._failed = true; };
    img.src = '/api/assets/file/' + encodeURIComponent(name);
    overlayImageCache[name] = img;
    return img;
}

// Try loading an overlay image from multiple possible filenames
function loadOverlayImageMulti(baseName, extensions) {
    for (var i = 0; i < extensions.length; i++) {
        var name = baseName + extensions[i];
        var img = loadOverlayImage(name);
        if (img.naturalWidth && !img._failed) return img;
    }
    // Return whichever hasn't failed yet (may still be loading)
    for (var i = 0; i < extensions.length; i++) {
        var name = baseName + extensions[i];
        var img = overlayImageCache[name];
        if (img && !img._failed) return img;
    }
    return loadOverlayImage(baseName + extensions[0]); // fallback
}

// Reference video dimensions for each aspect ratio (what FFmpeg scale values map to)
function getRefVideoDims() {
    if (overlayCanvasRatio === '9:16') return { w: 1080, h: 1920 };
    if (overlayCanvasRatio === '1:1') return { w: 1080, h: 1080 };
    return { w: 1920, h: 1080 }; // 16:9
}

function getOverlayElements() {
    var c = overlayConfig;
    var canvas = document.getElementById('overlay-canvas');
    var W = canvas ? canvas.width : 640;
    var H = canvas ? canvas.height : 360;
    var ref = getRefVideoDims();
    // Scale factor: canvas pixels per video pixel
    var sx = W / ref.w;
    var sy = H / ref.h;
    var els = [];

    if (c.sponsor.enabled) {
        var scalePx = (c.sponsor.scale || 180);
        var img = loadOverlayImage('sponsor.mov');
        var aspect = (img.naturalWidth && img.naturalHeight) ? img.naturalHeight / img.naturalWidth : 0.6;
        var w = scalePx * sx;
        var h = w * aspect;
        var x = (c.sponsor.x / 100) * W;
        var y = (c.sponsor.y / 100) * H;
        els.push({ key: 'sponsor', label: 'Sponsor', x: x, y: y, w: w, h: h, color: 'rgba(59,130,246,0.6)', img: img });
    }
    if (c.logo.enabled) {
        var scalePx = (c.logo.scale || 140);
        // Try loading actual logo file (could be .png, .jpg, .mov, .mp4)
        var logoImg = loadOverlayImageMulti('logo', ['.png', '.jpg', '.mov', '.mp4']);
        var aspect = (logoImg.naturalWidth && logoImg.naturalHeight) ? logoImg.naturalHeight / logoImg.naturalWidth : 1;
        var w = scalePx * sx;
        var h = w * aspect;
        var x = (c.logo.x / 100) * W;
        var y = (c.logo.y / 100) * H;
        // Clamp like overlay.js does: x = min(x, videoWidth - scale - 10)
        var margin = 10 * sx;
        x = Math.min(x, W - w - margin);
        els.push({ key: 'logo', label: 'Logo', x: x, y: y, w: w, h: h, color: 'rgba(168,85,247,0.6)', img: logoImg });
    }
    if (c.lowerThird.enabled) {
        if (c.lowerThird.mode === 'custom' && c.lowerThird.customFile) {
            // Custom file mode: uses config x/y/scale like overlay.js
            var ltScale = (c.lowerThird.scale || 300);
            var ltImg = loadOverlayImage(c.lowerThird.customFile);
            var aspect = (ltImg.naturalWidth && ltImg.naturalHeight) ? ltImg.naturalHeight / ltImg.naturalWidth : 0.35;
            var w = ltScale * sx;
            var h = w * aspect;
            var x = ((c.lowerThird.x || 5) / 100) * W;
            var y = ((c.lowerThird.y || 80) / 100) * H;
            els.push({ key: 'lowerThird', label: 'Lower Third', x: x, y: y, w: w, h: h, color: 'rgba(168,85,247,0.7)', img: ltImg });
        } else {
            // Auto mode: drawbox at videoHeight-200, 520x120 (matches buildLowerThirdFilter)
            var boxW = 520 * sx;
            var boxH = 120 * sy;
            var boxY = H - (200 * sy);
            els.push({ key: 'lowerThird', label: 'Lower Third', x: 0, y: boxY, w: boxW, h: boxH, color: 'rgba(168,85,247,0.7)', fixed: true });
        }
    }
    if (c.cta.enabled) {
        if (c.cta.mode === 'text') {
            var fontSize = c.cta.fontSize || 28;
            var text = c.cta.text || '';
            var w = Math.max(60 * sx, text.length * fontSize * 0.6 * sx + 20 * sx);
            var h = fontSize * 1.5 * sy;
            var x = (c.cta.x / 100) * W;
            var y = (c.cta.y / 100) * H;
            els.push({ key: 'cta', label: 'CTA', x: x, y: y, w: w, h: Math.max(25 * sy, h), color: 'rgba(34,197,94,0.6)' });
        } else {
            var scalePx = (c.cta.scale || 200);
            var ctaImg = loadOverlayImageMulti('cta', ['.png', '.mov', '.mp4', '.gif']);
            var aspect = (ctaImg.naturalWidth && ctaImg.naturalHeight) ? ctaImg.naturalHeight / ctaImg.naturalWidth : 0.5;
            var w = scalePx * sx;
            var h = w * aspect;
            var x = (c.cta.x / 100) * W;
            var y = (c.cta.y / 100) * H;
            els.push({ key: 'cta', label: 'CTA', x: x, y: y, w: w, h: h, color: 'rgba(34,197,94,0.6)', img: ctaImg });
        }
    }
    return els;
}

function drawOverlayCanvas() {
    var canvas = document.getElementById('overlay-canvas');
    if (!canvas) return;
    var ctx = overlayCanvasCtx;
    if (!ctx) return;
    var W = canvas.width, H = canvas.height;

    // Dark background with grid
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    for (var x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (var y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // Shadow overlay preview (if shadow-reels-light.png exists)
    var shadowImg = loadOverlayImage('shadow-reels-light.png');
    if (shadowImg.naturalWidth) {
        ctx.globalAlpha = 0.5;
        ctx.drawImage(shadowImg, 0, 0, W, H);
        ctx.globalAlpha = 1.0;
    }

    // Logo vignette (full-frame, drawn when logo is enabled — matches overlay.js)
    if (overlayConfig.logo && overlayConfig.logo.enabled) {
        var vigImg = loadOverlayImage('logo-vignette.png');
        if (vigImg.naturalWidth) {
            ctx.drawImage(vigImg, 0, 0, W, H);
        }
    }

    // Safe area guide
    ctx.strokeStyle = '#444';
    ctx.setLineDash([4, 4]);
    if (overlayCanvasRatio === '9:16') {
        ctx.strokeRect(W * 0.05, H * 0.15, W * 0.9, H * 0.6);
        ctx.fillStyle = '#333';
        ctx.font = '9px sans-serif';
        ctx.fillText('safe zone', W * 0.05 + 4, H * 0.15 + 12);
    } else {
        ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);
    }
    ctx.setLineDash([]);

    // Draw elements — actual images where available, fallback to colored rectangles
    var ref = getRefVideoDims();
    var sx = W / ref.w;
    var els = getOverlayElements();
    els.forEach(function(el) {
        var hasImage = el.img && el.img.naturalWidth && el.img.complete;
        if (hasImage) {
            ctx.drawImage(el.img, el.x, el.y, el.w, el.h);
        } else if (el.key === 'lowerThird' && el.fixed) {
            // Auto lower-third: draw purple box with guest name/role like buildLowerThirdFilter
            ctx.fillStyle = 'rgba(168,85,247,0.85)';
            ctx.fillRect(el.x, el.y, el.w, el.h);
            var ep = episodes.find(function(e) { return e.slug === currentSlug; });
            if (ep) {
                ctx.fillStyle = '#fff';
                ctx.shadowColor = 'rgba(0,0,0,0.6)';
                ctx.shadowBlur = 2;
                ctx.font = 'bold ' + Math.round(12 * sx * 2) + 'px sans-serif';
                ctx.fillText(ep.guest || 'Guest Name', el.x + 6 * sx, el.y + el.h * 0.45);
                ctx.font = Math.round(9 * sx * 2) + 'px sans-serif';
                ctx.fillStyle = '#ccc';
                ctx.fillText(ep.role || 'Role', el.x + 6 * sx, el.y + el.h * 0.78);
                ctx.shadowBlur = 0;
            }
        } else if (el.key === 'cta' && overlayConfig.cta.mode === 'text') {
            // CTA text mode: draw with actual text
            ctx.fillStyle = el.color;
            ctx.fillRect(el.x, el.y, el.w, el.h);
            ctx.fillStyle = overlayConfig.cta.fontColor || '#ffffff';
            ctx.font = Math.round((overlayConfig.cta.fontSize || 28) * sx) + 'px sans-serif';
            ctx.shadowColor = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur = 2;
            ctx.fillText(overlayConfig.cta.text || '', el.x + 4, el.y + el.h * 0.7);
            ctx.shadowBlur = 0;
        } else {
            ctx.fillStyle = el.color;
            ctx.fillRect(el.x, el.y, el.w, el.h);
        }
        // Border (highlight when dragging)
        ctx.strokeStyle = hasImage ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.6)';
        ctx.lineWidth = overlayDragging && overlayDragging.key === el.key ? 2 : 1;
        ctx.strokeRect(el.x, el.y, el.w, el.h);
        // Label (top-left corner, subtle)
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '9px sans-serif';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 3;
        ctx.fillText(el.label, el.x + 2, el.y - 2);
        ctx.shadowBlur = 0;
    });
}

// Populate the lower-third asset picker dropdown with files from assets/ and shared dir
async function populateLTAssetPicker() {
    var picker = document.getElementById('lt-asset-picker');
    if (!picker) return;
    try {
        var res = await fetch('/api/assets/browse?type=video');
        var data = await res.json();
        // Clear existing options (keep placeholder)
        picker.innerHTML = '<option value="">-- Select file --</option>';
        var currentFile = overlayConfig.lowerThird.customFile || '';
        (data.files || []).forEach(function(f) {
            var opt = document.createElement('option');
            opt.value = f.source === 'shared' ? ('shared:' + f.path) : f.name;
            var label = f.name + ' (' + f.sizeMb + ' MB' + (f.source === 'shared' ? ', shared' : '') + ')';
            opt.textContent = label;
            if (f.name === currentFile) opt.selected = true;
            picker.appendChild(opt);
        });
    } catch (e) {
        console.warn('Failed to load assets:', e);
    }
}

async function selectLowerThirdAsset(value) {
    if (!value) return;
    if (value.startsWith('shared:')) {
        // Link shared file into local assets via symlink
        var sourcePath = value.substring(7);
        var fileName = sourcePath.split('/').pop();
        // Name it as lower-third.{ext} for overlay.js to find
        var ext = fileName.substring(fileName.lastIndexOf('.'));
        var assetName = 'lower-third' + ext;
        try {
            var res = await fetch('/api/link-asset', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ sourcePath: sourcePath, assetName: assetName })
            });
            var data = await res.json();
            if (data.success) {
                overlayConfig.lowerThird.customFile = data.file;
                renderOverlayConfig();
            } else {
                showToast(data.error || 'Link failed', 'error');
            }
        } catch (e) {
            showToast('Link failed: ' + e.message, 'error');
        }
    } else {
        // Local file — just set the filename
        overlayConfig.lowerThird.customFile = value;
        renderOverlayConfig();
    }
}

async function uploadLowerThirdAsset(file) {
    if (!file) return;
    var fd = new FormData();
    fd.append('type', 'lower-third');
    fd.append('file', file);
    try {
        var res = await fetch('/api/upload-asset', { method: 'POST', body: fd });
        var data = await res.json();
        if (data.success) {
            overlayConfig.lowerThird.customFile = data.file;
            renderOverlayConfig();
        }
    } catch (e) {
        alert('Upload failed: ' + e.message);
    }
}

async function uploadCTAAsset(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append('type', 'cta');
    fd.append('file', file);
    try {
        const res = await fetch('/api/upload-asset', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.success) {
            overlayConfig.cta.imagePath = 'assets/' + data.file;
            drawOverlayCanvas();
        }
    } catch (e) {
        alert('Upload failed: ' + e.message);
    }
}

async function saveOverlayConfig() {
    if (!currentSlug || !overlayConfig) return;
    try {
        await fetch('/api/overlay-config/' + encodeURIComponent(currentSlug), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(overlayConfig)
        });
    } catch (e) {
        alert('Save failed: ' + e.message);
    }
}

async function saveAndRunOverlay() {
    await saveOverlayConfig();
    if (selectedReelId) {
        runReelStep(selectedReelId, 'overlay');
    } else {
        runStep('overlay');
    }
    // Collapse panel
    document.getElementById('overlay-config-section').style.display = 'none';
    document.getElementById('overlay-config-section').innerHTML = '';
}

// Actions
async function runStep(step) {
    if (!currentSlug) return;
    const ep = episodes.find(e => e.slug === currentSlug);

    if (step === 'generate' && (!ep.guest || !ep.role)) {
        pendingRun = step;
        document.getElementById('meta-guest').value = ep.guest || '';
        document.getElementById('meta-role').value = ep.role || '';
        document.getElementById('meta-modal').classList.add('open');
        return;
    }

    // Get selected model from sidebar
    let model = null;
    if (step === 'generate') {
        const sidebarModel = document.getElementById('sidebar-model-select');
        if (sidebarModel) {
            model = sidebarModel.value.trim() || null;
        }
    }

    // Auto-enable face tracking for crop step
    var body = {slug: currentSlug, step, force: true, model};
    if (step === 'crop') {
        body.faceTrack = true;
        body.ratio = '9:16';
    }

    try {
        const res = await fetch('/api/run-step', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.success) showToast(data.error, 'error');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── Publishing (Zapier or Buffer) ─────────────────────────────────────────
var publishMethod = localStorage.getItem('tajarib-publish-method') || 'zapier';
var bufferMode = localStorage.getItem('tajarib-buffer-mode') || 'addToQueue';

var bufferModeDescs = {
    addToQueue: "Posts added to Buffer's queue",
    shareNow: "Publishes immediately to all channels",
    customScheduled: "Schedule for a specific date/time"
};

function setBufferMode(mode) {
    bufferMode = mode;
    localStorage.setItem('tajarib-buffer-mode', mode);
    ['addToQueue', 'shareNow', 'customScheduled'].forEach(function(m) {
        document.getElementById('buf-mode-' + m).classList.toggle('active', m === mode);
    });
    document.getElementById('buf-mode-desc').textContent = bufferModeDescs[mode] || '';
}

function setPublishMethod(method) {
    publishMethod = method;
    localStorage.setItem('tajarib-publish-method', method);
    document.getElementById('pub-method-zapier').classList.toggle('active', method === 'zapier');
    document.getElementById('pub-method-buffer').classList.toggle('active', method === 'buffer');
    document.getElementById('buffer-config-panel').style.display = method === 'buffer' ? 'block' : 'none';
    document.getElementById('zapier-info-panel').style.display = method === 'zapier' ? 'block' : 'none';
}

async function publishNow() {
    if (!currentSlug) return;
    var service = publishMethod;
    try {
        var modeLabel = service === 'buffer' ? (bufferMode === 'shareNow' ? ' (now)' : bufferMode === 'customScheduled' ? ' (scheduled)' : ' (queue)') : '';
        showToast('Publishing via ' + (service === 'buffer' ? 'Buffer' + modeLabel : 'Zapier') + '...', 'success');
        const res = await fetch('/api/publish', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slug: currentSlug, service: service, bufferMode: bufferMode})
        });
        const data = await res.json();
        if (data.success) {
            if (service === 'buffer' && data.result && data.result.results) {
                var ok = data.result.results.filter(function(r) { return r.success; }).length;
                var fail = data.result.results.filter(function(r) { return !r.success; }).length;
                showToast('Buffer: ' + ok + ' posted' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'warning' : 'success');
            } else {
                showToast('Sent to ' + (service === 'buffer' ? 'Buffer' : 'Zapier') + '!', 'success');
            }
            refresh();
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast('Publish failed: ' + err.message, 'error');
    }
}

// Keep old name as alias for backwards compatibility in existing onclick handlers
var publishToZapier = publishNow;

async function saveBufferToken() {
    var token = document.getElementById('buffer-token-input').value.trim();
    if (!token) return;
    try {
        const res = await fetch('/api/buffer-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({accessToken: token})
        });
        const data = await res.json();
        if (data.success) {
            showToast('Buffer token saved', 'success');
            document.getElementById('buffer-token-input').value = '';
            loadBufferConfig();
            fetchBufferChannels();
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function fetchBufferChannels() {
    var listEl = document.getElementById('buffer-channels-list');
    listEl.innerHTML = '<div style="color:#666;">Loading channels...</div>';
    try {
        const res = await fetch('/api/buffer-channels', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: '{}'
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        renderBufferChannels(data.channels);
        document.getElementById('buffer-status-dot').style.background = 'var(--success)';
    } catch (err) {
        listEl.innerHTML = '<div style="color:#f66;">' + err.message + '</div>';
        document.getElementById('buffer-status-dot').style.background = '#c33';
    }
}

function renderBufferChannels(channels) {
    var listEl = document.getElementById('buffer-channels-list');
    if (!channels || Object.keys(channels).length === 0) {
        listEl.innerHTML = '<div style="color:#666;">No channels found. Connect channels in Buffer first.</div>';
        return;
    }
    var serviceIcons = {tiktok:'TikTok', instagram:'Instagram', facebook:'Facebook', youtube:'YouTube', linkedin:'LinkedIn'};
    var html = '';
    Object.values(channels).forEach(function(ch) {
        var label = (serviceIcons[ch.service] || ch.service) + ' - ' + ch.name;
        html += '<div class="buffer-ch-item">' +
            '<span style="color:#ccc;">' + label + '</span>' +
            '<button class="buffer-ch-toggle' + (ch.enabled ? ' on' : '') + '" onclick="toggleBufferChannel(\'' + ch.id + '\', this)"></button>' +
            '</div>';
    });
    listEl.innerHTML = html;
}

async function toggleBufferChannel(channelId, btn) {
    var isOn = btn.classList.contains('on');
    btn.classList.toggle('on');
    await fetch('/api/buffer-channel-toggle', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({channelId: channelId, enabled: !isOn})
    });
}

async function loadBufferConfig() {
    try {
        const res = await fetch('/api/buffer-config');
        const data = await res.json();
        var statusEl = document.getElementById('buffer-token-status');
        if (data.hasToken) {
            statusEl.innerHTML = 'Token: <span style="color:var(--success);">configured</span> (' + data.tokenPreview + ')';
            document.getElementById('buffer-status-dot').style.background = 'var(--success)';
            if (data.channels && Object.keys(data.channels).length > 0) {
                renderBufferChannels(data.channels);
            }
        } else {
            statusEl.innerHTML = '<span style="color:#c33;">No token set</span>';
        }
    } catch (e) {}
}

// Init publish method UI
setPublishMethod(publishMethod);
setBufferMode(bufferMode);
loadBufferConfig();

document.getElementById('stop-btn').onclick = function() {
    if (currentSlug) socket.emit('stop-step', {slug: currentSlug});
};
var stopBtnRf = document.getElementById('stop-btn-rf');
if (stopBtnRf) stopBtnRf.onclick = function() {
    if (currentSlug) socket.emit('stop-step', {slug: currentSlug});
};

function editMeta() {
    if (!currentSlug) return;
    const ep = episodes.find(e => e.slug === currentSlug);
    pendingRun = null;
    document.getElementById('meta-guest').value = ep.guest || '';
    document.getElementById('meta-role').value = ep.role || '';
    document.getElementById('meta-modal').classList.add('open');
}

function closeMetaModal() { 
    document.getElementById('meta-modal').classList.remove('open'); 
    pendingRun = null; 
}

async function confirmMeta() {
    const guest = document.getElementById('meta-guest').value.trim();
    const role = document.getElementById('meta-role').value.trim();
    if (!guest || !role) return alert('Both fields required');
    
    socket.emit('update-meta', {slug: currentSlug, guest, role});
    closeMetaModal();
    
    if (pendingRun) {
        await runStep(pendingRun);
        pendingRun = null;
    }
}

// Switch Point Editor

async function openSwitchEditor() {
    if (!currentSlug) return;
    // Load existing switches
    try {
        const res = await fetch('/api/file?slug=' + currentSlug + '&file=switches.json');
        if (res.ok) {
            const data = await res.json();
            switchPointsData = data.switches || [];
        } else {
            switchPointsData = [{ time: 0, view: 'dual', reason: 'Opening' }];
        }
    } catch (e) {
        switchPointsData = [{ time: 0, view: 'dual', reason: 'Opening' }];
    }
    renderSwitchList();
    document.getElementById('switch-modal').classList.add('open');
}

function closeSwitchModal() {
    document.getElementById('switch-modal').classList.remove('open');
}

function renderSwitchList() {
    const list = document.getElementById('switch-list');
    list.innerHTML = switchPointsData.map((sw, i) => {
        const mins = Math.floor(sw.time / 60);
        const secs = Math.floor(sw.time % 60);
        return '<div style="display:flex; gap:6px; align-items:center; padding:6px 8px; background:#111; border-radius:4px;">' +
            '<input type="number" value="' + mins + '" min="0" style="width:45px; background:#0a0a0a; border:1px solid #333; color:#ddd; padding:4px; border-radius:3px; font-size:0.75rem;" onchange="updateSwitch(' + i + ',\'min\',this.value)" placeholder="min">' +
            '<span style="color:#555; font-size:0.7rem;">:</span>' +
            '<input type="number" value="' + secs + '" min="0" max="59" style="width:45px; background:#0a0a0a; border:1px solid #333; color:#ddd; padding:4px; border-radius:3px; font-size:0.75rem;" onchange="updateSwitch(' + i + ',\'sec\',this.value)" placeholder="sec">' +
            '<select onchange="updateSwitch(' + i + ',\'view\',this.value)" style="background:#0a0a0a; border:1px solid #333; color:#ddd; padding:4px; border-radius:3px; font-size:0.7rem; flex:1;">' +
                '<option value="dual" ' + (sw.view === 'dual' ? 'selected' : '') + '>Dual (50/50)</option>' +
                '<option value="speaker" ' + (sw.view === 'speaker' ? 'selected' : '') + '>Speaker Only</option>' +
                '<option value="guest" ' + (sw.view === 'guest' ? 'selected' : '') + '>Guest Only</option>' +
            '</select>' +
            '<button onclick="removeSwitch(' + i + ')" style="background:none; border:none; color:#666; cursor:pointer; font-size:0.8rem; padding:2px 6px;">&times;</button>' +
        '</div>';
    }).join('');
}

function addSwitchPoint() {
    const lastTime = switchPointsData.length > 0 ? switchPointsData[switchPointsData.length - 1].time + 30 : 0;
    switchPointsData.push({ time: lastTime, view: 'dual', reason: '' });
    renderSwitchList();
}

function removeSwitch(idx) {
    switchPointsData.splice(idx, 1);
    renderSwitchList();
}

function updateSwitch(idx, field, value) {
    if (field === 'min') {
        const secs = switchPointsData[idx].time % 60;
        switchPointsData[idx].time = parseInt(value) * 60 + secs;
    } else if (field === 'sec') {
        const mins = Math.floor(switchPointsData[idx].time / 60);
        switchPointsData[idx].time = mins * 60 + parseInt(value);
    } else if (field === 'view') {
        switchPointsData[idx].view = value;
    }
}

async function saveSwitchPoints() {
    if (!currentSlug) return;
    // Sort by time
    switchPointsData.sort((a, b) => a.time - b.time);
    try {
        await fetch('/api/file?slug=' + currentSlug + '&file=switches.json', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ generatedBy: 'manual', createdAt: new Date().toISOString(), switches: switchPointsData })
        });
        showToast('Switch points saved', 'success');
        closeSwitchModal();
    } catch (e) {
        showToast('Failed to save: ' + e.message, 'error');
    }
}

// ── Manual LLM Modal Functions ─────────────────────────────────────────────

function openLlmModal(data) {
    const stepNames = {
        analyze: 'Analyze',
        generate: 'Generate',
        compose: 'Camera Switching',
        'reel-01': 'Reel Caption',
        'reel-1': 'Reel Caption',
        youtube: 'YouTube Content',
        feedback: 'Revision',
        'generate-title': 'Title Generation',
        'topic-clip': 'Topic Clip',
        'analyze-more': 'More Reels',
        'analyze-clips': 'Reel Suggestions',
        dashboard: 'AI Request',
    };
    const stepName = stepNames[data.step] || data.step;
    document.getElementById('llm-modal-title').textContent = `📋 Manual LLM — ${stepName}`;
    document.getElementById('llm-system').textContent = data.system || '';
    document.getElementById('llm-user').textContent = data.user || '';
    document.getElementById('llm-response').value = '';
    document.getElementById('llm-format-hint').textContent =
        data.expectedFormat === 'json' ? '(expects JSON)' : '(expects plain text)';
    document.getElementById('llm-modal').classList.add('open');
}

function closeLlmModal() {
    document.getElementById('llm-modal').classList.remove('open');
    pendingLlmData = null;
}

function copyLlmPrompt() {
    const sys = document.getElementById('llm-system').textContent;
    const usr = document.getElementById('llm-user').textContent;
    const full = `System Prompt:\n${sys}\n\n---\n\nUser Message:\n${usr}`;
    navigator.clipboard.writeText(full).then(() => showToast('Full prompt copied!', 'success'));
}

function copyLlmSystem() {
    navigator.clipboard.writeText(document.getElementById('llm-system').textContent)
        .then(() => showToast('System prompt copied', 'success'));
}

function copyLlmUser() {
    navigator.clipboard.writeText(document.getElementById('llm-user').textContent)
        .then(() => showToast('User message copied', 'success'));
}

async function submitLlmResponse() {
    const response = document.getElementById('llm-response').value.trim();
    if (!response) {
        showToast('Please paste a response first', 'error');
        return;
    }
    if (!pendingLlmData) {
        showToast('No pending LLM request', 'error');
        return;
    }

    try {
        const res = await fetch('/api/llm-response', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                slug: pendingLlmData.slug,
                step: pendingLlmData.step,
                response: response,
                round: pendingLlmData.round || 0,
                requestId: pendingLlmData.requestId || null
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Response submitted — resuming pipeline', 'success');
            closeLlmModal();
        } else {
            showToast('Error: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Failed: ' + e.message, 'error');
    }
}

// ── Get More Reels ──────────────────────────────────────────────────────

async function getMoreReels() {
    if (!currentSlug) return;
    try {
        const res = await fetch('/api/run-step', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ slug: currentSlug, step: 'analyze', more: true })
        });
        const data = await res.json();
        if (!data.success) {
            showToast('Error: ' + data.error, 'error');
        }
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── Hide / Delete Reels ──────────────────────────────────────────────────

async function toggleHideReel(reelId) {
    if (!currentSlug) return;
    try {
        const res = await fetch('/api/hide-reel', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slug: currentSlug, reelId: reelId})
        });
        const data = await res.json();
        if (data.success) {
            showToast('Reel ' + reelId + (data.hidden ? ' hidden' : ' shown'), 'success');
            refresh();
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function deleteReel(reelId) {
    if (!confirm('Delete reel ' + reelId + '? This removes its video files.')) return;
    try {
        const res = await fetch('/api/delete-reel', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slug: currentSlug, reelId: reelId})
        });
        const data = await res.json();
        if (data.success) {
            showToast('Reel ' + reelId + ' deleted', 'success');
            selectedReelId = null;
            localStorage.removeItem('tajarib-selected-reel');
            refresh();
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── Crop Step ──────────────────────────────────────────────────────────────

// ── Cut Reels (legacy) ──────────────────────────────────────────────────────

async function showCutReels() {
    // Legacy function — now handled by the reel list
    if (selectedReelId) return;
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    if (ep && ep.reelStatuses && ep.reelStatuses.length > 0) {
        selectReel(ep.reelStatuses[0].id);
    }
}

// ── Media Type ─────────────────────────────────────────────────────────────

async function changeMediaType(slug, newType) {
    if (!slug || !newType) return;
    try {
        const res = await fetch('/api/set-meta', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slug, mediaType: newType})
        });
        const data = await res.json();
        if (data.success) {
            showToast('Type changed to ' + newType, 'success');
            refresh();
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast('Failed to change type: ' + err.message, 'error');
    }
}

// Editor Tabs
function switchTab(tab, skipPreviewLoad) {
    var ids = ['tab-text', 'tab-content', 'tab-preview', 'tab-json'];
    ids.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.classList.toggle('active', id === 'tab-' + tab);
    });
    var wraps = {text: 'text-editor-wrap', content: 'content-editor-wrap', preview: 'preview-editor-wrap', json: 'json-editor-wrap'};
    Object.keys(wraps).forEach(function(k) {
        var el = document.getElementById(wraps[k]);
        if (el) el.style.display = k === tab ? 'flex' : 'none';
    });

    if (tab === 'preview' && !skipPreviewLoad) {
        loadPreview();
    }
}

// Show preview tab
async function showPreviewTab() {
    var el = document.getElementById('tab-preview');
    if (el) el.style.display = '';
    switchTab('preview');
}

// Load Preview
async function loadPreview() {
    const previewDiv = document.getElementById('preview-content');
    if (!previewDiv) return;
    if (!currentSlug) {
        previewDiv.innerHTML = '<div style="color:#555; font-size:0.8rem; text-align:center; padding:40px;">No episode selected</div>';
        return;
    }
    
    const ep = episodes.find(e => e.slug === currentSlug);
    if (!ep || !ep.content || !ep.content.reels || ep.content.reels.length === 0) {
        previewDiv.innerHTML = '<div style="color:#555; font-size:0.8rem; text-align:center; padding:40px;">No reel content found</div>';
        return;
    }
    
    const reel = ep.content.reels[0];
    const caption = reel.caption || reel.hook || 'No caption';
    
    // Determine video source
    let videoSrc = '';
    if (ep.mediaType === 'reel_full') {
        // Use raw video for reel_full
        videoSrc = '/api/video?slug=' + currentSlug + '&type=raw';
    } else {
        // Use subtitled reel for reel_cut
        videoSrc = '/api/video?slug=' + currentSlug + '&type=subtitled';
    }
    
    previewDiv.innerHTML = 
        '<div style="display:flex; flex-direction:column; gap:16px; height:100%;">' +
            '<div style="flex:1; background:#000; border-radius:8px; overflow:hidden; display:flex; align-items:center; justify-content:center;">' +
                '<video controls style="max-width:100%; max-height:400px;" src="' + videoSrc + '"></video>' +
            '</div>' +
            '<div style="background:#161616; padding:16px; border-radius:8px; border:1px solid #2a2a2a;">' +
                '<div style="font-size:0.7rem; color:#666; margin-bottom:8px; text-transform:uppercase;">Caption</div>' +
                '<div style="font-size:0.9rem; color:#ddd; line-height:1.6; direction:rtl; text-align:right;">' + escHtml(caption) + '</div>' +
            '</div>' +
            '<div style="display:flex; gap:12px; justify-content:center; padding:10px;">' +
                '<button class="primary" style="padding:10px 24px; font-size:0.9rem;" onclick="publishNow()">📤 Publish Now</button>' +
                '<button onclick="switchTab(' + "'content'" + ')">✏️ Edit Caption</button>' +
            '</div>' +
        '</div>';
}

// Generate AI title from transcript
async function generateAiTitle() {
    if (!currentSlug) return;
    try {
        const res = await fetch('/api/generate-title', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slug: currentSlug})
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Renamed: ${data.newSlug}`, 'success');
        } else {
            showToast(data.error || 'Failed to generate title', 'error');
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// Generate clip from topic
async function generateTopicClip() {
    if (!currentSlug) return;
    
    const topicInput = document.getElementById('clip-topic-input');
    const topic = topicInput.value.trim();
    
    if (!topic) {
        showToast('Please enter a topic', 'error');
        return;
    }
    
    try {
        showToast('Generating clip for topic: ' + topic + '...', 'success');
        
        const res = await fetch('/api/generate-topic-clip', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                slug: currentSlug,
                topic: topic,
                guest: episodes.find(e => e.slug === currentSlug).guest,
                role: episodes.find(e => e.slug === currentSlug).role
            })
        });
        
        const data = await res.json();
        if (data.success) {
            showToast('Clip generated! Refreshing...', 'success');
            await refresh();
            // Show the preview
            document.getElementById('tab-preview').style.display = '';
            switchTab('preview');
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// Show reels in modal
async function showReels() {
    if (!currentSlug) return;
    const ep = episodes.find(e => e.slug === currentSlug);
    if (!ep || ep.counts.final === 0) {
        showToast('No subtitled reels yet. Run Subtitle step first.', 'error');
        return;
    }

    // In new layout, just select the first reel
    if (ep.reelStatuses && ep.reelStatuses.length > 0) {
        selectReel(ep.reelStatuses[0].id);
    }
}

// Model Management

// Known model aliases for validation
const KNOWN_MODEL_ALIASES = {
    // Auto
    'auto': 'Claude Sonnet 4.5 (default)',
    '': 'Claude Sonnet 4.5 (default)',
    // Claude models
    'claude': 'Claude (Latest)',
    'claude-sonnet-4-5-20241022': 'Claude Sonnet 4.5',
    'claude-sonnet': 'Claude Sonnet',
    'claude-opus': 'Claude Opus',
    'claude-haiku': 'Claude Haiku',
    'anthropic/claude-sonnet-4-20250514': 'Claude Sonnet 4 (2025-05)',
    // OpenAI models
    'openai': 'OpenAI (Latest)',
    'gpt-4': 'GPT-4',
    'gpt-4o': 'GPT-4o',
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4-turbo': 'GPT-4 Turbo',
    // Gemini models
    'gemini': 'Gemini (Latest)',
    'gemini-pro': 'Gemini Pro',
    'gemini-1.5-pro': 'Gemini 1.5 Pro',
    'gemini-1.5-flash': 'Gemini 1.5 Flash',
    // HAI Maker specific
    'haimaker/auto': 'HAI Maker Auto',
    'haimaker/claude-sonnet': 'HAI Maker Claude Sonnet',
    'haimaker/gpt-4o': 'HAI Maker GPT-4o',
    // OpenRouter models (common ones)
    'openrouter/auto': 'OpenRouter Auto',
    'openrouter/anthropic/claude-3.5-sonnet': 'OpenRouter Claude 3.5 Sonnet',
    'openrouter/openai/gpt-4o': 'OpenRouter GPT-4o',
};


function debouncedValidateSidebarModel(input) {
    const value = input.value.trim();
    const validationDiv = document.getElementById('sidebar-model-validation');
    if (!validationDiv) return;

    if (modelValidationTimer) clearTimeout(modelValidationTimer);

    if (!value) {
        validationDiv.textContent = 'Claude Sonnet 4.5 (default)';
        validationDiv.style.color = '#666';
        return;
    }

    validationDiv.textContent = 'Checking...';
    validationDiv.style.color = '#888';

    modelValidationTimer = setTimeout(() => {
        validateModelWithApi(value, validationDiv);
    }, 500);
}

async function validateModelWithApi(value, validationDiv) {
    const normalizedValue = value.toLowerCase();

    // Check known aliases first (instant)
    if (KNOWN_MODEL_ALIASES[normalizedValue]) {
        validationDiv.textContent = '✓ ' + KNOWN_MODEL_ALIASES[normalizedValue];
        validationDiv.style.color = '#4ade80';
        return;
    }

    // Try to validate against Haimaker API
    try {
        const res = await fetch('/api/validate-model?model=' + encodeURIComponent(value));
        const data = await res.json();

        if (data.valid) {
            validationDiv.textContent = '✓ ' + (data.displayName || value);
            validationDiv.style.color = '#4ade80';
            // Save valid custom models
            if (!KNOWN_MODEL_ALIASES[normalizedValue]) {
                saveCustomModel(value);
            }
        } else {
            validationDiv.textContent = '⚠ ' + (data.error || 'Unknown model - will try anyway');
            validationDiv.style.color = '#f59e0b';
        }
    } catch (e) {
        // Offline/fallback - accept anything that looks like a model identifier
        const validPattern = /^[a-z0-9]+([\/:._-][a-z0-9-]+)*$/i;
        if (validPattern.test(value)) {
            validationDiv.textContent = '✓ Custom: ' + value + ' (offline validation)';
            validationDiv.style.color = '#60a5fa';
        } else {
            validationDiv.textContent = '⚠ Invalid format';
            validationDiv.style.color = '#f87171';
        }
    }
}

function saveCustomModel(modelId) {
    const customModels = JSON.parse(localStorage.getItem('customModels') || '[]');
    if (!customModels.find(m => m.id === modelId)) {
        customModels.push({ id: modelId, name: modelId, added: new Date().toISOString() });
        localStorage.setItem('customModels', JSON.stringify(customModels));
        modelListLoaded = false; // Refresh list next time
    }
}

// Content Editor
async function loadContentEditor() {
    if (!currentSlug) return;
    const ep = episodes.find(e => e.slug === currentSlug);
    if (!ep || !ep.content) {
        var edBody = document.getElementById('content-editor-body');
        if (edBody) edBody.innerHTML = '<div style="color:#555; font-size:0.8rem; padding:20px; text-align:center;">No generated content yet. Run the Generate step first.</div>';
        return;
    }
    contentEditorData = ep.content;
    renderContentEditor();
}

function renderContentEditor() {
    if (!contentEditorData) return;
    const d = contentEditorData;
    const body = document.getElementById('content-editor-body');
    if (!body) return;
    const ep = episodes.find(e => e.slug === currentSlug);
    const isReel = ep && ep.mediaType !== 'episode';

    let html = '';

    // YouTube titles (only for episodes) - auto-set from opener text
    if (!isReel) {
        // Use opener as YouTube title if not set
        if (!d.youtube_titles || d.youtube_titles.length === 0) {
            if (d.opener) {
                d.youtube_titles = [d.opener];
            } else if (d.reels && d.reels[0] && d.reels[0].hook) {
                d.youtube_titles = [d.reels[0].hook];
            }
        }
        
        if (d.youtube_titles) {
            html += '<div class="content-field"><div class="content-label">YouTube Titles (auto from opener)</div><div class="content-titles-wrap">';
            d.youtube_titles.forEach((t, i) => {
                html += '<div class="content-title-row">' +
                    '<span class="content-title-num">' + (i + 1) + '.</span>' +
                    '<textarea class="content-textarea" id="yt-title-' + i + '" rows="2" oninput="autoResize(this)">' + escHtml(t) + '</textarea>' +
                '</div>' +
                feedbackRow('youtube_titles.' + i, 'yt-title-' + i);
            });
            html += '</div></div>';
        }
    }

    // YouTube description
    if (!isReel && d.youtube_description) {
        html += contentBlock('YouTube Description', 'youtube_description', d.youtube_description, 10);
    }

    // Announcement post
    if (!isReel && d.announcement_post) {
        html += contentBlock('Announcement Post', 'announcement_post', d.announcement_post, 6);
    }

    // Reel captions
    if (d.reels && d.reels.length > 0) {
        d.reels.forEach((r, i) => {
            const title = isReel ? 'Reel Caption' : 'Reel ' + r.id + ' — ' + (r.hook ? r.hook.slice(0, 50) : '') + (r.hook && r.hook.length > 50 ? '...' : '');
            html += contentBlock(title, 'reels.' + i + '.caption', r.caption, 8);
        });
    }

    // Opener (for reference)
    if (d.opener) {
        html += '<div class="content-field"><div class="content-label">Opener (used as YouTube title)</div>' +
            '<div style="background:#0d0d0d; padding:10px; border-radius:6px; color:#888; font-size:0.8rem; direction:rtl;">' + escHtml(d.opener) + '</div></div>';
    }

    // Save all button
    html += '<div style="display:flex; justify-content:flex-end; padding-top:10px; border-top:1px solid #2a2a2a;">' +
        '<button class="primary" onclick="saveAllContent()">Save All Changes</button>' +
    '</div>';

    body.innerHTML = html;
    body.querySelectorAll('.content-textarea').forEach(autoResize);
}

function contentBlock(label, fieldPath, value, rows) {
    const id = 'field-' + fieldPath.replace(/\\./g, '-');
    return '<div class="content-field" data-field="' + fieldPath + '">' +
        '<div class="content-block-header">' +
            '<div class="content-label">' + label + '</div>' +
            '<div class="content-block-actions">' +
                '<button class="text-btn" onclick="copyField(' + "'" + fieldPath + "'" + ')">Copy</button>' +
            '</div>' +
        '</div>' +
        '<textarea class="content-textarea" id="' + id + '" rows="' + rows + '" oninput="autoResize(this)">' + escHtml(value) + '</textarea>' +
        feedbackRow(fieldPath, id) +
        '<div class="content-hint" id="hint-' + id + '"></div>' +
    '</div>';
}

function feedbackRow(fieldPath, textareaId) {
    return '<div class="feedback-row">' +
        '<input class="feedback-input" id="fb-' + textareaId + '" placeholder="Feedback for AI revision, e.g. make it shorter, focus on finance...">' +
        '<button class="feedback-btn" onclick="submitFeedback(' + "'" + fieldPath + "','" + textareaId + "','" + textareaId + "'" + ')">↩ Revise</button>' +
    '</div>';
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function submitFeedback(fieldPath, textareaId, hintId) {
    const fbInput = document.getElementById('fb-' + hintId);
    const textarea = document.getElementById(textareaId);
    const hint = document.getElementById('hint-' + hintId);
    // Find the Revise button (sibling of input in feedback-row)
    const reviseBtn = fbInput ? fbInput.parentElement.querySelector('.feedback-btn') : null;

    const feedback = fbInput.value.trim();
    if (!feedback) return showToast('Enter feedback first', 'error');

    // Clear loading state
    fbInput.disabled = true;
    if (reviseBtn) { reviseBtn.disabled = true; reviseBtn.textContent = '⏳ Revising...'; }
    hint.textContent = '⏳ Sending feedback to AI — this may take a moment...';
    hint.style.color = '#60a5fa';
    hint.style.fontSize = '0.8rem';
    showToast('Sending to AI...', 'success');

    try {
        console.log('[feedback] Sending revision request:', { slug: currentSlug, field: fieldPath, feedbackLen: feedback.length });
        const res = await fetch('/api/feedback', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                slug: currentSlug,
                field: fieldPath,
                currentContent: textarea.value,
                feedback
            })
        });
        console.log('[feedback] Response status:', res.status);
        const data = await res.json();
        console.log('[feedback] Response data:', { success: data.success, revisedLen: data.revised ? data.revised.length : 0, error: data.error });

        if (data.success) {
            textarea.value = data.revised;
            autoResize(textarea);
            fbInput.value = '';
            hint.textContent = '✓ Revised by AI';
            hint.style.color = '';
            hint.style.fontSize = '';
            hint.className = 'content-hint ok';
            showToast('Content revised!', 'success');
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        console.error('[feedback] Revision error:', err);
        hint.textContent = '✗ ' + err.message;
        hint.style.color = '';
        hint.style.fontSize = '';
        hint.className = 'content-hint err';
        showToast('Revision failed: ' + err.message, 'error');
    }

    fbInput.disabled = false;
    if (reviseBtn) { reviseBtn.disabled = false; reviseBtn.textContent = '↩ Revise'; }
    setTimeout(() => { hint.textContent = ''; hint.style.color = ''; hint.style.fontSize = ''; }, 6000);
}

async function saveAllContent() {
    if (!currentSlug || !contentEditorData) return;

    const body = document.getElementById('content-editor-body');
    if (!body) return;
    const fields = body.querySelectorAll('.content-field[data-field]');
    let savedCount = 0;

    for (const fieldEl of fields) {
        const fieldPath = fieldEl.dataset.field;
        const textarea = fieldEl.querySelector('.content-textarea');
        if (!textarea) continue;

        try {
            await fetch('/api/save-content', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    slug: currentSlug,
                    field: fieldPath,
                    value: textarea.value
                })
            });
            savedCount++;
        } catch (e) {}
    }

    showToast('Saved ' + savedCount + ' fields', 'success');
    await refresh();
}

function copyField(fieldPath) {
    const textarea = document.getElementById('field-' + fieldPath.replace(/\\./g, '-'));
    if (textarea) {
        navigator.clipboard.writeText(textarea.value);
        showToast('Copied!', 'success');
    }
}

// Text Editor
async function loadTextEditor() {
    if (!currentSlug) return;
    switchTab('text');
    var edFile = document.getElementById('editor-file');
    if (edFile) edFile.textContent = 'transcript.json — Word Editor';
    var saveBtn = document.getElementById('save-text-btn');
    if (saveBtn) saveBtn.disabled = false;

    try {
        const res = await fetch('/api/file?slug=' + currentSlug + '&file=transcript.json');
        if (!res.ok) throw new Error('Failed to load');
        textEditorData = JSON.parse(await res.text());
    } catch(e) {
        showToast('Failed to load transcript', 'error');
        return;
    }

    const list = document.getElementById('seg-list');
    if (!list) return;
    list.innerHTML = textEditorData.segments.map((seg, i) => {
        const mins = String(Math.floor(seg.start / 60)).padStart(2, '0');
        const secs = String(Math.floor(seg.start % 60)).padStart(2, '0');

        // Synthesize word-level data from segment text if missing
        if ((!seg.words || seg.words.length === 0) && seg.text && seg.text.trim()) {
            var tokens = seg.text.trim().split(/\s+/);
            var segDur = (seg.end || seg.start || 0) - (seg.start || 0);
            var wordDur = tokens.length > 0 ? segDur / tokens.length : segDur;
            seg.words = tokens.map(function(tok, ti) {
                return { word: tok, start: seg.start + ti * wordDur, end: seg.start + (ti + 1) * wordDur, probability: 0.5 };
            });
        }

        // Word-level editing
        if (seg.words && seg.words.length > 0) {
            const wordSpans = seg.words.map((w, wi) => {
                const txt = (w.word || '').trim();
                return '<span class="seg-word" contenteditable="true" data-seg="' + i + '" data-word="' + wi + '" ' +
                    'data-original="' + escHtml(txt) + '" spellcheck="false">' + escHtml(txt) + '</span>';
            }).join('');
            return '<div class="seg-row">' +
                '<span class="seg-ts">' + mins + ':' + secs + '</span>' +
                '<div class="seg-words" data-seg="' + i + '">' + wordSpans + '</div>' +
            '</div>';
        }

        // Fallback: empty segment
        return '<div class="seg-row">' +
            '<span class="seg-ts">' + mins + ':' + secs + '</span>' +
            '<div class="seg-words" data-seg="' + i + '"></div>' +
        '</div>';
    }).join('');

    // Word editing: mark edited, Enter to confirm
    list.querySelectorAll('.seg-word').forEach(function(el) {
        el.addEventListener('input', function() {
            this.classList.toggle('edited', this.textContent.trim() !== this.dataset.original);
        });
        el.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
        });
    });

    list.querySelectorAll('.seg-input').forEach(autoResize);
}

async function saveTextEditor() {
    if (!currentSlug || !textEditorData) return;

    const segListEl = document.getElementById('seg-list');
    if (!segListEl) return;

    // Collect word-level edits from contenteditable spans
    segListEl.querySelectorAll('.seg-words').forEach(function(container) {
        const segIdx = parseInt(container.dataset.seg);
        const seg = textEditorData.segments[segIdx];
        if (!seg || !seg.words) return;
        container.querySelectorAll('.seg-word').forEach(function(el) {
            const wordIdx = parseInt(el.dataset.word);
            const newText = el.textContent.trim();
            if (seg.words[wordIdx]) {
                seg.words[wordIdx].word = newText;
            }
        });
        // Remove empty words and rebuild segment text
        seg.words = seg.words.filter(function(w) { return w.word.trim().length > 0; });
        seg.text = seg.words.map(function(w) { return w.word; }).join(' ');
    });

    // Collect textarea edits (fallback segments without word data)
    segListEl.querySelectorAll('.seg-input').forEach(function(input) {
        const i = parseInt(input.dataset.idx);
        textEditorData.segments[i].text = input.value.trim();
    });

    // Rebuild flattened words array from all segments
    textEditorData.words = [];
    textEditorData.segments.forEach(function(seg) {
        if (seg.words) {
            seg.words.forEach(function(w) { textEditorData.words.push(w); });
        }
    });

    textEditorData.full_text = textEditorData.segments.map(function(s) { return s.text; }).join(' ');

    try {
        await fetch('/api/file', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                slug: currentSlug,
                file: 'transcript.json',
                content: JSON.stringify(textEditorData, null, 2)
            })
        });
        showToast('Transcript saved!', 'success');
        // Reset edited markers
        segListEl.querySelectorAll('.seg-word.edited').forEach(function(el) {
            el.dataset.original = el.textContent.trim();
            el.classList.remove('edited');
        });
    } catch(e) {
        showToast('Save failed', 'error');
    }
}

// JSON Editor
async function loadJsonFile(filename) {
    if (!currentSlug) return;
    currentFile = filename;
    switchTab('json');
    var edFile = document.getElementById('editor-file');
    if (edFile) edFile.textContent = filename;
    
    try {
        const res = await fetch('/api/file?slug=' + currentSlug + '&file=' + filename);
        if (res.ok) {
            const text = await res.text();
            var fileEditorEl = document.getElementById('file-editor');
            if (fileEditorEl) {
                try {
                    fileEditorEl.value = JSON.stringify(JSON.parse(text), null, 2);
                } catch(_) {
                    fileEditorEl.value = text;
                }
                fileEditorEl.disabled = false;
            }
            var saveJsonBtn = document.getElementById('save-json-btn');
            if (saveJsonBtn) saveJsonBtn.disabled = false;
        }
    } catch(e) {}
}

async function saveJsonEditor() {
    if (!currentSlug || !currentFile) return;
    var fileEditorEl = document.getElementById('file-editor');
    if (!fileEditorEl) return;
    try {
        const content = fileEditorEl.value;
        if (currentFile.endsWith('.json')) JSON.parse(content);
        await fetch('/api/file', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slug: currentSlug, file: currentFile, content})
        });
        showToast('Saved ' + currentFile, 'success');
    } catch(e) {
        alert('Invalid JSON: ' + e.message);
    }
}

// Toast
function showToast(msg, type) {
    var container = document.getElementById('toast-container');
    var el = document.createElement('div');
    var cls = type === 'error' ? 'toast-error' : type === 'warning' ? 'toast-warning' : 'toast-success';
    el.className = 'toast ' + cls;
    el.innerHTML = '<span style="flex:1;">' + msg + '</span><button class="toast-close" onclick="dismissToast(this.parentNode)">&times;</button>';
    container.appendChild(el);
    var duration = type === 'error' ? 6000 : 4000;
    el._timeout = setTimeout(function() { dismissToast(el); }, duration);
    while (container.children.length > 5) container.removeChild(container.firstChild);
}
function dismissToast(el) {
    if (el._dismissed) return;
    el._dismissed = true;
    clearTimeout(el._timeout);
    el.classList.add('removing');
    el.addEventListener('animationend', function() { el.remove(); });
}
