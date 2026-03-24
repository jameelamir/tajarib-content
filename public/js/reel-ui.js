// ── Reel UI: List, Detail, Trim, Transcript, Find ────────────────────────────

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
            '<div class="reel-list-item-header">' +
                '<div class="reel-list-item-title">Reel ' + r.id + (r.hidden ? ' (hidden)' : '') + '</div>' +
                '<div class="reel-list-item-actions" onclick="event.stopPropagation()">' +
                    '<button class="reel-item-btn" onclick="toggleHideReel(\'' + r.id + '\')" title="' + (r.hidden ? 'Show reel' : 'Hide reel') + '">' +
                        (r.hidden ? '&#128065;' : '&#128064;') +
                    '</button>' +
                    '<button class="reel-item-btn reel-item-btn-del" onclick="deleteReel(\'' + r.id + '\')" title="Delete reel">' +
                        '&#128465;' +
                    '</button>' +
                '</div>' +
            '</div>' +
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
        renderSidebar();
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
        warningEl.style.display = '';
        warningEl.innerHTML = '<div style="background:linear-gradient(135deg,#2a1215,#1f1012); border:1px solid #4a1c1c; color:#fca5a5; padding:10px 14px; border-radius:8px; font-size:0.75rem; margin-bottom:8px; display:flex; align-items:center; gap:10px;">' +
            '<span style="font-size:1rem; flex-shrink:0;">&#9888;</span>' +
            '<span>Source clip missing &mdash; preview shows an orphaned crop from a previous run. Use <strong>Cut</strong> to regenerate.</span>' +
        '</div>';
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

    // Transcript context now integrated into trim editor
    var ctxEl = document.getElementById('reel-transcript-ctx');
    if (ctxEl) ctxEl.style.display = 'none';

    // Per-reel action buttons
    var actionsEl = document.getElementById('reel-actions');
    actionsEl.innerHTML = buildReelActions(ep, r);


    // Caption editor — show generated caption if available
    var captionEl = document.getElementById('reel-caption-editor');
    if (captionEl) {
        // Skip rebuild if the user has an active caption textarea (preserves unsaved edits)
        var existingCaptionTextarea = document.getElementById('reel-caption-text');
        if (existingCaptionTextarea && document.activeElement === existingCaptionTextarea) {
            captionEl.style.display = '';
        } else {
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
                        '<button class="publish-btn" onclick="publishNow()" style="font-size:0.7rem;">Publish</button>' +
                    '</div>';
            } else {
                captionEl.innerHTML =
                    '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                        '<div style="font-size:0.7rem; color:#666; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Caption</div>' +
                        captionBtn +
                    '</div>';
            }
        }
    }

    // Reel transcript editor — show if reel transcript exists
    var transcriptEditorEl = document.getElementById('reel-transcript-editor');
    if (transcriptEditorEl) {
        // Skip rebuild if the editor already has loaded content (preserves unsaved edits)
        var existingContent = document.getElementById('reel-transcript-content');
        var hasLoadedEditor = existingContent && existingContent.style.display !== 'none' && existingContent.querySelector('#rt-seg-list');
        if (hasLoadedEditor) {
            // Editor is active — don't touch it
            transcriptEditorEl.style.display = '';
        } else if (r.subtitled || r.cut || r.cropped) {
            transcriptEditorEl.style.display = '';
            transcriptEditorEl.innerHTML =
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' +
                    '<div style="font-size:0.7rem; color:#666; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Reel Transcript</div>' +
                    '<button onclick="loadReelTranscript(\'' + reelId + '\')" style="font-size:0.65rem;">Load / Edit</button>' +
                '</div>' +
                '<div id="reel-transcript-content" style="display:none;"></div>';
        } else {
            transcriptEditorEl.style.display = 'none';
            transcriptEditorEl.innerHTML = '';
        }
    }

    // Subtitle editor — hidden (duplicate of Reel Transcript section above)
    var subEditorEl = document.getElementById('reel-subtitle-editor');
    if (subEditorEl) {
        subEditorEl.style.display = 'none';
        subEditorEl.innerHTML = '';
    }

    // Update console drawer with reel context
    updateLogs();
}

// ─── Reel-Full View ───────────────────────────────────────────────────────────

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

}


