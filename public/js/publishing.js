// ── Publishing, LLM Modal, Switch Editor ─────────────────────────────────────

// Publishing (Zapier or Buffer)
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
        var btn = document.getElementById('buf-mode-' + m);
        if (btn) btn.classList.toggle('active', m === mode);
    });
    var desc = document.getElementById('buf-mode-desc');
    if (desc) desc.textContent = bufferModeDescs[mode] || '';
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
            body: JSON.stringify({slug: currentSlug, service: service, bufferMode: bufferMode, reelId: selectedReelId || undefined})
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

// ── Manual LLM Modal Functions ─────────────────────────────────────────────

function openLlmModal(data) {
    const stepNames = {
        analyze: 'Analyze',
        generate: 'Generate',
        compose: 'Camera Switching',
        youtube: 'YouTube Content',
        feedback: 'Revision',
        'generate-title': 'Title Generation',
        'topic-clip': 'Topic Clip',
        'analyze-more': 'More Reels',
        'analyze-clips': 'Reel Suggestions',
        trim: 'Smart Trim',
        dashboard: 'AI Request',
    };
    // Map reel-N / reel-0N steps to "Reel N Caption"
    let stepName = stepNames[data.step] || data.step;
    const reelMatch = data.step && data.step.match(/^reel-0*(\d+)$/);
    if (reelMatch) stepName = 'Reel ' + reelMatch[1] + ' Caption';
    document.getElementById('llm-modal-title').textContent = `📋 Manual LLM — ${stepName}`;
    document.getElementById('llm-system').textContent = data.system || '';
    document.getElementById('llm-user').textContent = data.user || '';
    document.getElementById('llm-response').value = '';
    document.getElementById('llm-format-hint').textContent =
        data.expectedFormat === 'json' ? '(expects JSON)' : '(expects plain text)';
    document.getElementById('llm-modal').classList.add('open');
}

var pendingResumeData = null;

function closeLlmModal() {
    document.getElementById('llm-modal').classList.remove('open');
    var promptArea = document.getElementById('llm-prompt-area');
    var progressArea = document.getElementById('llm-progress-area');
    if (promptArea) promptArea.style.display = '';
    if (progressArea) progressArea.style.display = 'none';
    pendingResumeData = null;
    pendingLlmData = null;
}

function showLlmProgressView(title) {
    document.getElementById('llm-modal-title').textContent = title || '⚙️ Processing...';
    document.getElementById('llm-prompt-area').style.display = 'none';
    var progressArea = document.getElementById('llm-progress-area');
    progressArea.style.display = 'block';
    document.getElementById('llm-progress-log').textContent = '';
}

function appendProgressLog(text) {
    var el = document.getElementById('llm-progress-log');
    if (!el) return;
    el.textContent += text;
    el.scrollTop = el.scrollHeight;
}

function finishLlmProgress(code) {
    pendingResumeData = null;
    document.getElementById('llm-modal-title').textContent = code === 0 ? '✅ Done' : '❌ Failed';
    setTimeout(closeLlmModal, 1800);
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
            pendingResumeData = { slug: pendingLlmData.slug, reelId: pendingLlmData.reelId != null ? pendingLlmData.reelId : null };
            showLlmProgressView('⚙️ ' + (pendingLlmData.step || 'Processing') + '...');
        } else {
            showToast('Error: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Failed: ' + e.message, 'error');
    }
}

// ── Switch Point Editor ─────────────────────────────────────────────────────

async function openSwitchEditor() {
    if (!currentSlug) return;
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
