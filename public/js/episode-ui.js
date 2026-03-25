// ── Episode UI: Core rendering, editors, pipeline ───────────────────────────

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
        const sizeMb = ep.videoSize ? (ep.videoSize / 1024 / 1024).toFixed(0) + 'MB' : '';
        const typeClass = ep.mediaType;
        const typeLabel = ep.mediaType === 'episode' ? 'EP' : ep.mediaType === 'reel_full' ? 'RF' : 'RC';
        const mtLabel = ep.multiTrack ? ' MT' : '';

        var analyzeBtn = '';
        if (ep.mediaType === 'episode' && ep.steps.transcribed) {
            var analyzing = isStepRunning(ep.slug, 'analyze');
            var label = analyzing ? '⏳' : ep.steps.analyzed ? 'Analyze ✓' : 'Analyze';
            var cls = 'ep-analyze-btn' + (ep.steps.analyzed ? ' done' : '') + (analyzing ? ' running' : '');
            analyzeBtn = '<button class="' + cls + '" onclick="event.stopPropagation(); currentSlug=\'' + ep.slug + '\'; runStep(\'analyze\')">' + label + '</button>';
        }

        var epHtml = '<div class="ep-item ' + (currentSlug === ep.slug ? 'active' : '') + '" onclick="selectEp(\'' + ep.slug + '\')">' +
            '<div class="ep-slug">' +
                '<span class="ep-type-badge ' + typeClass + '">' + typeLabel + mtLabel + '</span>' +
                '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;">' + ep.slug + '</span>' +
                analyzeBtn +
            '</div>' +
            (sizeMb ? '<div class="ep-info"><span>' + sizeMb + '</span></div>' : '') +
            (ep.steps.published ? '<div class="ep-published" title="Published"></div>' : '') +
        '</div>';

        // Embed reels under active episode
        if (currentSlug === ep.slug && ep.reelStatuses && ep.reelStatuses.length > 0) {
            var hiddenCount = ep.reelStatuses.filter(function(r) { return r.hidden; }).length;
            var visibleReels = showHiddenReels ? ep.reelStatuses : ep.reelStatuses.filter(function(r) { return !r.hidden; });

            var topicBtnHtml = (ep.mediaType === 'episode' && ep.steps.transcribed) ?
                '<input type="text" id="clip-topic-input" placeholder="topic..." onclick="event.stopPropagation()" onkeydown="if(event.key===\'Enter\'){event.stopPropagation();generateTopicClip()}" style="background:#111; border:1px solid #b45309; color:#ddd; padding:2px 6px; border-radius:4px; font-size:0.6rem; width:70px; min-width:0;">' +
                '<button style="background:#f59e0b; color:#000; border-color:#f59e0b;" onclick="event.stopPropagation(); generateTopicClip()">+ Topic</button>' : '';

            var toolbarHtml = '<div class="ep-reels-toolbar">' +
                '<button onclick="event.stopPropagation(); openFindReel()" style="color:var(--accent); border-color:var(--accent);">+ Find</button>' +
                '<button onclick="event.stopPropagation(); getMoreReels()" style="color:#c084fc;">+ More</button>' +
                '<button onclick="event.stopPropagation(); getTopicReel()" style="color:#34d399;">+ Topic</button>' +
                topicBtnHtml +
                '<button onclick="event.stopPropagation(); runStep(\'cut\')">Cut All</button>' +
                '<button onclick="event.stopPropagation(); runStep(\'crop\')">Crop All</button>' +
                '<button onclick="event.stopPropagation(); runStep(\'subtitle\')">Sub All</button>' +
                '<button onclick="event.stopPropagation(); runStep(\'overlay\')">Ovr All</button>' +
                '<button onclick="event.stopPropagation(); finalizeAll()" style="color:#f59e0b;">Finalize</button>' +
                (hiddenCount > 0 ? '<button onclick="event.stopPropagation(); showHiddenReels=!showHiddenReels; renderSidebar();" style="opacity:0.5;">' + (showHiddenReels ? 'Hide' : 'Show ' + hiddenCount) + '</button>' : '') +
            '</div>';

            var reelsHtml = visibleReels.map(function(r) {
                var dotDefs = [
                    {key: 'cut', title: 'Cut'},
                    {key: 'generated', title: 'Caption'},
                    {key: 'cropped', title: 'Crop'},
                    {key: 'subtitled', title: 'Subtitle'},
                    {key: 'final', title: 'Overlay'}
                ];
                var dots = dotDefs.map(function(d) {
                    var cls = r[d.key] ? 'done' : (d.key === 'cut' && !r.cut ? 'missing' : 'pending');
                    return '<span class="dot ' + cls + '" title="' + d.title + '"></span>';
                }).join('');

                return '<div class="sidebar-reel ' + (selectedReelId === r.id ? 'active' : '') + (r.hidden ? ' hidden-reel' : '') + '" onclick="event.stopPropagation(); selectReel(\'' + r.id + '\')" style="' + (r.hidden ? 'opacity:0.4;' : '') + '">' +
                    '<span class="sidebar-reel-title">' + r.id + '</span>' +
                    (r.hook ? '<span class="sidebar-reel-hook">' + r.hook + '</span>' : '') +
                    '<span class="sidebar-reel-dots">' + dots + '</span>' +
                    '<span class="sidebar-reel-actions">' +
                        '<button class="sidebar-reel-btn" onclick="event.stopPropagation(); toggleHideReel(\'' + r.id + '\')" title="' + (r.hidden ? 'Show' : 'Hide') + '">' + (r.hidden ? '👁' : '−') + '</button>' +
                        '<button class="sidebar-reel-btn sidebar-reel-btn-del" onclick="event.stopPropagation(); deleteReel(\'' + r.id + '\')" title="Delete">×</button>' +
                    '</span>' +
                '</div>';
            }).join('');

            epHtml += '<div class="ep-reels-section">' + toolbarHtml + reelsHtml + '</div>';
        }

        return epHtml;
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
    var el = document.getElementById('console-drawer-logs');
    if (!el) return;
    var reelKey = selectedReelId ? (currentSlug + ':' + selectedReelId) : '';
    el.textContent = (reelKey && reelLogs[reelKey]) || logs[currentSlug] || '';
    el.scrollTop = el.scrollHeight;
    // Update title
    var titleEl = document.getElementById('console-drawer-title');
    if (titleEl) {
        titleEl.textContent = selectedReelId ? 'Console — Reel ' + selectedReelId : 'Console';
    }
}

