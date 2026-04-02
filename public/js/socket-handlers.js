// ── Socket Event Handlers & Step Queue ───────────────────────────────────────

// Step queue: chain steps sequentially per slug
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

// Manual LLM mode
let pendingLlmData = null;

function setupSocketHandlers() {
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
        if (currentSlug && isSlugRunning(currentSlug)) {
            var stopBtn = document.getElementById('pipeline-stop-btn');
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
        if (pendingResumeData && data.slug === pendingResumeData.slug) appendProgressLog(data.text);
    });
    socket.on('process-start', function(data) {
        var procKey = data.reelId ? data.slug + ':' + data.reelId : data.slug;
        runningStep[procKey] = data.step;
        if (currentSlug === data.slug) renderMain(currentSlug);
    });
    socket.on('process-end', function(data) {
        if (pendingResumeData && data.slug === pendingResumeData.slug &&
            String(data.reelId || '') === String(pendingResumeData.reelId || '')) {
            finishLlmProgress(data.code);
        }
        if (data.step === 'trim' && data.code === 0 && data.reelId) {
            fetch('/api/run-step', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ slug: data.slug, step: 'cut', reelId: data.reelId, force: true })
            });
        }
        if (data.step === 'stopped') {
            // Stop kills all processes for this slug — clear all matching keys
            for (var k in runningStep) { if (k === data.slug || k.startsWith(data.slug + ':')) delete runningStep[k]; }
        } else {
            var procKey = data.reelId ? data.slug + ':' + data.reelId : data.slug;
            delete runningStep[procKey];
        }
        refresh();
        if (data.step === 'cut' && data.code === 0 && currentSlug === data.slug) {
            setTimeout(function() { renderMain(currentSlug); }, 500);
        }
        // Auto-refresh video preview when a reel processing step completes
        if (data.code === 0 && currentSlug === data.slug && selectedReelId) {
            // Refresh if this specific reel was processed, OR if a bulk step (no reelId) completed
            if (data.reelId === selectedReelId || (!data.reelId && ['subtitle', 'crop', 'overlay', 'process-reels'].includes(data.step))) {
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
        // Refresh standalone reel caption when generate completes
        if (data.step === 'generate' && data.code === 0 && currentSlug === data.slug) {
            var epCheck = episodes.find(function(e) { return e.slug === data.slug; });
            if (epCheck && (epCheck.mediaType === 'reel_full' || epCheck.mediaType === 'reel_cut')) {
                setTimeout(function() { if (currentSlug) renderMain(currentSlug); }, 700);
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
}
