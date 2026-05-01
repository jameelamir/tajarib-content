// ── Upload: Guest History, Media Type, Upload Flow ──────────────────────────

// Mirror of server/helpers.js#slugify — preserve Unicode letters/digits so
// Arabic titles survive instead of getting stripped to all-dashes.
function slugify(input) {
    if (input == null) return '';
    return String(input)
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}_-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

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
async function startUploadFlow(file) {
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

    // If this file matches an in-progress chunked upload, pre-fill the metadata
    // so the user doesn't have to re-enter slug / guest / role / etc.
    try {
        const existing = await findExistingUpload(file);
        if (!existing || pendingFile !== file) return;

        const pct = Math.round((existing.receivedIndexes.length / Math.max(existing.totalChunks, 1)) * 100);
        document.getElementById('upload-modal-title').textContent = `🔄 Resume Upload (${pct}% done)`;
        document.getElementById('upload-confirm-btn').textContent = 'Resume Upload';

        if (existing.slug && !existing.pendingAiTitle) {
            document.getElementById('upload-slug').value = existing.slug;
        }
        if (existing.guest) {
            const select = document.getElementById('upload-guest-select');
            const input = document.getElementById('upload-guest-input');
            const inDropdown = Array.from(select.options).some(o => o.value === existing.guest);
            if (inDropdown) {
                select.value = existing.guest;
            } else {
                input.value = existing.guest;
                input.style.display = 'block';
                select.style.display = 'none';
            }
        }
        if (existing.role) document.getElementById('upload-role').value = existing.role;
        if (existing.mediaType) {
            const idSuffix = existing.mediaType === 'reel_cut' ? 'reel-cut' : existing.mediaType === 'reel_full' ? 'reel-full' : 'episode';
            const typeRadio = document.getElementById('upload-type-' + idSuffix);
            if (typeRadio) typeRadio.checked = true;
            updateMultiTrackVisibility();
        }
        if (existing.transcribeMethod) {
            document.querySelectorAll('input[name="transcribe-method"]').forEach(r => r.checked = r.value === existing.transcribeMethod);
            const apiWarning = document.getElementById('api-key-warning');
            const needsWarning = (m) => (m === 'api' && !transcriptionConfig.hasApiKey) || (m === 'groq' && !transcriptionConfig.hasGroqKey);
            apiWarning.style.display = needsWarning(existing.transcribeMethod) ? 'block' : 'none';
        }
    } catch {}
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

// ── Resumable chunked upload (plain video only) ────────────────────────────
const RESUMABLE_UPLOADS_KEY = 'tajarib-resumable-uploads';

function getFileFingerprint(file) {
    return `${file.name}|${file.size}|${file.lastModified}`;
}

function loadUploadRegistry() {
    try { return JSON.parse(localStorage.getItem(RESUMABLE_UPLOADS_KEY) || '{}'); }
    catch { return {}; }
}

function saveUploadRegistry(reg) {
    try { localStorage.setItem(RESUMABLE_UPLOADS_KEY, JSON.stringify(reg)); } catch {}
}

function rememberUpload(fingerprint, uploadId, totalChunks, chunkSize) {
    const reg = loadUploadRegistry();
    reg[fingerprint] = { uploadId, totalChunks, chunkSize, ts: Date.now() };
    saveUploadRegistry(reg);
}

function forgetUpload(fingerprint) {
    const reg = loadUploadRegistry();
    delete reg[fingerprint];
    saveUploadRegistry(reg);
}

async function findExistingUpload(file) {
    const fingerprint = getFileFingerprint(file);
    const reg = loadUploadRegistry();
    const entry = reg[fingerprint];
    if (!entry) return null;
    try {
        const res = await fetch('/api/upload-status?uploadId=' + encodeURIComponent(entry.uploadId));
        if (!res.ok) { forgetUpload(fingerprint); return null; }
        const data = await res.json();
        if (!data.success) { forgetUpload(fingerprint); return null; }
        if (data.fileSize !== file.size) { forgetUpload(fingerprint); return null; }
        return {
            fingerprint,
            uploadId: entry.uploadId,
            totalChunks: data.totalChunks,
            chunkSize: data.chunkSize || entry.chunkSize,
            receivedIndexes: data.receivedIndexes || [],
            slug: data.slug,
            guest: data.guest,
            role: data.role,
            mediaType: data.mediaType,
            transcribeMethod: data.transcribeMethod,
            pendingAiTitle: data.pendingAiTitle
        };
    } catch { return null; }
}

function postChunkXhr(uploadId, chunkIndex, blob, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
        xhr.onload = () => {
            if (xhr.status === 200) resolve();
            else reject(new Error(`Chunk ${chunkIndex} failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error(`Chunk ${chunkIndex} network error`));
        xhr.open('POST', `/api/upload-chunk?uploadId=${encodeURIComponent(uploadId)}&chunkIndex=${chunkIndex}`);
        xhr.send(blob);
    });
}

async function uploadFileChunked(file, options, onProgress) {
    const fingerprint = getFileFingerprint(file);
    let uploadId, chunkSize, totalChunks, receivedIndexes;

    const existing = await findExistingUpload(file);
    if (existing) {
        uploadId = existing.uploadId;
        chunkSize = existing.chunkSize;
        totalChunks = existing.totalChunks;
        receivedIndexes = new Set(existing.receivedIndexes);
    } else {
        const initRes = await fetch('/api/upload-init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: file.name,
                fileSize: file.size,
                slug: options.slug,
                guest: options.guest,
                role: options.role,
                mediaType: options.mediaType,
                transcribeMethod: options.transcribeMethod
            })
        });
        const initData = await initRes.json();
        if (!initData.success) throw new Error(initData.error || 'Upload init failed');
        uploadId = initData.uploadId;
        chunkSize = initData.chunkSize;
        totalChunks = initData.totalChunks;
        receivedIndexes = new Set();
        rememberUpload(fingerprint, uploadId, totalChunks, chunkSize);
    }

    _activeChunkedUploadIds.add(uploadId);
    loadPendingUploads();

    try {
        const isResume = receivedIndexes.size > 0;
        let bytesDone = 0;
        for (const idx of receivedIndexes) {
            const start = idx * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            bytesDone += (end - start);
        }
        onProgress(bytesDone, file.size, isResume);

        for (let i = 0; i < totalChunks; i++) {
            if (receivedIndexes.has(i)) continue;
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const blob = file.slice(start, end);
            await postChunkXhr(uploadId, i, blob, (chunkBytes) => {
                onProgress(bytesDone + chunkBytes, file.size, isResume);
            });
            bytesDone += (end - start);
            onProgress(bytesDone, file.size, isResume);
        }

        const completeRes = await fetch('/api/upload-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uploadId,
                slug: options.slug,
                guest: options.guest,
                role: options.role,
                mediaType: options.mediaType,
                transcribeMethod: options.transcribeMethod
            })
        });
        const completeData = await completeRes.json();
        if (!completeData.success) throw new Error(completeData.error || 'Upload assembly failed');
        forgetUpload(fingerprint);
        return completeData.slug;
    } finally {
        _activeChunkedUploadIds.delete(uploadId);
        loadPendingUploads();
    }
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

    // ── Chunked + resumable path: plain video only (no SRT, no multi-track) ──
    if (!isMultiTrack && !pendingSrtFile) {
        const file = pendingFile;
        const progressEl = document.getElementById('upload-progress');
        const fillEl = document.getElementById('progress-fill');
        const textEl = document.getElementById('progress-text');
        progressEl.classList.add('active');
        document.getElementById('upload-zone').style.display = 'none';
        fillEl.style.width = '0%';
        textEl.textContent = 'Preparing upload...';

        uploadFileChunked(file, { slug, guest, role, mediaType: uploadMediaType, transcribeMethod }, (loaded, total, isResume) => {
            const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
            fillEl.style.width = pct + '%';
            const mb = (loaded / 1024 / 1024).toFixed(0);
            const totalMb = (total / 1024 / 1024).toFixed(0);
            const prefix = isResume ? '↻ Resuming: ' : 'Uploading: ';
            textEl.textContent = prefix + mb + ' / ' + totalMb + ' MB (' + pct + '%)';
        }).then((serverSlug) => {
            progressEl.classList.remove('active');
            document.getElementById('upload-zone').style.display = '';
            if (serverSlug) claimPromptSlug(serverSlug);
            showToast('Upload complete!', 'success');
            const finalSlug = serverSlug || slugify(slug);
            refresh().then(() => selectEp(finalSlug));
            pendingFile = null;
            pendingSrtFile = null;
        }).catch((err) => {
            progressEl.classList.remove('active');
            document.getElementById('upload-zone').style.display = '';
            showToast('Upload failed: ' + err.message + ' — pick the same file again to resume', 'error');
            pendingFile = null;
        });
        return;
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
            const finalSlug = serverSlug || slugify(slug);
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

// ── Pending uploads (interrupted chunked uploads) ──────────────────────────
let _resumePendingTarget = null;
const _activeChunkedUploadIds = new Set();

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadPendingUploads() {
    const section = document.getElementById('pending-uploads-section');
    const listEl = document.getElementById('pending-uploads-list');
    if (!section || !listEl) return;
    let uploads = [];
    try {
        const res = await fetch('/api/uploads-pending');
        const data = await res.json();
        uploads = (data && data.success && Array.isArray(data.uploads)) ? data.uploads : [];
    } catch { uploads = []; }

    // Hide entries that this tab is actively uploading right now
    uploads = uploads.filter(u => !_activeChunkedUploadIds.has(u.uploadId));

    if (uploads.length === 0) {
        section.style.display = 'none';
        listEl.innerHTML = '';
        return;
    }
    section.style.display = '';

    listEl.innerHTML = uploads.map(u => {
        const pct = Math.round((u.receivedChunks / Math.max(u.totalChunks, 1)) * 100);
        const sizeMb = (u.fileSize / 1024 / 1024).toFixed(0);
        const when = u.createdAt ? new Date(u.createdAt).toLocaleString() : '';
        const safeName = escapeHtml(u.filename);
        const jsName = String(u.filename).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const finalizing = u.status === 'finalizing';
        return `
            <div class="pending-upload-item">
                <div class="pending-upload-name" title="${safeName}">📁 ${safeName}</div>
                <div class="pending-upload-meta">
                    <span>${pct}% · ${sizeMb} MB</span>
                    <span title="${when}">${u.receivedChunks}/${u.totalChunks} chunks</span>
                </div>
                <div class="pending-upload-progress"><div class="pending-upload-progress-fill" style="width:${pct}%"></div></div>
                <div class="pending-upload-actions">
                    <button class="primary" ${finalizing ? 'disabled title="Already finalizing"' : ''} onclick="resumePendingUpload('${u.uploadId}', '${jsName}', ${u.fileSize})">↻ Resume</button>
                    <button class="danger" ${finalizing ? 'disabled' : ''} onclick="deletePendingUpload('${u.uploadId}', '${jsName}')">✕ Delete</button>
                </div>
            </div>`;
    }).join('');
}

async function deletePendingUpload(uploadId, filename) {
    if (!confirm(`Delete this incomplete upload?\n\n${filename}\n\nUploaded chunks will be discarded — this cannot be undone.`)) return;
    try {
        const res = await fetch('/api/upload-cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uploadId })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Cancel failed');
        // Drop matching localStorage fingerprint entries so we don't try to resume a dead upload
        const reg = loadUploadRegistry();
        let changed = false;
        for (const fp of Object.keys(reg)) {
            if (reg[fp] && reg[fp].uploadId === uploadId) { delete reg[fp]; changed = true; }
        }
        if (changed) saveUploadRegistry(reg);
        showToast('Upload deleted', 'success');
        loadPendingUploads();
    } catch (err) {
        showToast('Failed to delete: ' + err.message, 'error');
    }
}

function resumePendingUpload(uploadId, filename, fileSize) {
    _resumePendingTarget = { uploadId, filename, fileSize };
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mp4,.mkv,.mov,.avi';
    input.onchange = function() {
        const file = this.files && this.files[0];
        const target = _resumePendingTarget;
        _resumePendingTarget = null;
        if (!file || !target) return;
        if (file.name !== target.filename || file.size !== target.fileSize) {
            const proceed = confirm(
                `The selected file doesn't match the interrupted upload.\n\n` +
                `Expected: ${target.filename} (${(target.fileSize / 1024 / 1024).toFixed(0)} MB)\n` +
                `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(0)} MB)\n\n` +
                `Start as a fresh upload instead?`
            );
            if (proceed) startUploadFlow(file);
            return;
        }
        // Tie this fingerprint to the existing uploadId so findExistingUpload picks it up.
        // chunkSize will be re-fetched from the server inside findExistingUpload.
        const reg = loadUploadRegistry();
        const fingerprint = getFileFingerprint(file);
        reg[fingerprint] = { uploadId, totalChunks: 0, chunkSize: 0, ts: Date.now() };
        saveUploadRegistry(reg);
        startUploadFlow(file);
    };
    input.click();
}
