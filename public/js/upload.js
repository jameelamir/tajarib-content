// ── Upload: Guest History, Media Type, Upload Flow ──────────────────────────

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
    // Only show guests that have actually been used (exclude prospect-only entries)
    guestHistory.filter(g => g.used > 0 || g.lastUsed).sort((a, b) => b.used - a.used).forEach(g => {
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

// Upload Flow
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
    document.querySelectorAll('input[name="transcribe-method"]').forEach(r => r.checked = r.value === defaultMethod);

    // Show warning if API selected but no key
    const apiWarning = document.getElementById('api-key-warning');
    const needsWarning = (m) => (m === 'api' && !transcriptionConfig.hasApiKey) || (m === 'groq' && !transcriptionConfig.hasGroqKey);
    apiWarning.style.display = needsWarning(defaultMethod) ? 'block' : 'none';

    // Update warning when selection changes
    document.querySelectorAll('input[name="transcribe-method"]').forEach(radio => {
        radio.onchange = () => {
            apiWarning.style.display = needsWarning(radio.value) ? 'block' : 'none';
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
    document.querySelectorAll('input[name="transcribe-method"]').forEach(r => r.checked = r.value === defaultMethod);

    const apiWarning = document.getElementById('api-key-warning');
    const needsWarning = (m) => (m === 'api' && !transcriptionConfig.hasApiKey) || (m === 'groq' && !transcriptionConfig.hasGroqKey);
    apiWarning.style.display = needsWarning(defaultMethod) ? 'block' : 'none';
    document.querySelectorAll('input[name="transcribe-method"]').forEach(radio => {
        radio.onchange = () => {
            apiWarning.style.display = needsWarning(radio.value) ? 'block' : 'none';
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
        document.getElementById('upload-zone').style.display = 'none';
        fillEl.style.width = '0%';
        textEl.textContent = 'Starting download...';

        fetch('/api/download-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: pendingUrl, slug, guest, role, mediaType: uploadMediaType, transcribeMethod })
        }).then(r => r.json()).then(data => {
            if (!data.success) {
                progressEl.classList.remove('active');
                document.getElementById('upload-zone').style.display = '';
                showToast('Download failed: ' + (data.error || 'Unknown error'), 'error');
            }
            // Progress updates come via socket events — slug is in data.slug
        }).catch(err => {
            progressEl.classList.remove('active');
            document.getElementById('upload-zone').style.display = '';
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
    document.getElementById('upload-zone').style.display = 'none';

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
        document.getElementById('upload-zone').style.display = '';
        if (xhr.status === 200) {
            let serverSlug = null;
            try { serverSlug = JSON.parse(xhr.responseText).slug || null; } catch (e) {}
            if (serverSlug) claimPromptSlug(serverSlug);
            showToast('Upload complete!', 'success');
            const finalSlug = serverSlug || slug.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
            refresh().then(() => selectEp(finalSlug));
        } else {
            showToast('Upload failed: ' + xhr.responseText, 'error');
        }
        pendingFile = null;
        pendingSrtFile = null;
    };

    xhr.onerror = function() {
        progressEl.classList.remove('active');
        document.getElementById('upload-zone').style.display = '';
        showToast('Upload failed', 'error');
        pendingFile = null;
        pendingSrtFile = null;
    };

    xhr.open('POST', '/api/upload');
    xhr.send(formData);
}
