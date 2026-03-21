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

    // Reel transcript editor — show if reel transcript exists
    var transcriptEditorEl = document.getElementById('reel-transcript-editor');
    if (transcriptEditorEl) {
        // Always show for subtitled reels (they have a reel transcript from Groq/Whisper)
        if (r.subtitled || r.cut || r.cropped) {
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

    // Update console drawer with reel context
    updateLogs();
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

// ─── Trim Editor ─────────────────────────────────────────────────────────────

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

var reelTranscriptData = null;
var reelTranscriptReelId = null;

async function loadReelTranscript(reelId) {
    var contentEl = document.getElementById('reel-transcript-content');
    if (!contentEl) return;
    contentEl.style.display = '';
    contentEl.innerHTML = '<div style="color:#888; font-size:0.7rem; padding:8px;">Loading...</div>';

    var padded = String(reelId).padStart(2, '0');
    reelTranscriptReelId = reelId;
    try {
        var res = await fetch('/api/file?slug=' + encodeURIComponent(currentSlug) + '&file=' + encodeURIComponent('reels/reel-' + padded + '-transcript.json'));
        if (!res.ok) throw new Error('No reel transcript found');
        reelTranscriptData = JSON.parse(await res.text());

        rtRenderSegments(contentEl);
    } catch (err) {
        contentEl.innerHTML = '<div style="color:#f59e0b; font-size:0.7rem; padding:8px;">No reel transcript yet — run Sub first to transcribe this reel.</div>';
    }
}

function rtRenderSegments(containerEl) {
    if (!containerEl) containerEl = document.getElementById('reel-transcript-content');
    if (!containerEl || !reelTranscriptData) return;
    var segs = reelTranscriptData.segments || [];

    var html = '<div id="rt-seg-list" style="max-height:350px; overflow-y:auto; padding:4px 0; margin-bottom:8px;">';
    for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        var mins = String(Math.floor(seg.start / 60)).padStart(2, '0');
        var secs = String(Math.floor(seg.start % 60)).padStart(2, '0');

        html += '<div class="tm-seg in-range" data-idx="' + i + '" onclick="seekReelVideo(' + seg.start + ')">' +
            '<span class="tm-text" contenteditable="true" data-seg="' + i + '" data-original="' + escHtml(seg.text) + '" spellcheck="false">' + escHtml(seg.text) + '</span>' +
            '<span class="tm-ts">' + mins + ':' + secs + '</span>' +
        '</div>';
    }
    html += '</div>';
    html += '<div style="display:flex; gap:6px;">' +
        '<button onclick="saveReelTranscript(\'' + reelTranscriptReelId + '\')" class="primary" style="font-size:0.7rem; flex:1;">Save & Re-burn Subs</button>' +
    '</div>' +
    '<div id="reel-transcript-status" style="font-size:0.7rem; margin-top:4px; color:#666;"></div>';

    containerEl.innerHTML = html;

    // Wire up CapCut-style editing: Enter=split, Backspace@start=merge, input=mark edited
    containerEl.querySelectorAll('.tm-text[contenteditable]').forEach(function(el) {
        el.addEventListener('click', function(e) { e.stopPropagation(); });
        el.addEventListener('focus', function(e) { e.stopPropagation(); });
        el.addEventListener('input', function() {
            this.classList.toggle('edited', this.textContent.trim() !== this.dataset.original);
        });
        el.addEventListener('keydown', function(e) {
            var segIdx = parseInt(this.dataset.seg);
            if (e.key === 'Enter') {
                e.preventDefault();
                rtSplitSegment(segIdx, this);
            } else if (e.key === 'Backspace') {
                var sel = window.getSelection();
                if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
                    if (sel.getRangeAt(0).startOffset === 0) {
                        e.preventDefault();
                        rtMergeWithPrev(segIdx);
                    }
                }
            }
        });
    });
}

