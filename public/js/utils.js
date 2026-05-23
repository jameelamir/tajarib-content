// ── Utility Functions ─────────────────────────────────────────────────────────

function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shareLink(slug, reelId) {
    if (!slug) { showToast('Nothing to share', 'error'); return; }
    var url = window.location.origin + '/?slug=' + encodeURIComponent(slug);
    if (reelId) url += '&reel=' + encodeURIComponent(reelId);
    var msg = reelId ? ('Reel ' + reelId + ' link copied') : 'Episode link copied';
    copyToClipboard(url, msg);
}

function copyToClipboard(text, message) {
    var msg = message || 'Copied!';
    function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        showToast(ok ? msg : 'Copy failed — select & copy manually', ok ? 'success' : 'error');
    }
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(function() { showToast(msg, 'success'); })
            .catch(fallback);
    } else {
        fallback();
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
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
