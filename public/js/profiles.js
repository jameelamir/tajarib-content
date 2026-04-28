// ── Profiles: view-filter only, no auth ─────────────────────────────────────
// Activates when server has profiles.json. Otherwise behaves identically to before.

window.PROFILES = { enabled: false, list: [], current: null, scope: 'all' };

(function patchFetchForProfiles() {
    var origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
        if (!window.PROFILES.enabled || !window.PROFILES.current) return origFetch(input, init);
        init = init || {};
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (typeof url === 'string' && url.indexOf('/api/') !== -1) {
            var headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {});
            headers.set('x-profile', window.PROFILES.current);
            headers.set('x-scope', window.PROFILES.scope);
            init.headers = headers;
        }
        return origFetch(input, init);
    };
})();

async function setupProfiles() {
    try {
        var res = await fetch('/api/profiles');
        var data = await res.json();
        window.PROFILES.enabled = !!data.enabled;
        window.PROFILES.list = data.profiles || [];
    } catch (_) {
        window.PROFILES.enabled = false;
    }
    if (!window.PROFILES.enabled) return;

    var saved = localStorage.getItem('tajarib-profile');
    if (saved && window.PROFILES.list.indexOf(saved) !== -1) {
        window.PROFILES.current = saved;
    } else {
        window.PROFILES.current = await pickProfile();
    }
    var savedScope = localStorage.getItem('tajarib-scope') || 'mine';
    window.PROFILES.scope = savedScope;
    renderProfileBar();
}

function pickProfile() {
    return new Promise(function(resolve) {
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:9999; display:flex; align-items:center; justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#181818; border:1px solid #333; border-radius:12px; padding:28px; min-width:280px;';
        box.innerHTML = '<div style="font-size:0.85rem; color:#aaa; margin-bottom:14px;">Who are you?</div>';
        window.PROFILES.list.forEach(function(p) {
            var btn = document.createElement('button');
            btn.textContent = p;
            btn.style.cssText = 'display:block; width:100%; margin-bottom:8px; padding:10px 14px; background:#222; border:1px solid #444; color:#eee; border-radius:6px; font-size:0.85rem; cursor:pointer; text-transform:capitalize;';
            btn.onmouseenter = function() { btn.style.borderColor = '#7c3aed'; };
            btn.onmouseleave = function() { btn.style.borderColor = '#444'; };
            btn.onclick = function() {
                localStorage.setItem('tajarib-profile', p);
                document.body.removeChild(modal);
                resolve(p);
            };
            box.appendChild(btn);
        });
        modal.appendChild(box);
        document.body.appendChild(modal);
    });
}

function renderProfileBar() {
    var bar = document.getElementById('profile-bar');
    if (!bar) return;
    bar.style.display = 'flex';
    var scopes = [
        { id: 'mine', label: 'Mine' },
        { id: 'theirs', label: 'Theirs' },
        { id: 'all', label: 'All' }
    ];
    bar.innerHTML =
        '<div style="font-size:0.65rem; color:#777; padding:0 4px; text-transform:capitalize;">' + window.PROFILES.current + '</div>' +
        scopes.map(function(s) {
            var active = window.PROFILES.scope === s.id;
            return '<button onclick="setScope(\'' + s.id + '\')" style="padding:3px 8px; font-size:0.65rem; background:' + (active ? '#1a1028' : '#111') + '; border:1px solid ' + (active ? '#7c3aed' : '#333') + '; color:' + (active ? '#a855f7' : '#888') + '; border-radius:4px; cursor:pointer;">' + s.label + '</button>';
        }).join('') +
        '<button onclick="switchProfile()" title="Switch profile" style="margin-left:auto; padding:3px 8px; font-size:0.65rem; background:#111; border:1px solid #333; color:#666; border-radius:4px; cursor:pointer;">⇄</button>';
}

function setScope(scope) {
    window.PROFILES.scope = scope;
    localStorage.setItem('tajarib-scope', scope);
    renderProfileBar();
    if (typeof refresh === 'function') refresh();
}

function switchProfile() {
    localStorage.removeItem('tajarib-profile');
    location.reload();
}