function toggleConsole() {
    var drawer = document.getElementById('console-drawer');
    var btn = document.getElementById('console-toggle-btn');
    if (drawer) {
        drawer.classList.toggle('open');
        if (btn) btn.classList.toggle('active', drawer.classList.contains('open'));
        if (drawer.classList.contains('open')) updateLogs();
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
    ep.isRunning = isSlugRunning(ep.slug);

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
        // Show/hide stop button in pipeline bar
        var pipeStopBtn = document.getElementById('pipeline-stop-btn');
        if (pipeStopBtn) pipeStopBtn.style.display = ep.isRunning ? '' : 'none';
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
        document.getElementById('precut-status').style.display = isReelFull ? 'none' : 'flex';
        document.getElementById('reel-full-layout').style.display = isReelFull ? 'flex' : 'none';

        if (isReelFull) {
            renderReelFullView(ep);
        }
        var pipeStopBtn2 = document.getElementById('pipeline-stop-btn');
        if (pipeStopBtn2) pipeStopBtn2.style.display = ep.isRunning ? '' : 'none';
    }
}

function renderEpisodePipelineBar(ep) {
    const bar = document.getElementById('episode-pipeline-bar');
    const steps = stepsForType(ep.mediaType, ep);
    const stepKeyMap = {transcribe:'transcribed', analyze:'analyzed', generate:'generated', cut:'cut', crop:'cropped', subtitle:'subtitled', overlay:'overlaid', compose:'composed'};
    const isCut = ep.steps.cut && ep.reelStatuses && ep.reelStatuses.length > 0;

    const isReel = ep.mediaType === 'reel_full' || ep.mediaType === 'reel_cut';
    const episodeLevelSteps = ['compose'];
    const stepsToShow = steps.filter(function(s) {
        return s.applicable && (isReel || episodeLevelSteps.includes(s.id));
    });

    bar.style.display = stepsToShow.length > 0 ? '' : 'none';
    var nextFound = false;
    bar.innerHTML = stepsToShow.map(function(s, i) {
        var done = ep.steps[stepKeyMap[s.id] || s.id];
        var isRunning = isStepRunning(ep.slug, s.id);
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

async function showPreviewTab() {
    var el = document.getElementById('tab-preview');
    if (el) el.style.display = '';
    switchTab('preview');
}

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
        videoSrc = '/api/video?slug=' + currentSlug + '&type=raw';
    } else {
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

async function submitFeedback(fieldPath, textareaId, hintId) {
    const fbInput = document.getElementById('fb-' + hintId);
    const textarea = document.getElementById(textareaId);
    const hint = document.getElementById('hint-' + hintId);
    const reviseBtn = fbInput ? fbInput.parentElement.querySelector('.feedback-btn') : null;

    const feedback = fbInput.value.trim();
    if (!feedback) return showToast('Enter feedback first', 'error');

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

    if (ep.reelStatuses && ep.reelStatuses.length > 0) {
        selectReel(ep.reelStatuses[0].id);
    }
}

async function showCutReels() {
    if (selectedReelId) return;
    var ep = episodes.find(function(e) { return e.slug === currentSlug; });
    if (ep && ep.reelStatuses && ep.reelStatuses.length > 0) {
        selectReel(ep.reelStatuses[0].id);
    }
}
