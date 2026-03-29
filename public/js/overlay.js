// ── Overlay Config Panel ─────────────────────────────────────────────────

var overlayImageCache = {};
var overlayVideoCache = {}; // MOV overlays loaded as <video> elements for live playback
var overlayPreviewVideo = null; // hidden video element for pre-overlay background
var overlayLiveCanvas = null; // canvas positioned over the video player for live preview
var overlayLiveCtx = null;
var overlayAnimFrameId = null; // requestAnimationFrame ID for live rendering

// Find the active overlay config section and preview element (episode reel vs standalone)
function getOverlaySection() {
    if (selectedReelId) return document.getElementById('overlay-config-section');
    return document.getElementById('rf-overlay-config') || document.getElementById('overlay-config-section');
}
function getOverlayPreviewEl() {
    if (selectedReelId) return document.getElementById('reel-preview');
    return document.getElementById('rf-preview') || document.getElementById('reel-preview');
}

async function toggleOverlayConfig() {
    const section = getOverlaySection();
    if (!section) return;
    if (section.style.display !== 'none' && section.innerHTML) {
        section.style.display = 'none';
        section.innerHTML = '';
        // Clean up hidden preview video
        if (overlayPreviewVideo) { overlayPreviewVideo.pause(); overlayPreviewVideo.src = ''; overlayPreviewVideo = null; }
        // Clean up live overlay
        cleanupLiveOverlay();
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
            sponsor: { enabled: true, x: 1.3, y: 1.2, scale: 180, startTime: 0, freezeAt: 1, freezeDuration: 0 },
            logo: { enabled: true, x: 92.3, y: 1.2, scale: 140 },
            lowerThird: { enabled: false, startTime: 2, endTime: 8 },
            cta: { enabled: false, mode: 'text', text: 'www.tajarib.show', fontSize: 28, fontColor: '#ffffff', imagePath: '', x: 50, y: 85, scale: 200, startTime: 50, endTime: 58 }
        };
    }
    // Load pre-overlay video for accurate canvas background
    if (currentSlug) {
        overlayPreviewVideo = document.createElement('video');
        overlayPreviewVideo.crossOrigin = 'anonymous';
        overlayPreviewVideo.preload = 'auto';
        overlayPreviewVideo.muted = true;
        overlayPreviewVideo.addEventListener('loadeddata', function() {
            // Auto-detect aspect ratio from actual video dimensions
            if (overlayPreviewVideo.videoWidth > overlayPreviewVideo.videoHeight) overlayCanvasRatio = '16:9';
            else if (overlayPreviewVideo.videoWidth === overlayPreviewVideo.videoHeight) overlayCanvasRatio = '1:1';
            else overlayCanvasRatio = '9:16';
            renderOverlayConfig();
        });
        if (selectedReelId) {
            overlayPreviewVideo.src = '/api/video?slug=' + encodeURIComponent(currentSlug) + '&reel=' + encodeURIComponent(selectedReelId) + '&stage=pre-overlay&t=' + Date.now();
        } else {
            overlayPreviewVideo.src = '/api/video?slug=' + encodeURIComponent(currentSlug) + '&type=subtitled&t=' + Date.now();
        }
    }
    renderOverlayConfig();
    // Init live overlay on top of the video player
    setTimeout(function() { initLiveOverlay(); }, 100);
}

function fmtTime(s) {
    s = +s;
    var m = Math.floor(s / 60);
    var sec = s - m * 60;
    return m + ':' + (sec < 10 ? '0' : '') + (sec % 1 === 0 ? sec.toFixed(0) : sec.toFixed(1));
}

