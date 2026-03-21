// ── Storage Management ──────────────────────────────────────────────────────

async function loadStorageInfo() {
    try {
        const res = await fetch('/api/storage');
        storageData = await res.json();
        updateStorageSidebar();
    } catch (e) {
        console.error('Storage load error:', e);
    }
}

function updateStorageSidebar() {
    if (!storageData) return;
    var d = storageData;
    document.getElementById('storage-used-label').textContent = d.usedGB + ' GB used';
    document.getElementById('storage-quota-label').textContent = '/ ' + d.quotaGB + ' GB';
    document.getElementById('storage-percent-label').textContent = d.percentUsed + '%';
    document.getElementById('storage-quota-input').value = d.quotaGB;

    var fill = document.getElementById('storage-bar-fill');
    fill.style.width = Math.min(d.percentUsed, 100) + '%';

    // Color thresholds
    fill.classList.remove('storage-bar-warning', 'storage-bar-danger');
    var dot = document.getElementById('storage-status-dot');
    if (d.percentUsed >= 90) {
        fill.classList.add('storage-bar-danger');
        dot.style.background = 'var(--error)';
    } else if (d.percentUsed >= 75) {
        fill.classList.add('storage-bar-warning');
        dot.style.background = 'var(--warning)';
    } else {
        fill.style.background = '';
        dot.style.background = 'var(--success)';
    }
}

async function saveStorageQuota() {
    var input = document.getElementById('storage-quota-input');
    var quotaGB = parseInt(input.value);
    if (!quotaGB || quotaGB < 1) { showToast('Invalid quota', 'error'); return; }
    try {
        var res = await fetch('/api/storage-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quotaGB: quotaGB })
        });
        if (res.ok) await loadStorageInfo();
    } catch (e) {
        showToast('Failed to save quota', 'error');
    }
}

async function openStorageBrowser() {
    await loadStorageInfo();
    renderStorageBrowser();
    document.getElementById('storage-modal').classList.add('open');
}

function closeStorageBrowser() {
    document.getElementById('storage-modal').classList.remove('open');
}

function sortStorageBy(key) {
    storageSortBy = key;
    ['size','date','name'].forEach(function(k) {
        var btn = document.getElementById('sort-' + k + '-btn');
        if (btn) btn.className = k === key ? 'primary' : '';
    });
    renderStorageBrowser();
}

function renderStorageBrowser() {
    if (!storageData) return;
    var d = storageData;

    document.getElementById('storage-modal-summary').textContent =
        d.usedGB + ' GB used of ' + d.quotaGB + ' GB (' + d.percentUsed + '%) — ' +
        d.episodes.length + ' project' + (d.episodes.length !== 1 ? 's' : '');

    var eps = d.episodes.slice();
    if (storageSortBy === 'size') eps.sort(function(a, b) { return b.totalBytes - a.totalBytes; });
    else if (storageSortBy === 'date') eps.sort(function(a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    else eps.sort(function(a, b) { return a.slug.localeCompare(b.slug); });

    var list = document.getElementById('storage-browser-list');
    list.innerHTML = eps.map(function(ep) {
        var chips = Object.entries(ep.breakdown)
            .filter(function(e) { return e[1] > 0; })
            .map(function(e) { return '<span class="storage-breakdown-chip ' + e[0] + '">' + e[0] + ': ' + formatBytes(e[1]) + '</span>'; })
            .join('');

        var files = ep.files.slice().sort(function(a, b) { return b.size - a.size; });
        var fileRows = files.map(function(f) {
            return '<div class="storage-file-row">' +
                '<span class="storage-file-name" title="' + f.path + '">' + f.path + '</span>' +
                '<span class="storage-file-size">' + formatBytes(f.size) + '</span>' +
                '<button class="storage-file-del" onclick="deleteStorageFile(\'' + ep.slug + '\',\'' + f.path.replace(/'/g, "\\'") + '\',' + f.size + ')">del</button>' +
            '</div>';
        }).join('');

        return '<div class="storage-ep-card" id="storage-card-' + ep.slug + '">' +
            '<div class="storage-ep-header" onclick="toggleStorageCard(\'' + ep.slug + '\')">' +
                '<div style="min-width:0; flex:1;">' +
                    '<div class="storage-ep-title">' + ep.slug + (ep.guest ? ' &middot; ' + ep.guest : '') + '</div>' +
                    '<div class="storage-breakdown">' + chips + '</div>' +
                '</div>' +
                '<div style="text-align:right; flex-shrink:0; margin-left:12px;">' +
                    '<div class="storage-ep-size">' + formatBytes(ep.totalBytes) + '</div>' +
                    '<button class="danger" style="font-size:0.55rem; padding:2px 6px; margin-top:4px;" onclick="event.stopPropagation(); deleteStorageEpisode(\'' + ep.slug + '\')">Delete All</button>' +
                '</div>' +
            '</div>' +
            '<div class="storage-file-list">' + fileRows + '</div>' +
        '</div>';
    }).join('');
}

function toggleStorageCard(slug) {
    var card = document.getElementById('storage-card-' + slug);
    if (card) card.classList.toggle('expanded');
}

async function deleteStorageFile(slug, filePath, size) {
    if (!confirm('Delete ' + filePath + ' from ' + slug + '? (' + formatBytes(size) + ')')) return;
    try {
        var res = await fetch('/api/delete-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: slug, files: [filePath] })
        });
        var result = await res.json();
        if (result.success) {
            await loadStorageInfo();
            renderStorageBrowser();
        } else {
            showToast(result.error || 'Delete failed', 'error');
        }
    } catch (e) {
        showToast('Delete failed', 'error');
    }
}

async function deleteStorageEpisode(slug) {
    if (!confirm('Delete entire project "' + slug + '" and all its files?')) return;
    try {
        var res = await fetch('/api/episodes?slug=' + encodeURIComponent(slug), { method: 'DELETE' });
        var result = await res.json();
        if (result.success) {
            await loadStorageInfo();
            renderStorageBrowser();
            await refresh();
        } else {
            showToast(result.error || 'Delete failed', 'error');
        }
    } catch (e) {
        showToast('Delete failed', 'error');
    }
}