function rtSplitSegment(segIdx, el) {
    var segs = reelTranscriptData.segments;
    var seg = segs[segIdx];
    if (!seg) return;

    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var offset = sel.getRangeAt(0).startOffset;
    var fullText = el.textContent;
    if (offset === 0 || offset >= fullText.length) return;

    var textBefore = fullText.substring(0, offset).trim();
    var textAfter = fullText.substring(offset).trim();
    if (!textBefore || !textAfter) return;

    var segDur = (seg.end || seg.start) - seg.start;
    var ratio = offset / fullText.length;
    var splitTime = seg.start + segDur * ratio;

    var wordsBefore = textBefore.split(/\s+/).filter(function(t) { return t; });
    var wordsAfter = textAfter.split(/\s+/).filter(function(t) { return t; });
    var dur1 = splitTime - seg.start;
    var dur2 = (seg.end || splitTime) - splitTime;

    var seg1 = { start: seg.start, end: splitTime, text: textBefore,
        words: wordsBefore.map(function(w, i) { var wd = dur1 / wordsBefore.length; return { word: w, start: seg.start + i * wd, end: seg.start + (i + 1) * wd, probability: 0.5 }; })
    };
    var seg2 = { start: splitTime, end: seg.end || splitTime, text: textAfter,
        words: wordsAfter.map(function(w, i) { var wd = dur2 / wordsAfter.length; return { word: w, start: splitTime + i * wd, end: splitTime + (i + 1) * wd, probability: 0.5 }; })
    };

    segs.splice(segIdx, 1, seg1, seg2);
    rtRenderSegments();

    // Focus the second segment at the start
    var newEl = document.querySelector('#rt-seg-list .tm-text[data-seg="' + (segIdx + 1) + '"]');
    if (newEl) {
        newEl.focus();
        var r = document.createRange();
        r.setStart(newEl.firstChild || newEl, 0);
        r.collapse(true);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
    }
}

function rtMergeWithPrev(segIdx) {
    var segs = reelTranscriptData.segments;
    if (segIdx <= 0) return;
    var prev = segs[segIdx - 1];
    var curr = segs[segIdx];
    var prevLen = prev.text.length;

    prev.text = prev.text + ' ' + curr.text;
    prev.end = curr.end || curr.start;
    prev.words = (prev.words || []).concat(curr.words || []);
    segs.splice(segIdx, 1);

    rtRenderSegments();

    // Place cursor at the join point
    var el = document.querySelector('#rt-seg-list .tm-text[data-seg="' + (segIdx - 1) + '"]');
    if (el && el.firstChild) {
        el.focus();
        var r = document.createRange();
        var pos = Math.min(prevLen + 1, el.firstChild.textContent.length);
        r.setStart(el.firstChild, pos);
        r.collapse(true);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
    }
}

function seekReelVideo(time) {
    var video = document.querySelector('#reel-preview video');
    if (video) {
        video.currentTime = time;
        video.play();
    }
}

async function saveReelTranscript(reelId) {
    var statusEl = document.getElementById('reel-transcript-status');
    if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.style.color = '#888'; }

    if (!reelTranscriptData) return;
    var padded = String(reelId).padStart(2, '0');
    var transcript = reelTranscriptData;
    var segs = transcript.segments;

    try {
        // Collect edits from CapCut-style contenteditable text blocks
        var segList = document.getElementById('rt-seg-list');
        if (segList) {
            segList.querySelectorAll('.tm-text[contenteditable]').forEach(function(el) {
                var segIdx = parseInt(el.dataset.seg);
                var seg = segs[segIdx];
                if (!seg) return;
                var newText = el.textContent.trim();
                if (newText !== (seg.text || '').trim()) {
                    seg.text = newText;
                    // Rebuild word-level data from edited text
                    var tokens = newText.split(/\s+/).filter(function(t) { return t; });
                    var segDur = (seg.end || seg.start) - seg.start;
                    var wordDur = tokens.length > 0 ? segDur / tokens.length : segDur;
                    seg.words = tokens.map(function(tok, ti) {
                        return { word: tok, start: seg.start + ti * wordDur, end: seg.start + (ti + 1) * wordDur, probability: 0.5 };
                    });
                }
            });
        }

        // Rebuild top-level words and full_text
        transcript.words = [];
        transcript.full_text = '';
        segs.forEach(function(seg) {
            if (seg.words) transcript.words.push.apply(transcript.words, seg.words);
            transcript.full_text += (transcript.full_text ? ' ' : '') + seg.text;
        });
        transcript.word_count = transcript.words.length;

        // Save transcript
        await fetch('/api/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                slug: currentSlug,
                file: 'reels/reel-' + padded + '-transcript.json',
                content: JSON.stringify(transcript, null, 2)
            })
        });

        // Reset edited markers
        if (segList) {
            segList.querySelectorAll('.tm-text.edited').forEach(function(el) {
                el.dataset.original = el.textContent.trim();
                el.classList.remove('edited');
            });
        }

        if (statusEl) { statusEl.textContent = 'Saved! Re-burning subtitles...'; statusEl.style.color = '#4ade80'; }

        // Trigger subtitle re-burn using the edited transcript (no re-transcription)
        await fetch('/api/run-step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                slug: currentSlug,
                step: 'subtitle',
                reelId: reelId,
                force: true,
                noTranscribe: true
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