function renderOverlayConfig() {
    const section = getOverlaySection();
    const c = overlayConfig;
    // Compute canvas dimensions from actual video when available
    var canvasW, canvasH;
    if (overlayPreviewVideo && overlayPreviewVideo.videoWidth > 0) {
        var vw = overlayPreviewVideo.videoWidth, vh = overlayPreviewVideo.videoHeight;
        var maxDim = 420;
        if (vw >= vh) { canvasW = maxDim; canvasH = Math.round(maxDim * vh / vw); }
        else { canvasH = Math.min(520, Math.round(maxDim * vh / vw)); canvasW = Math.round(canvasH * vw / vh); }
    } else {
        canvasW = overlayCanvasRatio === '9:16' ? 270 : overlayCanvasRatio === '1:1' ? 300 : 640;
        canvasH = overlayCanvasRatio === '9:16' ? 480 : overlayCanvasRatio === '1:1' ? 300 : 360;
    }
    var reelMaxDur = 90;
    if (overlayPreviewVideo && overlayPreviewVideo.duration && isFinite(overlayPreviewVideo.duration)) {
        reelMaxDur = Math.ceil(overlayPreviewVideo.duration);
    }
    section.innerHTML =
        '<div class="overlay-config">' +
            '<h3>Overlay Configuration</h3>' +
            '<div style="display:flex; gap:16px; flex-wrap:wrap;">' +
                // Canvas
                '<div style="flex:1; min-width:200px; max-width:' + (canvasW + 20) + 'px;">' +
                    '<div style="display:flex; gap:4px; margin-bottom:6px;">' +
                        '<button class="' + (overlayCanvasRatio === '16:9' ? 'primary' : '') + '" onclick="overlayCanvasRatio=\'16:9\'; renderOverlayConfig();" style="font-size:0.65rem; padding:3px 8px;">16:9</button>' +
                        '<button class="' + (overlayCanvasRatio === '9:16' ? 'primary' : '') + '" onclick="overlayCanvasRatio=\'9:16\'; renderOverlayConfig();" style="font-size:0.65rem; padding:3px 8px;">9:16</button>' +
                        '<button class="' + (overlayCanvasRatio === '1:1' ? 'primary' : '') + '" onclick="overlayCanvasRatio=\'1:1\'; renderOverlayConfig();" style="font-size:0.65rem; padding:3px 8px;">1:1</button>' +
                    '</div>' +
                    '<div class="overlay-canvas-wrap">' +
                        '<canvas id="overlay-canvas" width="' + canvasW + '" height="' + canvasH + '"></canvas>' +
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
                        '<div class="overlay-asset-info" id="ov-sponsor-info"><span style="color:#555;">' + (c.sponsor.file || 'sponsor.mov') + '</span></div>' +
                        '<div class="overlay-el-body">' +
                            '<div class="overlay-row"><label>File</label>' +
                                '<select id="sponsor-asset-picker" onchange="selectSponsorAsset(this.value)" style="font-size:0.65rem; flex:1; background:#222; color:#ccc; border:1px solid #444; border-radius:4px; padding:2px 4px;">' +
                                    '<option value="">' + (c.sponsor.file || 'sponsor.mov') + '</option>' +
                                '</select>' +
                                '<button onclick="document.getElementById(\'sponsor-upload-input\').click()" style="font-size:0.6rem; padding:2px 6px; margin-left:4px; cursor:pointer;" title="Upload new file">+</button>' +
                                '<input type="file" id="sponsor-upload-input" accept=".mov,.mp4" onchange="uploadSponsorAsset(this.files[0]);" style="display:none;">' +
                            '</div>' +
                            '<div class="overlay-row"><label>X</label><input type="range" min="0" max="100" step="0.5" value="' + c.sponsor.x + '" oninput="overlayConfig.sponsor.x=+this.value; this.nextSibling.textContent=this.value+\'%\'; drawOverlayCanvas();"><span>' + c.sponsor.x + '%</span></div>' +
                            '<div class="overlay-row"><label>Y</label><input type="range" min="0" max="100" step="0.5" value="' + c.sponsor.y + '" oninput="overlayConfig.sponsor.y=+this.value; this.nextSibling.textContent=this.value+\'%\'; drawOverlayCanvas();"><span>' + c.sponsor.y + '%</span></div>' +
                            '<div class="overlay-row"><label>Scale</label><input type="range" min="80" max="300" value="' + c.sponsor.scale + '" oninput="overlayConfig.sponsor.scale=+this.value; this.nextSibling.textContent=this.value+\'px\'; drawOverlayCanvas();"><span>' + c.sponsor.scale + 'px</span></div>' +
                            '<div class="overlay-row"><label>Start</label><input type="range" min="0" max="' + reelMaxDur + '" step="0.5" value="' + (c.sponsor.startTime || 0) + '" oninput="overlayConfig.sponsor.startTime=+this.value; this.nextSibling.textContent=fmtTime(this.value); drawOverlayCanvas();"><span>' + fmtTime(c.sponsor.startTime || 0) + '</span></div>' +
                            '<div class="overlay-row"><label>Freeze At</label><input type="range" min="0" max="5" step="0.1" value="' + (c.sponsor.freezeAt || 1) + '" oninput="overlayConfig.sponsor.freezeAt=+this.value; this.nextSibling.textContent=this.value+\'s\'; drawOverlayCanvas();"><span>' + (c.sponsor.freezeAt || 1) + 's</span></div>' +
                            '<div class="overlay-row"><label>Freeze Hold</label><input type="range" min="0" max="30" step="0.5" value="' + (c.sponsor.freezeDuration || 0) + '" oninput="overlayConfig.sponsor.freezeDuration=+this.value; this.nextSibling.textContent=this.value+\'s\'; drawOverlayCanvas();"><span>' + (c.sponsor.freezeDuration || 0) + 's</span></div>' +
                        '</div>' +
                    '</div>' +
                    // Logo
                    '<div class="overlay-el">' +
                        '<div class="overlay-el-header">' +
                            '<label>Logo</label>' +
                            '<input type="checkbox" id="ov-logo-on" ' + (c.logo.enabled ? 'checked' : '') + ' onchange="overlayConfig.logo.enabled=this.checked; drawOverlayCanvas();">' +
                        '</div>' +
                        '<div class="overlay-asset-info" id="ov-logo-info"><span style="color:#555;">logo.mov/png</span></div>' +
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
    // Populate the sponsor file picker
    populateSponsorAssetPicker();
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

    // Preload overlay MOV files as video elements
    loadOverlayVideo(overlayConfig.sponsor.file || 'sponsor.mov');
    loadOverlayVideo('logo.mov');
    loadOverlayVideo('logo.mp4');
    if (overlayConfig.lowerThird && overlayConfig.lowerThird.customFile) {
        loadOverlayVideo(overlayConfig.lowerThird.customFile);
    }

    // Redraw canvas when pre-overlay video loads so we get the real frame as background
    var bgVideo = overlayPreviewVideo || (getOverlayPreviewEl() && getOverlayPreviewEl().querySelector('video'));
    if (bgVideo) {
        var onReady = function() { drawOverlayCanvas(); };
        bgVideo.addEventListener('loadeddata', onReady, { once: true });
        bgVideo.addEventListener('seeked', onReady, { once: true });
        // If video is already loaded, schedule a redraw
        if (bgVideo.readyState >= 2) setTimeout(drawOverlayCanvas, 50);
        // Continuously redraw when video is playing (for synced overlay video frames)
        bgVideo.addEventListener('timeupdate', function() { drawOverlayCanvas(); });
    }

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

function loadOverlayImage(name) {
    if (overlayImageCache[name]) return overlayImageCache[name];
    var img = new Image();
    img._failed = false;
    img.onload = function() { drawOverlayCanvas(); updateOverlayAssetInfo(); };
    img.onerror = function() { img._failed = true; updateOverlayAssetInfo(); };
    img.src = '/api/assets/file/' + encodeURIComponent(name);
    overlayImageCache[name] = img;
    return img;
}

// Update asset info elements with native .mov dimensions once thumbnails load
function updateOverlayAssetInfo() {
    var sponsorInfo = document.getElementById('ov-sponsor-info');
    if (sponsorInfo) {
        var sponsorFile = (overlayConfig.sponsor && overlayConfig.sponsor.file) || 'sponsor.mov';
        var img = overlayImageCache[sponsorFile];
        if (img && img.naturalWidth && !img._failed) {
            sponsorInfo.innerHTML = '<span style="color:var(--success);">&#10003; ' + sponsorFile + '</span> <span style="color:#888;">' + img.naturalWidth + '×' + img.naturalHeight + ' native</span>';
        } else if (img && img._failed) {
            sponsorInfo.innerHTML = '<span style="color:#f87171;">&#10007; ' + sponsorFile + ' not found</span>';
        }
    }
    var logoInfo = document.getElementById('ov-logo-info');
    if (logoInfo) {
        var found = null;
        var exts = ['.png', '.jpg', '.mov', '.mp4'];
        for (var i = 0; i < exts.length; i++) {
            var img = overlayImageCache['logo' + exts[i]];
            if (img && img.naturalWidth && !img._failed) { found = { name: 'logo' + exts[i], img: img }; break; }
        }
        if (found) {
            logoInfo.innerHTML = '<span style="color:var(--success);">&#10003; ' + found.name + '</span> <span style="color:#888;">' + found.img.naturalWidth + '×' + found.img.naturalHeight + ' native</span>';
        } else {
            var anyFailed = exts.some(function(ext) { var im = overlayImageCache['logo' + ext]; return im && im._failed; });
            if (anyFailed) logoInfo.innerHTML = '<span style="color:#f87171;">&#10007; no logo file found</span>';
        }
    }
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

// Reference video dimensions — use actual video dimensions when available for pixel-accurate positioning
function getRefVideoDims() {
    if (overlayPreviewVideo && overlayPreviewVideo.videoWidth > 0) {
        return { w: overlayPreviewVideo.videoWidth, h: overlayPreviewVideo.videoHeight };
    }
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
        var sponsorFile = c.sponsor.file || 'sponsor.mov';
        var img = loadOverlayImage(sponsorFile);
        var vid = overlayVideoCache[sponsorFile];
        // Use video dimensions for accurate aspect ratio, fall back to thumbnail
        var aspect = (vid && vid._ready && vid.videoWidth) ? vid.videoHeight / vid.videoWidth :
                     (img.naturalWidth && img.naturalHeight) ? img.naturalHeight / img.naturalWidth : 0.6;
        var w = scalePx * sx;
        var h = w * aspect;
        // FFmpeg-matching: Math.round((percent / 100) * videoDim) then scale to canvas
        var x = Math.round((c.sponsor.x / 100) * ref.w) * sx;
        var y = Math.round((c.sponsor.y / 100) * ref.h) * sy;
        els.push({ key: 'sponsor', label: 'Sponsor', x: x, y: y, w: w, h: h, color: 'rgba(59,130,246,0.6)', img: img, vid: vid });
    }
    if (c.logo.enabled) {
        var scalePx = (c.logo.scale || 140);
        var logoImg = loadOverlayImageMulti('logo', ['.png', '.jpg', '.mov', '.mp4']);
        var logoVid = overlayVideoCache['logo.mov'] || overlayVideoCache['logo.mp4'];
        var aspect = (logoVid && logoVid._ready && logoVid.videoWidth) ? logoVid.videoHeight / logoVid.videoWidth :
                     (logoImg.naturalWidth && logoImg.naturalHeight) ? logoImg.naturalHeight / logoImg.naturalWidth : 1;
        var w = scalePx * sx;
        var h = w * aspect;
        var x = Math.round((c.logo.x / 100) * ref.w) * sx;
        var y = Math.round((c.logo.y / 100) * ref.h) * sy;
        var margin = 10 * sx;
        // Clamp to prevent right-edge cutoff (matches FFmpeg overlay.js logic)
        x = Math.min(x, W - w - margin);
        els.push({ key: 'logo', label: 'Logo', x: x, y: y, w: w, h: h, color: 'rgba(168,85,247,0.6)', img: logoImg, vid: logoVid });
    }
    if (c.lowerThird.enabled) {
        if (c.lowerThird.mode === 'custom' && c.lowerThird.customFile) {
            var ltScale = (c.lowerThird.scale || 300);
            var ltImg = loadOverlayImage(c.lowerThird.customFile);
            var ltVid = overlayVideoCache[c.lowerThird.customFile];
            var aspect = (ltVid && ltVid._ready && ltVid.videoWidth) ? ltVid.videoHeight / ltVid.videoWidth :
                         (ltImg.naturalWidth && ltImg.naturalHeight) ? ltImg.naturalHeight / ltImg.naturalWidth : 0.35;
            var w = ltScale * sx;
            var h = w * aspect;
            var x = Math.round(((c.lowerThird.x || 5) / 100) * ref.w) * sx;
            var y = Math.round(((c.lowerThird.y || 80) / 100) * ref.h) * sy;
            els.push({ key: 'lowerThird', label: 'Lower Third', x: x, y: y, w: w, h: h, color: 'rgba(168,85,247,0.7)', img: ltImg, vid: ltVid });
        } else {
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
            var x = Math.round((c.cta.x / 100) * ref.w) * sx;
            var y = Math.round((c.cta.y / 100) * ref.h) * sy;
            els.push({ key: 'cta', label: 'CTA', x: x, y: y, w: w, h: Math.max(25 * sy, h), color: 'rgba(34,197,94,0.6)' });
        } else {
            var scalePx = (c.cta.scale || 200);
            var ctaImg = loadOverlayImageMulti('cta', ['.png', '.mov', '.mp4', '.gif']);
            var aspect = (ctaImg.naturalWidth && ctaImg.naturalHeight) ? ctaImg.naturalHeight / ctaImg.naturalWidth : 0.5;
            var w = scalePx * sx;
            var h = w * aspect;
            var x = Math.round((c.cta.x / 100) * ref.w) * sx;
            var y = Math.round((c.cta.y / 100) * ref.h) * sy;
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

    // Background: use pre-overlay video (no baked-in overlays), fall back to reel video, then grid
    var bgVideo = overlayPreviewVideo || (getOverlayPreviewEl() && getOverlayPreviewEl().querySelector('video'));
    var drewVideo = false;
    if (bgVideo && bgVideo.readyState >= 2 && bgVideo.videoWidth > 0) {
        try {
            ctx.drawImage(bgVideo, 0, 0, W, H);
            // Slight dim so overlay elements remain visible on top
            ctx.fillStyle = 'rgba(0,0,0,0.1)';
            ctx.fillRect(0, 0, W, H);
            drewVideo = true;
        } catch (_) {}
    }
    if (!drewVideo) {
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = '#2a2a2a';
        ctx.lineWidth = 1;
        for (var x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
        for (var y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    }

    // Shadow overlay preview (real shadow gradient from bottom)
    var shadowImg = loadOverlayImage('shadow-reels.png');
    if (shadowImg.naturalWidth) {
        ctx.drawImage(shadowImg, 0, 0, W, H);
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

    // Sync overlay video elements to the background video's current time
    var bgVideoForSync = overlayPreviewVideo || (getOverlayPreviewEl() && getOverlayPreviewEl().querySelector('video'));
    if (bgVideoForSync && bgVideoForSync.readyState >= 2) {
        var t = bgVideoForSync.currentTime;
        Object.keys(overlayVideoCache).forEach(function(k) {
            var v = overlayVideoCache[k];
            if (v && v._ready && v.readyState >= 2 && Math.abs(v.currentTime - t) > 0.2) {
                v.currentTime = Math.min(t, v.duration || t);
            }
        });
    }

    // Draw elements — use video frames for MOV overlays, images for PNGs, fallback to colored rectangles
    var ref = getRefVideoDims();
    var sx = W / ref.w;
    var els = getOverlayElements();
    els.forEach(function(el) {
        // Prefer video frame for MOV overlays (animated preview)
        var hasVideo = el.vid && el.vid._ready && el.vid.readyState >= 2;
        var hasImage = el.img && el.img.naturalWidth && el.img.complete;
        if (hasVideo) {
            try { ctx.drawImage(el.vid, el.x, el.y, el.w, el.h); } catch(_) {}
        } else if (hasImage) {
            ctx.drawImage(el.img, el.x, el.y, el.w, el.h);
        } else if (el.key === 'lowerThird' && el.fixed) {
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
        ctx.strokeStyle = (hasImage || hasVideo) ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.6)';
        ctx.lineWidth = overlayDragging && overlayDragging.key === el.key ? 2 : 1;
        ctx.strokeRect(el.x, el.y, el.w, el.h);
        // Label (top-left corner, subtle)
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '9px sans-serif';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 3;
        // Show label with pixel coordinates (FFmpeg-accurate)
        var pxX = Math.round((overlayConfig[el.key] ? overlayConfig[el.key].x : 0) / 100 * ref.w);
        var pxY = Math.round((overlayConfig[el.key] ? overlayConfig[el.key].y : 0) / 100 * ref.h);
        var coordLabel = el.label + ' [' + pxX + ',' + pxY + 'px]';
        ctx.fillText(coordLabel, el.x + 2, el.y - 2);
        ctx.shadowBlur = 0;
    });
}

// Populate the lower-third asset picker dropdown with files from assets/ and shared dir
async function populateSponsorAssetPicker() {
    var picker = document.getElementById('sponsor-asset-picker');
    if (!picker) return;
    try {
        var res = await fetch('/api/assets/browse?type=video');
        var data = await res.json();
        var currentFile = (overlayConfig.sponsor && overlayConfig.sponsor.file) || 'sponsor.mov';
        picker.innerHTML = '<option value="">-- Select file --</option>';
        (data.files || []).forEach(function(f) {
            var opt = document.createElement('option');
            opt.value = f.source === 'shared' ? ('shared:' + f.path) : f.name;
            var label = f.name + ' (' + f.sizeMb + ' MB' + (f.source === 'shared' ? ', shared' : '') + ')';
            opt.textContent = label;
            if (f.name === currentFile) opt.selected = true;
            picker.appendChild(opt);
        });
    } catch (e) {
        console.warn('Failed to load sponsor assets:', e);
    }
}

async function selectSponsorAsset(value) {
    if (!value) return;
    var fileName;
    if (value.startsWith('shared:')) {
        var sourcePath = value.substring(7);
        fileName = sourcePath.split('/').pop();
        // Link shared file into local assets so video preview and FFmpeg can find it
        try {
            await fetch('/api/link-asset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourcePath: sourcePath, assetName: fileName })
            });
        } catch (e) {
            console.warn('Failed to link shared asset:', e);
        }
    } else {
        fileName = value;
    }
    overlayConfig.sponsor.file = fileName;
    // Clear cached video/image so fresh ones load for the new file
    delete overlayVideoCache[fileName];
    delete overlayImageCache[fileName];
    loadOverlayVideo(fileName);
    renderOverlayConfig();
}

async function uploadSponsorAsset(file) {
    if (!file) return;
    var fd = new FormData();
    fd.append('type', 'sponsor');
    fd.append('file', file);
    try {
        var res = await fetch('/api/upload-asset', { method: 'POST', body: fd });
        var data = await res.json();
        if (data.success) {
            overlayConfig.sponsor.file = data.file;
            delete overlayVideoCache[data.file];
            delete overlayImageCache[data.file];
            loadOverlayVideo(data.file);
            renderOverlayConfig();
        }
    } catch (e) {
        alert('Upload failed: ' + e.message);
    }
}

async function populateLTAssetPicker() {
    var picker = document.getElementById('lt-asset-picker');
    if (!picker) return;
    try {
        var res = await fetch('/api/assets/browse?type=video');
        var data = await res.json();
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
        // Shared files are accessible directly — just reference by original name
        var sourcePath = value.substring(7);
        var fileName = sourcePath.split('/').pop();
        overlayConfig.lowerThird.customFile = fileName;
        renderOverlayConfig();
    } else {
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

// ── Live Overlay Preview (composites overlays on the video player) ───────

// Load a MOV/video overlay as a <video> element for animated live preview
function loadOverlayVideo(name) {
    if (overlayVideoCache[name]) return overlayVideoCache[name];
    var ext = name.substring(name.lastIndexOf('.')).toLowerCase();
    if (!['.mov', '.mp4', '.avi'].includes(ext)) return null; // not a video overlay
    var video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.loop = false;
    video._ready = false;
    video._failed = false;
    video.addEventListener('loadeddata', function() {
        video._ready = true;
        drawOverlayCanvas();
        drawLiveOverlay();
    });
    video.addEventListener('error', function() { video._failed = true; });
    video.src = '/api/assets/video/' + encodeURIComponent(name);
    overlayVideoCache[name] = video;
    return video;
}

// Create the live overlay canvas positioned over the video player
function initLiveOverlay() {
    var previewEl = getOverlayPreviewEl();
    var vid = previewEl ? previewEl.querySelector('video') : null;
    if (!vid) return;

    // Pre-load MOV overlay videos
    loadOverlayVideo((overlayConfig.sponsor && overlayConfig.sponsor.file) || 'sponsor.mov');
    var logoExts = ['.mov', '.mp4'];
    for (var i = 0; i < logoExts.length; i++) {
        loadOverlayVideo('logo' + logoExts[i]);
    }

    // Create canvas if not already present
    if (!overlayLiveCanvas) {
        overlayLiveCanvas = document.createElement('canvas');
        overlayLiveCanvas.className = 'overlay-live-canvas';
        overlayLiveCanvas.style.cssText = 'position:absolute; top:0; left:0; pointer-events:none; border-radius:8px; z-index:10;';
        previewEl.style.position = 'relative';
        previewEl.appendChild(overlayLiveCanvas);
    }

    var updateSize = function() {
        if (!vid.videoWidth) return;
        // Match canvas internal resolution to video dimensions for pixel accuracy
        overlayLiveCanvas.width = vid.videoWidth;
        overlayLiveCanvas.height = vid.videoHeight;
        // Match display size to the video element's rendered size
        var rect = vid.getBoundingClientRect();
        overlayLiveCanvas.style.width = rect.width + 'px';
        overlayLiveCanvas.style.height = rect.height + 'px';
        overlayLiveCtx = overlayLiveCanvas.getContext('2d');
        drawLiveOverlay();
    };

    vid.addEventListener('loadedmetadata', updateSize);
    vid.addEventListener('resize', updateSize);
    if (vid.videoWidth > 0) updateSize();

    // Also handle window resize to keep the canvas aligned
    window._overlayResizeHandler = function() {
        if (!vid || !overlayLiveCanvas) return;
        var rect = vid.getBoundingClientRect();
        overlayLiveCanvas.style.width = rect.width + 'px';
        overlayLiveCanvas.style.height = rect.height + 'px';
    };
    window.addEventListener('resize', window._overlayResizeHandler);

    // Start animation loop
    startOverlayAnimLoop();
}

function cleanupLiveOverlay() {
    if (overlayAnimFrameId) { cancelAnimationFrame(overlayAnimFrameId); overlayAnimFrameId = null; }
    if (overlayLiveCanvas && overlayLiveCanvas.parentNode) {
        overlayLiveCanvas.parentNode.removeChild(overlayLiveCanvas);
    }
    overlayLiveCanvas = null;
    overlayLiveCtx = null;
    // Pause and cleanup overlay videos
    Object.keys(overlayVideoCache).forEach(function(k) {
        var v = overlayVideoCache[k];
        if (v) { v.pause(); v.src = ''; }
    });
    overlayVideoCache = {};
    if (window._overlayResizeHandler) {
        window.removeEventListener('resize', window._overlayResizeHandler);
        window._overlayResizeHandler = null;
    }
}

function startOverlayAnimLoop() {
    if (overlayAnimFrameId) cancelAnimationFrame(overlayAnimFrameId);
    var animate = function() {
        drawLiveOverlay();
        overlayAnimFrameId = requestAnimationFrame(animate);
    };
    overlayAnimFrameId = requestAnimationFrame(animate);
}

// Draw overlay elements onto the live canvas (transparent background, overlays only)
function drawLiveOverlay() {
    if (!overlayLiveCtx || !overlayLiveCanvas) return;
    var ctx = overlayLiveCtx;
    var W = overlayLiveCanvas.width, H = overlayLiveCanvas.height;
    if (!W || !H) return;

    // Clear to transparent
    ctx.clearRect(0, 0, W, H);

    var c = overlayConfig;
    if (!c) return;

    // Get main video current time for time-based visibility
    var _pe = getOverlayPreviewEl();
    var mainVid = _pe ? _pe.querySelector('video') : null;
    var currentTime = mainVid ? mainVid.currentTime : 0;

    // Draw shadow gradient
    var shadowImg = overlayImageCache['shadow-reels.png'];
    if (!shadowImg) shadowImg = loadOverlayImage('shadow-reels.png');
    if (shadowImg && shadowImg.naturalWidth && !shadowImg._failed) {
        ctx.drawImage(shadowImg, 0, 0, W, H);
    }

    // Logo vignette (when logo is enabled)
    if (c.logo && c.logo.enabled) {
        var vigImg = overlayImageCache['logo-vignette.png'];
        if (!vigImg) vigImg = loadOverlayImage('logo-vignette.png');
        if (vigImg && vigImg.naturalWidth && !vigImg._failed) {
            ctx.drawImage(vigImg, 0, 0, W, H);
        }
    }

    // ── Sponsor overlay ──
    if (c.sponsor && c.sponsor.enabled) {
        var sponsorEnd = 5;
        if (currentTime <= sponsorEnd) {
            var scale = c.sponsor.scale || 180;
            var x = Math.round((c.sponsor.x / 100) * W);
            var y = Math.round((c.sponsor.y / 100) * H);
            var sponsorFileName = (c.sponsor.file || 'sponsor.mov');
            var sponsorVid = overlayVideoCache[sponsorFileName];
            var sponsorImg = overlayImageCache[sponsorFileName];
            if (sponsorVid && sponsorVid._ready && sponsorVid.readyState >= 2) {
                // Sync video time
                if (Math.abs(sponsorVid.currentTime - currentTime) > 0.3) {
                    sponsorVid.currentTime = Math.min(currentTime, sponsorVid.duration || currentTime);
                }
                if (mainVid && !mainVid.paused && sponsorVid.paused) sponsorVid.play().catch(function(){});
                if (mainVid && mainVid.paused && !sponsorVid.paused) sponsorVid.pause();
                // Draw video frame with correct aspect ratio
                var aspect = sponsorVid.videoHeight / sponsorVid.videoWidth;
                var w = scale;
                var h = Math.round(w * aspect);
                // Apply fade out near end
                var fadeOut = 0.5;
                if (currentTime > sponsorEnd - fadeOut) {
                    ctx.globalAlpha = Math.max(0, (sponsorEnd - currentTime) / fadeOut);
                }
                ctx.drawImage(sponsorVid, x, y, w, h);
                ctx.globalAlpha = 1;
            } else if (sponsorImg && sponsorImg.naturalWidth && !sponsorImg._failed) {
                // Fallback to static thumbnail
                var aspect = sponsorImg.naturalHeight / sponsorImg.naturalWidth;
                var w = scale;
                var h = Math.round(w * aspect);
                ctx.drawImage(sponsorImg, x, y, w, h);
            }
        }
    }

    // ── Logo overlay ──
    if (c.logo && c.logo.enabled) {
        var logoScale = c.logo.scale || 140;
        var logoX = Math.round((c.logo.x / 100) * W);
        var logoY = Math.round((c.logo.y / 100) * H);
        var margin = 10;
        // Try video first, then image
        var logoVid = overlayVideoCache['logo.mov'] || overlayVideoCache['logo.mp4'];
        var logoImg = null;
        var logoExts = ['.png', '.jpg', '.mov', '.mp4'];
        for (var li = 0; li < logoExts.length; li++) {
            var candidate = overlayImageCache['logo' + logoExts[li]];
            if (candidate && candidate.naturalWidth && !candidate._failed) { logoImg = candidate; break; }
        }
        if (!logoImg) logoImg = loadOverlayImageMulti('logo', ['.png', '.jpg', '.mov', '.mp4']);

        if (logoVid && logoVid._ready && logoVid.readyState >= 2) {
            var aspect = logoVid.videoHeight / logoVid.videoWidth;
            var w = logoScale;
            var h = Math.round(w * aspect);
            logoX = Math.min(logoX, W - w - margin);
            if (Math.abs(logoVid.currentTime - currentTime) > 0.3) {
                logoVid.currentTime = Math.min(currentTime, logoVid.duration || currentTime);
            }
            if (mainVid && !mainVid.paused && logoVid.paused) logoVid.play().catch(function(){});
            if (mainVid && mainVid.paused && !logoVid.paused) logoVid.pause();
            ctx.drawImage(logoVid, logoX, logoY, w, h);
        } else if (logoImg && logoImg.naturalWidth && !logoImg._failed) {
            var aspect = logoImg.naturalHeight / logoImg.naturalWidth;
            var w = logoScale;
            var h = Math.round(w * aspect);
            logoX = Math.min(logoX, W - w - margin);
            ctx.drawImage(logoImg, logoX, logoY, w, h);
        }
    }

    // ── Lower-third overlay ──
    if (c.lowerThird && c.lowerThird.enabled) {
        var ltStart = c.lowerThird.startTime || 2;
        var ltEnd = c.lowerThird.endTime || 8;
        if (currentTime >= ltStart && currentTime <= ltEnd) {
            if (c.lowerThird.mode === 'custom' && c.lowerThird.customFile) {
                var ltScale = c.lowerThird.scale || 300;
                var ltX = Math.round(((c.lowerThird.x || 5) / 100) * W);
                var ltY = Math.round(((c.lowerThird.y || 80) / 100) * H);
                var ltVid = overlayVideoCache[c.lowerThird.customFile];
                if (!ltVid) ltVid = loadOverlayVideo(c.lowerThird.customFile);
                var ltImg = overlayImageCache[c.lowerThird.customFile];
                if (!ltImg) ltImg = loadOverlayImage(c.lowerThird.customFile);

                if (ltVid && ltVid._ready && ltVid.readyState >= 2) {
                    var ltTime = currentTime - ltStart;
                    if (Math.abs(ltVid.currentTime - ltTime) > 0.3) {
                        ltVid.currentTime = Math.min(ltTime, ltVid.duration || ltTime);
                    }
                    if (mainVid && !mainVid.paused && ltVid.paused) ltVid.play().catch(function(){});
                    if (mainVid && mainVid.paused && !ltVid.paused) ltVid.pause();
                    var aspect = ltVid.videoHeight / ltVid.videoWidth;
                    var w = ltScale;
                    var h = Math.round(w * aspect);
                    ctx.drawImage(ltVid, ltX, ltY, w, h);
                } else if (ltImg && ltImg.naturalWidth && !ltImg._failed) {
                    var aspect = ltImg.naturalHeight / ltImg.naturalWidth;
                    var w = ltScale;
                    var h = Math.round(w * aspect);
                    ctx.drawImage(ltImg, ltX, ltY, w, h);
                }
            } else {
                // Auto lower-third: draw the same box/text as FFmpeg
                var boxY = H - 200;
                var boxW = 520;
                var boxH = 120;
                // Fade in/out
                var fadeIn = 0.4, fadeOut = 0.4;
                var alpha = 1;
                if (currentTime < ltStart + fadeIn) alpha = (currentTime - ltStart) / fadeIn;
                if (currentTime > ltEnd - fadeOut) alpha = (ltEnd - currentTime) / fadeOut;
                ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
                ctx.fillStyle = 'rgba(168, 85, 247, 0.85)';
                ctx.fillRect(0, boxY, boxW, boxH);
                var ep = typeof episodes !== 'undefined' ? episodes.find(function(e) { return e.slug === currentSlug; }) : null;
                if (ep) {
                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 36px sans-serif';
                    // Animate X slide like FFmpeg
                    var nameText = ep.guest || 'Guest Name';
                    var metrics = ctx.measureText(nameText);
                    var tw = metrics.width;
                    var holdStart = ltStart + fadeIn, holdEnd = ltEnd - fadeOut;
                    var nameX;
                    if (currentTime < holdStart) nameX = -tw + (tw + 20) * (currentTime - ltStart) / fadeIn;
                    else if (currentTime > holdEnd) nameX = 20 - (tw + 20) * (currentTime - holdEnd) / fadeOut;
                    else nameX = 20;
                    ctx.fillText(nameText, nameX, H - 190 + 36);
                    ctx.font = '24px sans-serif';
                    ctx.fillStyle = '#cccccc';
                    var roleText = ep.role || 'Role';
                    ctx.fillText(roleText, nameX, H - 145 + 24);
                }
                ctx.globalAlpha = 1;
            }
        }
    }

    // ── CTA overlay ──
    if (c.cta && c.cta.enabled) {
        var ctaStart = c.cta.startTime || 0;
        var ctaEnd = c.cta.endTime || 10;
        if (currentTime >= ctaStart && currentTime <= ctaEnd) {
            var ctaX = Math.round((c.cta.x / 100) * W);
            var ctaY = Math.round((c.cta.y / 100) * H);
            if (c.cta.mode === 'text') {
                var fontSize = c.cta.fontSize || 28;
                ctx.font = fontSize + 'px sans-serif';
                ctx.fillStyle = c.cta.fontColor || '#ffffff';
                ctx.shadowColor = 'rgba(0,0,0,0.6)';
                ctx.shadowBlur = 3;
                ctx.fillText(c.cta.text || '', ctaX, ctaY + fontSize);
                ctx.shadowBlur = 0;
            } else {
                var ctaScale = c.cta.scale || 200;
                var ctaImg = null;
                var ctaExts = ['.png', '.mov', '.mp4', '.gif'];
                for (var ci = 0; ci < ctaExts.length; ci++) {
                    var candidate = overlayImageCache['cta' + ctaExts[ci]];
                    if (candidate && candidate.naturalWidth && !candidate._failed) { ctaImg = candidate; break; }
                }
                if (!ctaImg) ctaImg = loadOverlayImageMulti('cta', ['.png', '.mov', '.mp4', '.gif']);
                if (ctaImg && ctaImg.naturalWidth && !ctaImg._failed) {
                    var aspect = ctaImg.naturalHeight / ctaImg.naturalWidth;
                    var w = ctaScale;
                    var h = Math.round(w * aspect);
                    ctx.drawImage(ctaImg, ctaX, ctaY, w, h);
                }
            }
        }
    }

    // ── Measurement annotations ──
    drawMeasurementAnnotations(ctx, W, H, c, currentTime);
}

// Draw pixel-accurate measurement annotations showing exact positions
function drawMeasurementAnnotations(ctx, W, H, c, currentTime) {
    ctx.save();
    ctx.font = '11px monospace';
    ctx.textBaseline = 'top';

    var items = [];
    if (c.sponsor && c.sponsor.enabled && currentTime <= 5) {
        var x = Math.round((c.sponsor.x / 100) * W);
        var y = Math.round((c.sponsor.y / 100) * H);
        items.push({ label: 'Sponsor', x: x, y: y, scale: c.sponsor.scale || 180 });
    }
    if (c.logo && c.logo.enabled) {
        var scale = c.logo.scale || 140;
        var x = Math.round((c.logo.x / 100) * W);
        var y = Math.round((c.logo.y / 100) * H);
        x = Math.min(x, W - scale - 10);
        items.push({ label: 'Logo', x: x, y: y, scale: scale });
    }
    if (c.lowerThird && c.lowerThird.enabled && c.lowerThird.mode === 'custom' && c.lowerThird.customFile && currentTime >= (c.lowerThird.startTime || 2) && currentTime <= (c.lowerThird.endTime || 8)) {
        var x = Math.round(((c.lowerThird.x || 5) / 100) * W);
        var y = Math.round(((c.lowerThird.y || 80) / 100) * H);
        items.push({ label: 'L3rd', x: x, y: y, scale: c.lowerThird.scale || 300 });
    }
    if (c.cta && c.cta.enabled && currentTime >= (c.cta.startTime || 0) && currentTime <= (c.cta.endTime || 10)) {
        var x = Math.round((c.cta.x / 100) * W);
        var y = Math.round((c.cta.y / 100) * H);
        items.push({ label: 'CTA', x: x, y: y, scale: c.cta.scale || 200 });
    }

    items.forEach(function(item) {
        var text = item.label + ': ' + item.x + ',' + item.y + 'px  w=' + item.scale;
        var tw = ctx.measureText(text).width + 8;
        // Position label above the element
        var lx = item.x;
        var ly = item.y - 16;
        if (ly < 2) ly = item.y + 4;
        if (lx + tw > W) lx = W - tw - 2;

        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(lx, ly, tw, 14);
        ctx.fillStyle = '#00ff88';
        ctx.fillText(text, lx + 4, ly + 1);

        // Crosshair at the anchor point
        ctx.strokeStyle = 'rgba(0,255,136,0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(item.x, 0);
        ctx.lineTo(item.x, H);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, item.y);
        ctx.lineTo(W, item.y);
        ctx.stroke();
        ctx.setLineDash([]);
    });

    ctx.restore();
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
    // Collapse panel and clean up live overlay
    cleanupLiveOverlay();
    var section = getOverlaySection();
    if (section) { section.style.display = 'none'; section.innerHTML = ''; }
}