function switchReelFullTab(tab) {
    document.querySelectorAll('.reel-full-tab').forEach(function(el) {
        el.classList.toggle('active', el.dataset.tab === tab);
    });
    ['caption', 'transcript'].forEach(function(t) {
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
    steps.push({ id: 'subtitle', label: 'Sub', done: reel.subtitled, extra:
        '<select id="reel-subtitle-style" class="pipe-inline-select" style="background:transparent; border:none; color:inherit; font-size:0.6rem; padding:0 2px; cursor:pointer;">' +
            '<option value="animated" style="background:#111;">Highlight</option><option value="static" style="background:#111;">Background</option>' +
        '</select>'
    });
    steps.push({ id: 'overlay', label: 'Overlay', done: reel.final, extra:
        '<button class="pipe-overlay-config" onclick="event.stopPropagation(); toggleOverlayConfig()" title="Configure overlays">&#9881; Customize</button>'
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

// ─── Unified Reel Editor ─────────────────────────────────────────────────────

var pendingCuts = [];
var tlState = {
    windowStart: 0, windowEnd: 0, reelStart: 0, reelEnd: 0,
    cutsSec: [], segments: [], selStartIdx: -1, selEndIdx: -1,
    dragging: null, reelId: null, slug: null, animFrame: null
};
var tlDragListeners = { move: null, up: null };

function renderTrimEditor(ep, reel) {
    var trimEl = document.getElementById('reel-trim-editor');
    if (!trimEl) return;
    if (ep.mediaType !== 'episode' || !reel.start || !reel.end) {
        trimEl.style.display = 'none';
        return;
    }
    trimEl.style.display = '';

    // Skip rebuild if same reel already shown
    if (tlState.reelId === reel.id && document.getElementById('tl-track')) {
        var si = document.getElementById('reel-trim-start');
        var ei = document.getElementById('reel-trim-end');
        if (si && si !== document.activeElement) si.value = reel.start;
        if (ei && ei !== document.activeElement) ei.value = reel.end;
        return;
    }

    var reelStartSec = parseTrimTime(reel.start);
    var reelEndSec = parseTrimTime(reel.end);
    var duration = reelEndSec - reelStartSec;

    pendingCuts = (reel.cuts || []).map(function(c) { return { from: c.from, to: c.to }; });
    tlState.reelStart = reelStartSec;
    tlState.reelEnd = reelEndSec;
    tlState.windowStart = Math.max(0, reelStartSec - CONTEXT_SECONDS);
    tlState.windowEnd = reelEndSec + CONTEXT_SECONDS;
    tlState.cutsSec = pendingCuts.map(function(c) {
        return { from: parseTrimTime(c.from), to: parseTrimTime(c.to) };
    }).sort(function(a, b) { return a.from - b.from; });
    tlState.reelId = reel.id;
    tlState.slug = ep.slug;
    tlState.segments = [];
    tlState.selStartIdx = -1;
    tlState.selEndIdx = -1;

    trimEl.innerHTML =
        '<div class="tl-header">' +
            '<span class="tl-label">Trim</span>' +
            '<div class="tl-times">' +
                '<input type="text" id="reel-trim-start" class="tl-time-input" value="' + escHtml(reel.start) + '" title="Reel start" onchange="tlTimeInputChanged()">' +
                '<span class="tl-time-sep">&mdash;</span>' +
                '<input type="text" id="reel-trim-end" class="tl-time-input" value="' + escHtml(reel.end) + '" title="Reel end" onchange="tlTimeInputChanged()">' +
                '<span class="tl-duration" id="tl-duration">' + formatTrimTime(duration) + '</span>' +
            '</div>' +
        '</div>' +
        '<div class="tl-track-wrap">' +
            '<div class="tl-track" id="tl-track">' +
                '<div class="tl-segments" id="tl-segments"></div>' +
                '<div class="tl-playhead" id="tl-playhead"><div class="tl-playhead-head"></div></div>' +
            '</div>' +
            '<div class="tl-ticks" id="tl-ticks"></div>' +
        '</div>' +
        '<div class="tl-toolbar">' +
            '<button onclick="tlSplit()" class="tl-btn tl-split-btn" title="Add a cut at the playhead position">&#9986; Split</button>' +
            '<span id="tl-playhead-time" class="tl-playhead-label">0:00</span>' +
            '<div style="flex:1;"></div>' +
            '<button onclick="tlOpenPreview()" class="tl-btn tl-preview-btn" title="Preview in full episode video">&#9654; Preview</button>' +
            '<button class="primary" onclick="saveReelTrim(\'' + reel.id + '\')" style="font-size:0.7rem;">Save & Re-cut</button>' +
        '</div>' +
        '<div id="tl-transcript" class="tl-transcript">' +
            '<div class="tl-transcript-header">' +
                '<span class="tl-transcript-label">Transcript</span>' +
                '<span class="tl-transcript-hint">loading...</span>' +
            '</div>' +
        '</div>';

    tlRenderSegments();
    tlRenderTicks();
    tlInitTrackEvents();
    tlStartPlayheadSync();
    tlLoadTranscript(ep);
}

async function tlLoadTranscript(ep) {
    var transcript = await loadTranscriptForSlug(ep.slug);
    if (tlState.slug !== ep.slug || !document.getElementById('tl-track')) return;

    if (!transcript || !transcript.segments || !transcript.segments.length) {
        var txEl = document.getElementById('tl-transcript');
        if (txEl) txEl.innerHTML =
            '<div class="tl-transcript-header"><span class="tl-transcript-label">Transcript</span></div>' +
            '<div style="color:#555; font-size:0.75rem; text-align:center; padding:12px;">No transcript available.</div>';
        return;
    }

    var segs = transcript.segments;
    tlState.segments = [];
    var selStart = -1, selEnd = -1;
    for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (s.end < tlState.windowStart) continue;
        if (s.start > tlState.windowEnd) break;
        var idx = tlState.segments.length;
        tlState.segments.push({ start: s.start, end: s.end, text: s.text });
        if (s.start >= tlState.reelStart - 0.5 && s.end <= tlState.reelEnd + 0.5) {
            if (selStart === -1) selStart = idx;
            selEnd = idx;
        }
    }
    if (selStart === -1 && tlState.segments.length) {
        var bestD = Infinity;
        for (var j = 0; j < tlState.segments.length; j++) {
            var d = Math.abs(tlState.segments[j].start - tlState.reelStart);
            if (d < bestD) { bestD = d; selStart = j; }
        }
        selEnd = selStart;
    }
    tlState.selStartIdx = selStart;
    tlState.selEndIdx = selEnd;
    tlRenderTranscript();
}

// ─── Segment Computation & Rendering ─────────────────────────────────────────

function tlComputeZones() {
    var ws = tlState.windowStart, we = tlState.windowEnd;
    var rs = tlState.reelStart, re = tlState.reelEnd;
    var zones = [];
    if (rs > ws) zones.push({ from: ws, to: rs, type: 'context' });
    var cuts = tlState.cutsSec, pos = rs;
    for (var i = 0; i < cuts.length; i++) {
        if (cuts[i].from > pos) zones.push({ from: pos, to: cuts[i].from, type: 'kept' });
        zones.push({ from: cuts[i].from, to: cuts[i].to, type: 'cut', cutIdx: i });
        pos = cuts[i].to;
    }
    if (pos < re) zones.push({ from: pos, to: re, type: 'kept' });
    if (re < we) zones.push({ from: re, to: we, type: 'context' });
    return zones;
}

function tlRenderSegments() {
    var container = document.getElementById('tl-segments');
    if (!container) return;
    var totalDur = tlState.windowEnd - tlState.windowStart;
    if (totalDur <= 0) return;

    var zones = tlComputeZones();
    var html = '';
    for (var i = 0; i < zones.length; i++) {
        var z = zones[i];
        var leftPct = ((z.from - tlState.windowStart) / totalDur) * 100;
        var widthPct = ((z.to - z.from) / totalDur) * 100;
        if (z.type === 'cut') {
            html += '<div class="tl-segment cut" style="left:' + leftPct + '%; width:' + widthPct + '%;" data-cut-idx="' + z.cutIdx + '">' +
                '<button class="tl-cut-remove" onclick="event.stopPropagation(); tlRemoveCut(' + z.cutIdx + ')" title="Remove this cut">&times;</button>' +
            '</div>';
        } else if (z.type === 'kept') {
            html += '<div class="tl-segment kept" style="left:' + leftPct + '%; width:' + widthPct + '%;"></div>';
        } else {
            html += '<div class="tl-segment context" style="left:' + leftPct + '%; width:' + widthPct + '%;"></div>';
        }
    }
    // Cut handles (red)
    for (var j = 0; j < tlState.cutsSec.length; j++) {
        var cut = tlState.cutsSec[j];
        var fromPct = ((cut.from - tlState.windowStart) / totalDur) * 100;
        var toPct = ((cut.to - tlState.windowStart) / totalDur) * 100;
        html += '<div class="tl-handle tl-cut-handle" style="left:' + fromPct + '%;" data-handle="cut-start" data-cut-idx="' + j + '"></div>';
        html += '<div class="tl-handle tl-cut-handle" style="left:' + toPct + '%;" data-handle="cut-end" data-cut-idx="' + j + '"></div>';
    }
    // Reel boundary handles (purple)
    var rsP = ((tlState.reelStart - tlState.windowStart) / totalDur) * 100;
    var reP = ((tlState.reelEnd - tlState.windowStart) / totalDur) * 100;
    html += '<div class="tl-handle tl-bound-handle" style="left:' + rsP + '%;" data-handle="bound-start"></div>';
    html += '<div class="tl-handle tl-bound-handle" style="left:' + reP + '%;" data-handle="bound-end"></div>';
    container.innerHTML = html;
}

function tlRenderTicks() {
    var container = document.getElementById('tl-ticks');
    if (!container) return;
    var duration = tlState.windowEnd - tlState.windowStart;
    if (duration <= 0) return;
    var intervals = [5, 10, 15, 30, 60, 120, 300];
    var interval = intervals[intervals.length - 1];
    for (var k = 0; k < intervals.length; k++) {
        if (duration / intervals[k] <= 10) { interval = intervals[k]; break; }
    }
    var html = '';
    var firstTick = Math.ceil(tlState.windowStart / interval) * interval;
    for (var t = firstTick; t <= tlState.windowEnd; t += interval) {
        var pct = ((t - tlState.windowStart) / duration) * 100;
        html += '<span class="tl-tick" style="left:' + pct + '%;">' + formatTrimTime(t) + '</span>';
    }
    container.innerHTML = html;
}

// ─── Transcript Strip ────────────────────────────────────────────────────────

function tlRenderTranscript() {
    var txEl = document.getElementById('tl-transcript');
    if (!txEl) return;
    if (!tlState.segments.length) {
        txEl.innerHTML =
            '<div class="tl-transcript-header"><span class="tl-transcript-label">Transcript</span></div>' +
            '<div style="color:#555; font-size:0.75rem; text-align:center; padding:12px;">No transcript available.</div>';
        return;
    }

    var segHtml = tlState.segments.map(function(seg, i) {
        var m = Math.floor(seg.start / 60);
        var sc = Math.floor(seg.start % 60);
        var ts = String(m).padStart(2, '0') + ':' + String(sc).padStart(2, '0');
        var inReel = i >= tlState.selStartIdx && i <= tlState.selEndIdx;
        var isCut = inReel && tlIsTimeCut(seg.start, seg.end);
        var cls = 'tl-seg' + (inReel ? ' tl-seg-selected' : '') + (isCut ? ' tl-seg-cut' : '');
        return '<div class="' + cls + '" data-idx="' + i + '">' +
            '<span class="tl-seg-ts">' + ts + '</span>' +
            '<span class="tl-seg-text">' + escHtml(seg.text) + '</span>' +
        '</div>';
    }).join('');

    txEl.innerHTML =
        '<div class="tl-transcript-header">' +
            '<span class="tl-transcript-label">Transcript</span>' +
            '<span class="tl-transcript-hint">click outside reel to extend</span>' +
        '</div>' +
        '<div class="tl-strip-doc" id="tl-strip-doc">' + segHtml + '</div>';

    tlInitStripEvents();
    tlScrollToSelection();
}

function tlIsTimeCut(segStart, segEnd) {
    for (var i = 0; i < tlState.cutsSec.length; i++) {
        var c = tlState.cutsSec[i];
        if (segStart < c.to && segEnd > c.from) return true;
    }
    return false;
}

function tlUpdateTranscriptSelection() {
    var selStart = -1, selEnd = -1;
    for (var i = 0; i < tlState.segments.length; i++) {
        var s = tlState.segments[i];
        if (s.start >= tlState.reelStart - 0.5 && s.end <= tlState.reelEnd + 0.5) {
            if (selStart === -1) selStart = i;
            selEnd = i;
        }
    }
    if (selStart === -1 && tlState.segments.length) {
        var bestD = Infinity;
        for (var j = 0; j < tlState.segments.length; j++) {
            var d = Math.abs(tlState.segments[j].start - tlState.reelStart);
            if (d < bestD) { bestD = d; selStart = j; }
        }
        selEnd = selStart;
    }
    tlState.selStartIdx = selStart;
    tlState.selEndIdx = selEnd;
    var doc = document.getElementById('tl-strip-doc');
    if (!doc) return;
    var segEls = doc.querySelectorAll('.tl-seg');
    for (var k = 0; k < segEls.length; k++) {
        var inReel = k >= selStart && k <= selEnd;
        segEls[k].classList.toggle('tl-seg-selected', inReel);
        var seg = tlState.segments[k];
        segEls[k].classList.toggle('tl-seg-cut', inReel && tlIsTimeCut(seg.start, seg.end));
    }
}

function tlInitStripEvents() {
    var doc = document.getElementById('tl-strip-doc');
    if (!doc) return;
    var segEls = doc.querySelectorAll('.tl-seg');
    for (var i = 0; i < segEls.length; i++) {
        (function(idx) {
            segEls[idx].addEventListener('click', function() {
                if (tlState.dragging) return;
                var seg = tlState.segments[idx];
                if (!seg) return;
                var changed = false;
                if (idx < tlState.selStartIdx) {
                    tlState.reelStart = seg.start;
                    changed = true;
                } else if (idx > tlState.selEndIdx) {
                    tlState.reelEnd = seg.end;
                    changed = true;
                } else {
                    tlSeekVideo(seg.start);
                    return;
                }
                if (changed) {
                    tlState.cutsSec = tlState.cutsSec.filter(function(c) {
                        return c.from >= tlState.reelStart && c.to <= tlState.reelEnd;
                    });
                    tlUpdateTimeInputs();
                    tlRenderSegments();
                    tlUpdateTranscriptSelection();
                    tlSyncPendingCuts();
                }
            });
        })(i);
    }
}

function tlScrollToSelection() {
    setTimeout(function() {
        var doc = document.getElementById('tl-strip-doc');
        if (!doc) return;
        var segEls = doc.querySelectorAll('.tl-seg');
        var el = segEls[tlState.selStartIdx];
        if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }, 50);
}

// ─── Timeline Interaction ────────────────────────────────────────────────────

function tlPctToTime(pct) { return tlState.windowStart + pct * (tlState.windowEnd - tlState.windowStart); }
function tlTimeToPct(sec) { var d = tlState.windowEnd - tlState.windowStart; return d > 0 ? (sec - tlState.windowStart) / d : 0; }

function tlGetVideoOffset() {
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    var r = ep && ep.reelStatuses.find(function(x) { return x.id === selectedReelId; });
    return (r && r.cut && r.start) ? parseTrimTime(r.start) : 0;
}

function tlSeekVideo(timeSec) {
    var video = getReelVideo();
    if (!video) return;
    var clamped = Math.max(tlState.reelStart, Math.min(tlState.reelEnd, timeSec));
    video.currentTime = Math.max(0, clamped - tlGetVideoOffset());
}

function tlSyncPendingCuts() {
    pendingCuts = tlState.cutsSec.map(function(c) {
        return { from: formatTrimTime(c.from), to: formatTrimTime(c.to) };
    });
}

function tlUpdateTimeInputs() {
    var si = document.getElementById('reel-trim-start');
    var ei = document.getElementById('reel-trim-end');
    if (si) si.value = formatTrimTime(tlState.reelStart);
    if (ei) ei.value = formatTrimTime(tlState.reelEnd);
    var durEl = document.getElementById('tl-duration');
    if (durEl) durEl.textContent = formatTrimTime(tlState.reelEnd - tlState.reelStart);
}

function tlSnapToSegBoundary(timeSec, which) {
    if (!tlState.segments.length) return timeSec;
    var best = timeSec, bestDist = Infinity;
    for (var i = 0; i < tlState.segments.length; i++) {
        var s = tlState.segments[i];
        var candidate = which === 'start' ? s.start : s.end;
        var d = Math.abs(candidate - timeSec);
        if (d < bestDist) { bestDist = d; best = candidate; }
    }
    return bestDist < 2 ? best : timeSec;
}

function tlInitTrackEvents() {
    var track = document.getElementById('tl-track');
    if (!track) return;
    if (tlDragListeners.move) document.removeEventListener('pointermove', tlDragListeners.move);
    if (tlDragListeners.up) document.removeEventListener('pointerup', tlDragListeners.up);

    track.addEventListener('pointerdown', function(e) {
        var boundHandle = e.target.closest('.tl-bound-handle');
        if (boundHandle) {
            e.preventDefault();
            tlState.dragging = { type: boundHandle.dataset.handle };
            boundHandle.classList.add('dragging');
            track.classList.add('scrubbing');
            return;
        }
        var cutHandle = e.target.closest('.tl-cut-handle');
        if (cutHandle) {
            e.preventDefault();
            tlState.dragging = { type: cutHandle.dataset.handle, cutIdx: parseInt(cutHandle.dataset.cutIdx) };
            cutHandle.classList.add('dragging');
            track.classList.add('scrubbing');
            return;
        }
        if (e.target.closest('.tl-playhead-head')) {
            e.preventDefault();
            tlState.dragging = { type: 'scrub' };
            track.classList.add('scrubbing');
            return;
        }
        if (e.target.closest('.tl-cut-remove')) return;
        e.preventDefault();
        var rect = track.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        var timeSec = tlPctToTime(pct);
        if (timeSec >= tlState.reelStart && timeSec <= tlState.reelEnd) {
            tlSeekVideo(timeSec);
        }
        tlState.dragging = { type: 'scrub' };
        track.classList.add('scrubbing');
    });

    function onMove(e) {
        if (!tlState.dragging) return;
        e.preventDefault();
        var tr = document.getElementById('tl-track');
        if (!tr) return;
        var rect = tr.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        var timeSec = tlPctToTime(pct);
        var drag = tlState.dragging;

        if (drag.type === 'scrub') {
            tlSeekVideo(timeSec);
        } else if (drag.type === 'bound-start') {
            var snapped = tlSnapToSegBoundary(timeSec, 'start');
            tlState.reelStart = Math.max(tlState.windowStart, Math.min(tlState.reelEnd - 1, snapped));
            tlState.cutsSec = tlState.cutsSec.filter(function(c) {
                return c.from >= tlState.reelStart && c.to <= tlState.reelEnd;
            });
            tlUpdateTimeInputs();
            tlRenderSegments();
            tlUpdateTranscriptSelection();
        } else if (drag.type === 'bound-end') {
            var snapped = tlSnapToSegBoundary(timeSec, 'end');
            tlState.reelEnd = Math.max(tlState.reelStart + 1, Math.min(tlState.windowEnd, snapped));
            tlState.cutsSec = tlState.cutsSec.filter(function(c) {
                return c.from >= tlState.reelStart && c.to <= tlState.reelEnd;
            });
            tlUpdateTimeInputs();
            tlRenderSegments();
            tlUpdateTranscriptSelection();
        } else if (drag.type === 'cut-start' || drag.type === 'cut-end') {
            var cut = tlState.cutsSec[drag.cutIdx];
            if (!cut) return;
            var cuts = tlState.cutsSec;
            if (drag.type === 'cut-start') {
                var lo = drag.cutIdx > 0 ? cuts[drag.cutIdx - 1].to + 0.1 : tlState.reelStart;
                cut.from = Math.round(Math.max(lo, Math.min(cut.to - 0.3, timeSec)) * 10) / 10;
            } else {
                var hi = drag.cutIdx < cuts.length - 1 ? cuts[drag.cutIdx + 1].from - 0.1 : tlState.reelEnd;
                cut.to = Math.round(Math.max(cut.from + 0.3, Math.min(hi, timeSec)) * 10) / 10;
            }
            tlRenderSegments();
        }
    }

    function onUp() {
        if (!tlState.dragging) return;
        var tr = document.getElementById('tl-track');
        if (tr) tr.classList.remove('scrubbing');
        document.querySelectorAll('.tl-handle.dragging').forEach(function(el) { el.classList.remove('dragging'); });
        tlSyncPendingCuts();
        tlState.dragging = null;
    }

    tlDragListeners.move = onMove;
    tlDragListeners.up = onUp;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
}

// ─── Playhead Sync ───────────────────────────────────────────────────────────

function tlStartPlayheadSync() {
    tlStopPlayheadSync();
    function update() {
        var ph = document.getElementById('tl-playhead');
        var lbl = document.getElementById('tl-playhead-time');
        if (!ph) return;
        var video = getReelVideo();
        if (video) {
            var curSec = video.currentTime + tlGetVideoOffset();
            var pct = tlTimeToPct(curSec) * 100;
            ph.style.left = Math.max(0, Math.min(100, pct)) + '%';
            if (lbl) lbl.textContent = formatTrimTime(curSec);
            tlHighlightActiveSegment(curSec);
        }
        tlState.animFrame = requestAnimationFrame(update);
    }
    update();
}

function tlStopPlayheadSync() {
    if (tlState.animFrame) { cancelAnimationFrame(tlState.animFrame); tlState.animFrame = null; }
}

function tlHighlightActiveSegment(timeSec) {
    var doc = document.getElementById('tl-strip-doc');
    if (!doc) return;
    var video = getReelVideo();
    var isPlaying = video && !video.paused;
    var segEls = doc.querySelectorAll('.tl-seg');
    for (var i = 0; i < segEls.length; i++) {
        var seg = tlState.segments[i];
        var playing = seg && timeSec >= seg.start - 0.1 && timeSec < seg.end + 0.1;
        segEls[i].classList.toggle('tl-seg-playing', playing);
        if (playing && isPlaying && !tlState.dragging) {
            var elRect = segEls[i].getBoundingClientRect();
            var docRect = doc.getBoundingClientRect();
            if (elRect.bottom > docRect.bottom - 5 || elRect.top < docRect.top + 5) {
                segEls[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
    }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function tlSplit() {
    var video = getReelVideo();
    if (!video) { showToast('No video loaded — cut the reel first', 'error'); return; }
    var curSec = video.currentTime + tlGetVideoOffset();
    var half = 1;
    var cutFrom = Math.max(tlState.reelStart + 0.1, Math.round((curSec - half) * 10) / 10);
    var cutTo = Math.min(tlState.reelEnd - 0.1, Math.round((cutFrom + half * 2) * 10) / 10);
    for (var i = 0; i < tlState.cutsSec.length; i++) {
        var ex = tlState.cutsSec[i];
        if (cutFrom < ex.to && cutTo > ex.from) {
            showToast('Overlaps an existing cut — move the playhead', 'error');
            return;
        }
    }
    tlState.cutsSec.push({ from: cutFrom, to: cutTo });
    tlState.cutsSec.sort(function(a, b) { return a.from - b.from; });
    tlSyncPendingCuts();
    tlRenderSegments();
    tlUpdateTranscriptSelection();
}

function tlRemoveCut(cutIdx) {
    tlState.cutsSec.splice(cutIdx, 1);
    tlSyncPendingCuts();
    tlRenderSegments();
    tlUpdateTranscriptSelection();
}

function tlTimeInputChanged() {
    var startEl = document.getElementById('reel-trim-start');
    var endEl = document.getElementById('reel-trim-end');
    if (startEl) tlState.reelStart = parseTrimTime(startEl.value);
    if (endEl) tlState.reelEnd = parseTrimTime(endEl.value);
    tlState.windowStart = Math.max(0, tlState.reelStart - CONTEXT_SECONDS);
    tlState.windowEnd = tlState.reelEnd + CONTEXT_SECONDS;
    var durEl = document.getElementById('tl-duration');
    if (durEl) durEl.textContent = formatTrimTime(tlState.reelEnd - tlState.reelStart);
    tlState.cutsSec = tlState.cutsSec.filter(function(c) {
        return c.from >= tlState.reelStart && c.to <= tlState.reelEnd;
    });
    tlSyncPendingCuts();
    tlRenderSegments();
    tlRenderTicks();
    if (tlState.slug) {
        var ep = episodes.find(function(e) { return e.slug === tlState.slug; });
        if (ep) tlLoadTranscript(ep);
    }
}

function tlOpenPreview() {
    if (!currentSlug) return;
    ctxState.segments = tlState.segments;
    ctxState.startIdx = tlState.selStartIdx;
    ctxState.endIdx = tlState.selEndIdx;
    ctxState.videoSrc = '/api/video?slug=' + encodeURIComponent(currentSlug) + '&type=raw';
    ctxState.reelStartSec = tlState.reelStart;
    openCtxVideoPopup();
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

    ctxEl.innerHTML =
        '<button class="ctx-toggle-btn" onclick="toggleCtxPanel()">✂ Adjust Reel Boundaries</button>' +
        '<div class="ctx-panel" id="ctx-panel" style="display:none;">' +
            '<div class="ctx-header">' +
                '<span class="ctx-title">Transcript</span>' +
                '<button class="ctx-preview-btn" onclick="openCtxVideoPopup()">▶ Preview</button>' +
                '<span class="ctx-hint">drag edges to adjust</span>' +
            '</div>' +
            '<div class="ctx-doc" id="ctx-doc">' +
                segHtml +
                '<div class="ctx-handle" id="ctx-handle-start"></div>' +
                '<div class="ctx-handle" id="ctx-handle-end"></div>' +
            '</div>' +
            '<div style="display:flex; justify-content:flex-end; margin-top:8px;">' +
                '<button class="primary" onclick="saveReelTrim(\'' + reel.id + '\')" style="font-size:0.7rem;">Save & Re-cut</button>' +
            '</div>' +
        '</div>';

    // Store video src for the popup
    ctxState.videoSrc = '/api/video?slug=' + encodeURIComponent(ep.slug) + '&type=raw';
    ctxState.reelStartSec = reelStartSec;
    ctxState.needsInit = true;
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

function toggleCtxPanel() {
    var panel = document.getElementById('ctx-panel');
    if (!panel) return;
    var visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : '';
    if (!visible && ctxState.needsInit) {
        ctxState.needsInit = false;
        ctxPositionHandles();
        ctxInitEvents();
        ctxScrollToSelection();
    }
}

function openCtxVideoPopup() {
    if (!ctxState.videoSrc) return;
    var overlay = document.createElement('div');
    overlay.id = 'ctx-video-popup';
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:150; display:flex; align-items:center; justify-content:center;';
    overlay.innerHTML =
        '<div style="background:#141414; border:1px solid #333; border-radius:12px; padding:16px; max-width:720px; width:90%; max-height:85vh; display:flex; flex-direction:column; gap:12px;">' +
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                '<span style="font-size:0.85rem; font-weight:600; color:#ddd;">Episode Preview</span>' +
                '<button onclick="closeCtxVideoPopup()" style="background:none; border:none; color:#888; font-size:1.2rem; cursor:pointer; padding:4px 8px;">&times;</button>' +
            '</div>' +
            '<video id="ctx-popup-video" controls preload="metadata" src="' + ctxState.videoSrc + '" style="width:100%; max-height:60vh; border-radius:8px; background:#000;"></video>' +
            '<div id="ctx-popup-segments" style="overflow-y:auto; max-height:200px; border-radius:6px; background:#0a0a0a; border:1px solid #222;"></div>' +
        '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeCtxVideoPopup(); });

    // Populate segments from ctxState
    var segsEl = document.getElementById('ctx-popup-segments');
    if (segsEl && ctxState.segments) {
        segsEl.innerHTML = ctxState.segments.map(function(seg, i) {
            var m = Math.floor(seg.start / 60);
            var sc = Math.floor(seg.start % 60);
            var ts = String(m).padStart(2, '0') + ':' + String(sc).padStart(2, '0');
            var inRange = i >= ctxState.startIdx && i <= ctxState.endIdx;
            return '<div class="ctx-popup-seg" data-idx="' + i + '" onclick="ctxPopupSeek(' + seg.start + ')" style="padding:6px 10px; cursor:pointer; font-size:0.75rem; display:flex; gap:8px; border-bottom:1px solid #1a1a1a;' +
                (inRange ? ' background:#1a0a2e; color:#c084fc;' : ' color:#888;') + '">' +
                '<span style="color:#555; font-family:monospace; flex-shrink:0;">' + ts + '</span>' +
                '<span style="direction:rtl; text-align:right; flex:1;">' + escHtml(seg.text) + '</span>' +
            '</div>';
        }).join('');
    }

    // Seek video to reel start
    var vid = document.getElementById('ctx-popup-video');
    if (vid) {
        vid.addEventListener('loadedmetadata', function() { vid.currentTime = ctxState.reelStartSec; }, { once: true });
        vid.addEventListener('timeupdate', ctxPopupTrackPlayback);
    }
}

function closeCtxVideoPopup() {
    var popup = document.getElementById('ctx-video-popup');
    if (popup) popup.remove();
}

function ctxPopupSeek(timeSec) {
    var vid = document.getElementById('ctx-popup-video');
    if (vid) { vid.currentTime = timeSec; vid.play().catch(function() {}); }
}

function ctxPopupTrackPlayback() {
    var vid = document.getElementById('ctx-popup-video');
    if (!vid || vid.paused) return;
    var t = vid.currentTime;
    var segsEl = document.getElementById('ctx-popup-segments');
    if (!segsEl) return;
    var segEls = segsEl.querySelectorAll('.ctx-popup-seg');
    for (var i = 0; i < segEls.length; i++) {
        var seg = ctxState.segments[i];
        var playing = seg && t >= seg.start - 0.1 && t < seg.end + 0.1;
        segEls[i].style.outline = playing ? '1px solid var(--accent)' : '';
    }
}

function ctxPlaySegment(idx) {
    // Open popup and seek to segment
    openCtxVideoPopup();
    setTimeout(function() { ctxPopupSeek(ctxState.segments[idx].start); }, 500);
}

function ctxTrackPlayback() {
    // Inline video removed — tracking happens in popup via ctxPopupTrackPlayback
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

// ─── Trim Utilities ──────────────────────────────────────────────────────────

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
    // Visual timeline mode — sync from tlState
    if (document.getElementById('tl-track')) {
        pendingCuts = tlState.cutsSec.map(function(c) {
            return { from: formatTrimTime(c.from), to: formatTrimTime(c.to) };
        });
        return;
    }
    // Legacy text-input mode
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

// ─── Reel Transcript Editor ──────────────────────────────────────────────────
// Shows the exact subtitle chunks that will appear on screen (same chunking
// logic as subtitle.js), not raw Whisper segments. User can edit text and
// split/merge chunks. Saves to reel-XX-chunks.json which subtitle.js uses
// directly, bypassing re-chunking.

var reelTranscriptData = null;
var reelTranscriptReelId = null;
var reelChunksData = null; // computed/saved subtitle chunks

// Mirrors subtitle.js reelWordsFromTranscript — fills in words missing from
// Whisper word-level timing using segment text as the source of truth.
function rtReelWordsFromTranscript(t) {
    if (!t.segments || !t.segments.length) return t.words || [];
    var result = [];
    for (var i = 0; i < t.segments.length; i++) {
        var seg = t.segments[i];
        var textWords = seg.text.trim().split(/\s+/).filter(Boolean);
        if (!textWords.length) continue;
        var segWords = seg.words || [];
        if (segWords.length === textWords.length) {
            for (var j = 0; j < segWords.length; j++) result.push(segWords[j]);
        } else {
            var dur = seg.end - seg.start;
            var wordDur = textWords.length > 0 ? dur / textWords.length : dur;
            var swIdx = 0;
            textWords.forEach(function(w, wi) {
                if (swIdx < segWords.length && segWords[swIdx].word === w) {
                    result.push(segWords[swIdx++]);
                } else {
                    result.push({ word: w, start: seg.start + wi * wordDur, end: seg.start + (wi + 1) * wordDur, probability: 0.5 });
                }
            });
        }
    }
    return result;
}

// Mirrors subtitle.js chunkWords — groups words into subtitle chunks using
// the same pause/sentence/length rules.
var RT_PAUSE_BREAK_SEC = 0.4;
var RT_SENTENCE_END_RE = /[.!?؟…]+$/;
function rtChunkWords(words) {
    var chunks = [];
    var current = { words: [], start: null, end: null };
    for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (w.start < 0) continue;
        if (current.words.length > 0) {
            var gap = w.start - current.end;
            if (gap >= RT_PAUSE_BREAK_SEC) {
                chunks.push({ text: current.words.join(' '), start: current.start, end: current.end });
                current = { words: [], start: null, end: null };
            }
        }
        if (current.start === null) current.start = w.start;
        var trimmed = w.word.trim();
        current.words.push(trimmed);
        current.end = w.end;
        var isSentenceEnd = RT_SENTENCE_END_RE.test(trimmed);
        var hitLimit = current.words.length >= 6 || (current.end - current.start) >= 2;
        if (isSentenceEnd || hitLimit) {
            chunks.push({ text: current.words.join(' '), start: current.start, end: current.end });
            current = { words: [], start: null, end: null };
        }
    }
    if (current.words.length > 0) chunks.push({ text: current.words.join(' '), start: current.start, end: current.end });
    // Close gaps (MAX_GAP_FILL = 3s, same as subtitle.js)
    for (var j = 0; j < chunks.length - 1; j++) {
        var g = chunks[j + 1].start - chunks[j].end;
        if (g > 0 && g <= 3) chunks[j].end = chunks[j + 1].start;
    }
    return chunks;
}

async function loadReelTranscript(reelId) {
    var contentEl = document.getElementById('reel-transcript-content');
    if (!contentEl) return;
    contentEl.style.display = '';
    contentEl.innerHTML = '<div style="color:#888; font-size:0.7rem; padding:8px;">Loading...</div>';

    var padded = String(reelId).padStart(2, '0');
    reelTranscriptReelId = reelId;
    reelChunksData = null;

    // Try loading previously saved chunks first
    try {
        var chunksRes = await fetch('/api/file?slug=' + encodeURIComponent(currentSlug) + '&file=' + encodeURIComponent('reels/reel-' + padded + '-chunks.json'));
        if (chunksRes.ok) {
            reelChunksData = JSON.parse(await chunksRes.text());
            rtRenderChunks(contentEl);
            return;
        }
    } catch (_) {}

    // Fall back to computing chunks from the reel transcript
    try {
        var res = await fetch('/api/file?slug=' + encodeURIComponent(currentSlug) + '&file=' + encodeURIComponent('reels/reel-' + padded + '-transcript.json'));
        if (!res.ok) throw new Error('No reel transcript found');
        reelTranscriptData = JSON.parse(await res.text());
        var words = rtReelWordsFromTranscript(reelTranscriptData);
        reelChunksData = rtChunkWords(words);
        rtRenderChunks(contentEl);
    } catch (err) {
        contentEl.innerHTML = '<div style="color:#f59e0b; font-size:0.7rem; padding:8px;">No reel transcript yet — run Sub first to transcribe this reel.</div>';
    }
}

// Sync all contenteditable DOM text back to reelChunksData so no edits are lost
// when the editor re-renders (e.g. after split/merge).
function rtSyncDomToData() {
    var segList = document.getElementById('rt-seg-list');
    if (!segList || !reelChunksData) return;
    segList.querySelectorAll('.tm-text[contenteditable]').forEach(function(el) {
        var idx = parseInt(el.dataset.seg);
        if (reelChunksData[idx]) reelChunksData[idx].text = el.textContent.trim();
    });
}

// Get cursor offset within a contenteditable, handling text nodes
function rtGetCursorOffset(el) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return 0;
    var range = sel.getRangeAt(0);
    var preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length;
}

// Set cursor at a character offset within a contenteditable
function rtSetCursor(el, offset) {
    el.focus();
    var node = el.firstChild;
    if (!node) { // empty element
        var r = document.createRange(); r.selectNodeContents(el); r.collapse(true);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        return;
    }
    // Walk text nodes to find the right position
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var remaining = offset;
    var textNode;
    while ((textNode = walker.nextNode())) {
        if (remaining <= textNode.length) {
            var r = document.createRange(); r.setStart(textNode, remaining); r.collapse(true);
            var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
            return;
        }
        remaining -= textNode.length;
    }
    // Offset past end — place at very end
    var r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}

// Get the .tm-text element for a given chunk index
function rtGetSegEl(idx) {
    return document.querySelector('#rt-seg-list .tm-text[data-seg="' + idx + '"]');
}

function rtRenderChunks(containerEl) {
    if (!containerEl) containerEl = document.getElementById('reel-transcript-content');
    if (!containerEl || !reelChunksData) return;

    var html = '<div id="rt-seg-list" style="max-height:350px; overflow-y:auto; padding:4px 0; margin-bottom:8px;">';
    for (var i = 0; i < reelChunksData.length; i++) {
        var chunk = reelChunksData[i];
        var sm = String(Math.floor(chunk.start / 60)).padStart(2, '0');
        var ss = String(Math.floor(chunk.start % 60)).padStart(2, '0');
        var em = String(Math.floor(chunk.end / 60)).padStart(2, '0');
        var es = String(Math.floor(chunk.end % 60)).padStart(2, '0');
        html += '<div class="tm-seg in-range" data-idx="' + i + '" onclick="seekReelVideo(' + chunk.start + ')">' +
            '<span class="tm-text" contenteditable="true" data-seg="' + i + '" data-original="' + escHtml(chunk.text) + '" spellcheck="false">' + escHtml(chunk.text) + '</span>' +
            '<span class="tm-ts">' + sm + ':' + ss + '–' + em + ':' + es + '</span>' +
        '</div>';
    }
    html += '</div>';
    html += '<div style="display:flex; gap:6px;">' +
        '<button onclick="saveReelChunks(\'' + reelTranscriptReelId + '\')" class="primary" style="font-size:0.7rem; flex:1;">Save & Re-sub</button>' +
    '</div>' +
    '<div id="reel-transcript-status" style="font-size:0.7rem; margin-top:4px; color:#666;"></div>';

    containerEl.innerHTML = html;

    containerEl.querySelectorAll('.tm-text[contenteditable]').forEach(function(el) {
        el.addEventListener('click', function(e) { e.stopPropagation(); });
        el.addEventListener('focus', function(e) { e.stopPropagation(); });
        el.addEventListener('input', function() {
            var idx = parseInt(this.dataset.seg);
            if (reelChunksData[idx]) reelChunksData[idx].text = this.textContent.trim();
            this.classList.toggle('edited', this.textContent.trim() !== this.dataset.original);
        });
        el.addEventListener('keydown', function(e) {
            var idx = parseInt(this.dataset.seg);
            if (e.key === 'Enter') {
                e.preventDefault();
                rtSplitChunk(idx, this);
            } else if (e.key === 'Backspace') {
                var cursorPos = rtGetCursorOffset(this);
                var sel = window.getSelection();
                if (sel.rangeCount && sel.getRangeAt(0).collapsed && cursorPos === 0) {
                    e.preventDefault();
                    rtMergeChunkWithPrev(idx);
                }
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                // Navigate between segments
                var targetIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
                if (targetIdx >= 0 && targetIdx < reelChunksData.length) {
                    e.preventDefault();
                    var target = rtGetSegEl(targetIdx);
                    if (target) {
                        var cursorPos = rtGetCursorOffset(this);
                        var targetLen = target.textContent.length;
                        rtSetCursor(target, Math.min(cursorPos, targetLen));
                        target.closest('.tm-seg').scrollIntoView({ block: 'nearest' });
                    }
                }
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                // RTL: ArrowRight visually moves left (toward start), ArrowLeft visually moves right (toward end)
                var cursorPos = rtGetCursorOffset(this);
                var textLen = this.textContent.length;
                // ArrowRight at start of text → jump to end of previous segment
                if (e.key === 'ArrowRight' && cursorPos === 0 && idx > 0 && !e.shiftKey) {
                    e.preventDefault();
                    var prev = rtGetSegEl(idx - 1);
                    if (prev) {
                        rtSetCursor(prev, prev.textContent.length);
                        prev.closest('.tm-seg').scrollIntoView({ block: 'nearest' });
                    }
                }
                // ArrowLeft at end of text → jump to start of next segment
                else if (e.key === 'ArrowLeft' && cursorPos === textLen && idx < reelChunksData.length - 1 && !e.shiftKey) {
                    e.preventDefault();
                    var next = rtGetSegEl(idx + 1);
                    if (next) {
                        rtSetCursor(next, 0);
                        next.closest('.tm-seg').scrollIntoView({ block: 'nearest' });
                    }
                }
            }
        });
    });
}

function rtSplitChunk(chunkIdx, el) {
    var chunk = reelChunksData[chunkIdx];
    if (!chunk) return;
    var offset = rtGetCursorOffset(el);
    var fullText = el.textContent;
    if (offset === 0 || offset >= fullText.length) return;
    var textBefore = fullText.substring(0, offset).trim();
    var textAfter = fullText.substring(offset).trim();
    if (!textBefore || !textAfter) return;
    rtSyncDomToData();
    var splitTime = chunk.start + (chunk.end - chunk.start) * (offset / fullText.length);
    reelChunksData.splice(chunkIdx, 1,
        { text: textBefore, start: chunk.start, end: splitTime },
        { text: textAfter, start: splitTime, end: chunk.end }
    );
    rtRenderChunks();
    var newEl = rtGetSegEl(chunkIdx + 1);
    if (newEl) rtSetCursor(newEl, 0);
}

function rtMergeChunkWithPrev(chunkIdx) {
    if (chunkIdx <= 0) return;
    rtSyncDomToData();
    var prev = reelChunksData[chunkIdx - 1];
    var curr = reelChunksData[chunkIdx];
    var prevLen = prev.text.length;
    prev.text = prev.text + ' ' + curr.text;
    prev.end = curr.end;
    reelChunksData.splice(chunkIdx, 1);
    rtRenderChunks();
    var el = rtGetSegEl(chunkIdx - 1);
    if (el) rtSetCursor(el, prevLen + 1);
}

function seekReelVideo(time) {
    var video = document.querySelector('#reel-preview video');
    if (video) {
        video.currentTime = time;
        video.play();
    }
}

async function saveReelChunks(reelId) {
    var statusEl = document.getElementById('reel-transcript-status');
    if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.style.color = '#888'; }
    if (!reelChunksData) return;
    var padded = String(reelId).padStart(2, '0');
    try {
        // Collect any in-progress text edits
        var segList = document.getElementById('rt-seg-list');
        if (segList) {
            segList.querySelectorAll('.tm-text[contenteditable]').forEach(function(el) {
                var idx = parseInt(el.dataset.seg);
                if (reelChunksData[idx]) reelChunksData[idx].text = el.textContent.trim();
            });
        }

        await fetch('/api/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                slug: currentSlug,
                file: 'reels/reel-' + padded + '-chunks.json',
                content: JSON.stringify(reelChunksData, null, 2)
            })
        });

        if (segList) {
            segList.querySelectorAll('.tm-text.edited').forEach(function(el) {
                el.dataset.original = el.textContent.trim();
                el.classList.remove('edited');
            });
        }
        if (statusEl) { statusEl.textContent = 'Saved! Re-burning subtitles...'; statusEl.style.color = '#4ade80'; }

        await fetch('/api/run-step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                slug: currentSlug,
                step: 'subtitle',
                reelId: reelId,
                force: true,
                noTranscribe: true,
                subtitleStyle: (document.getElementById('reel-subtitle-style') || {}).value || 'animated'
            })
        });
    } catch (err) {
        if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.color = '#ef4444'; }
    }
}

// ─── Subtitle / Caption Editing ──────────────────────────────────────────────

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

// ─── Run Reel Step ───────────────────────────────────────────────────────────

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

    if (step === 'subtitle') {
        var styleEl = document.getElementById('reel-subtitle-style');
        body.subtitleStyle = styleEl ? styleEl.value : 'animated';
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
