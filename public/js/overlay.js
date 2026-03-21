// ── Overlay Config Panel ─────────────────────────────────────────────────

var overlayImageCache = {};

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
        var logoImg = loadOverlayImageMulti('logo', ['.png', '.jpg', '.mov', '.mp4']);
        var aspect = (logoImg.naturalWidth && logoImg.naturalHeight) ? logoImg.naturalHeight / logoImg.naturalWidth : 1;
        var w = scalePx * sx;
        var h = w * aspect;
        var x = (c.logo.x / 100) * W;
        var y = (c.logo.y / 100) * H;
        var margin = 10 * sx;
        x = Math.min(x, W - w - margin);
        els.push({ key: 'logo', label: 'Logo', x: x, y: y, w: w, h: h, color: 'rgba(168,85,247,0.6)', img: logoImg });
    }
    if (c.lowerThird.enabled) {
        if (c.lowerThird.mode === 'custom' && c.lowerThird.customFile) {
            var ltScale = (c.lowerThird.scale || 300);
            var ltImg = loadOverlayImage(c.lowerThird.customFile);
            var aspect = (ltImg.naturalWidth && ltImg.naturalHeight) ? ltImg.naturalHeight / ltImg.naturalWidth : 0.35;
            var w = ltScale * sx;
            var h = w * aspect;
            var x = ((c.lowerThird.x || 5) / 100) * W;
            var y = ((c.lowerThird.y || 80) / 100) * H;
            els.push({ key: 'lowerThird', label: 'Lower Third', x: x, y: y, w: w, h: h, color: 'rgba(168,85,247,0.7)', img: ltImg });
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

    // Draw elements — actual images where available, fallback to colored rectangles
    var ref = getRefVideoDims();
    var sx = W / ref.w;
    var els = getOverlayElements();
    els.forEach(function(el) {
        var hasImage = el.img && el.img.naturalWidth && el.img.complete;
        if (hasImage) {
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
        var sourcePath = value.substring(7);
        var fileName = sourcePath.split('/').pop();
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
