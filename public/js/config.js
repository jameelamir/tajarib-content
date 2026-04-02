// ── Configuration: Transcription, LLM, Prompts, Settings, Models ─────────────

// Transcription Config
let transcriptionConfig = { hasApiKey: false, hasGroqKey: false, groqKeyHint: null, defaultMethod: 'local' };

async function loadTranscriptionConfig() {
    try {
        const res = await fetch('/api/transcription-config');
        transcriptionConfig = await res.json();
        updateTranscriptionUI();
    } catch (e) {
        console.error('Failed to load transcription config:', e);
    }
}

function updateTranscriptionUI() {
    const dot = document.getElementById('api-status-dot');
    const text = document.getElementById('api-status-text');
    const method = transcriptionConfig.defaultMethod || 'local';

    if (method === 'groq') {
        if (transcriptionConfig.hasGroqKey) {
            dot.style.background = 'var(--success)';
            text.textContent = 'Groq Ready';
            text.style.color = '#4ade80';
        } else {
            dot.style.background = '#f59e0b';
            text.textContent = 'Groq selected — enter API key below';
            text.style.color = '#fbbf24';
        }
    } else if (method === 'api') {
        if (transcriptionConfig.hasApiKey) {
            dot.style.background = 'var(--success)';
            text.textContent = 'Haimaker Ready';
            text.style.color = '#4ade80';
        } else {
            dot.style.background = '#f59e0b';
            text.textContent = 'Haimaker selected — no API key';
            text.style.color = '#fbbf24';
        }
    } else {
        dot.style.background = 'var(--success)';
        text.textContent = 'Local';
        text.style.color = '#4ade80';
    }
}

function populateTranscriptionFields() {
    const groqKeyEl = document.getElementById('transcription-groq-key');
    if (groqKeyEl) {
        groqKeyEl.value = '';
        if (transcriptionConfig.hasGroqKey) {
            groqKeyEl.placeholder = transcriptionConfig.groqKeyHint
                ? 'Key saved (' + transcriptionConfig.groqKeyHint + ') — enter new to replace'
                : 'Key saved — enter new to replace';
        } else {
            groqKeyEl.placeholder = 'gsk_... (required for Groq transcription)';
        }
    }
    const methodEl = document.getElementById('transcription-default-method');
    if (methodEl) methodEl.value = transcriptionConfig.defaultMethod || 'local';
    const statusEl = document.getElementById('api-key-status');
    if (statusEl) statusEl.style.display = 'none';
    const groqSaved = document.getElementById('groq-key-saved');
    if (groqSaved) groqSaved.style.display = transcriptionConfig.hasGroqKey ? '' : 'none';
}

// Keep these for backwards compat (other code may call them)
function openTranscriptionModal() { populateTranscriptionFields(); }
function closeTranscriptionModal() {}

async function saveTranscriptionConfig() {
    const apiKeyEl = document.getElementById('transcription-api-key');
    const apiKey = apiKeyEl ? apiKeyEl.value.trim() : '';
    const groqKeyEl = document.getElementById('transcription-groq-key');
    const groqApiKey = groqKeyEl ? groqKeyEl.value.trim() : '';
    const defaultMethod = document.getElementById('transcription-default-method').value;
    const statusDiv = document.getElementById('api-key-status');

    // Validate: if Groq selected and no key exists or entered, warn
    if (defaultMethod === 'groq' && !transcriptionConfig.hasGroqKey && !groqApiKey) {
        statusDiv.style.display = 'block';
        statusDiv.style.background = '#7f1d1d';
        statusDiv.style.color = '#fca5a5';
        statusDiv.textContent = '✗ Enter a Groq API key first — get one from console.groq.com';
        return;
    }
    if (defaultMethod === 'api' && !transcriptionConfig.hasApiKey && !apiKey) {
        statusDiv.style.display = 'block';
        statusDiv.style.background = '#7f1d1d';
        statusDiv.style.color = '#fca5a5';
        statusDiv.textContent = '✗ Enter an API key first';
        return;
    }

    const payload = { defaultMethod };
    if (apiKey) payload.apiKey = apiKey;
    if (groqApiKey) payload.groqApiKey = groqApiKey;

    try {
        const res = await fetch('/api/transcription-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
            transcriptionConfig.hasApiKey = data.hasApiKey;
            transcriptionConfig.hasGroqKey = data.hasGroqKey;
            if (data.groqKeyHint) transcriptionConfig.groqKeyHint = data.groqKeyHint;
            transcriptionConfig.defaultMethod = defaultMethod;
            updateTranscriptionUI();
            populateTranscriptionFields();

            // Also update the default in upload modal
            const radio = document.querySelector(`input[name="transcribe-method"][value="${defaultMethod}"]`);
            if (radio) radio.checked = true;

            statusDiv.style.display = 'block';
            statusDiv.style.background = '#064e3b';
            statusDiv.style.color = '#6ee7b7';
            statusDiv.textContent = '✓ Settings saved';

            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 2000);
        }
    } catch (err) {
        statusDiv.style.display = 'block';
        statusDiv.style.background = '#7f1d1d';
        statusDiv.style.color = '#fca5a5';
        statusDiv.textContent = '✗ Failed to save: ' + err.message;
    }
}

// LLM Config (API key + base URL + model)
async function loadGenKeyStatus() {
    try {
        const res = await fetch('/api/llm-config');
        const data = await res.json();
        const dot = document.getElementById('gen-key-dot');
        const status = document.getElementById('gen-key-status');
        const toggle = document.getElementById('manual-mode-toggle');
        // Populate fields with current config (but not the key)
        if (data.baseUrl) document.getElementById('gen-base-url').value = data.baseUrl;
        if (data.model) document.getElementById('sidebar-model-select').value = data.model;
        if (toggle) toggle.checked = !!data.manualMode;
        if (data.manualMode) {
            dot.style.background = '#a78bfa';
            status.innerHTML = '📋 Manual mode — paste prompts into your own Claude';
            status.style.color = '#a78bfa';
        } else if (data.hasKey) {
            dot.style.background = 'var(--success)';
            const provider = data.baseUrl ? new URL(data.baseUrl).hostname : 'Anthropic direct';
            status.innerHTML = '✓ Connected — <span style="color:#888;">' + provider + '</span>';
            status.style.color = '#4ade80';
        } else {
            dot.style.background = '#f59e0b';
            status.textContent = 'No API key — set up a provider to enable generation';
            status.style.color = '#fbbf24';
        }
    } catch (e) {
        console.error('Failed to load LLM config:', e);
    }
}

async function saveLLMConfig() {
    const keyInput = document.getElementById('gen-api-key');
    const baseUrlInput = document.getElementById('gen-base-url');
    const modelInput = document.getElementById('sidebar-model-select');
    const status = document.getElementById('gen-key-status');

    const payload = {};
    const key = keyInput.value.trim();
    const baseUrl = baseUrlInput.value.trim();
    const model = modelInput.value.trim();

    // Only send key if user typed one (don't overwrite existing with empty)
    if (key) payload.apiKey = key;
    if (baseUrl !== undefined) payload.baseUrl = baseUrl;
    if (model !== undefined) payload.model = model;

    if (!key && !baseUrl && !model) {
        status.textContent = '⚠ Nothing to save';
        status.style.color = '#f59e0b';
        return;
    }

    status.textContent = 'Saving...';
    status.style.color = '#888';
    try {
        const res = await fetch('/api/llm-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            keyInput.value = '';
            status.textContent = '✓ LLM settings saved!';
            status.style.color = '#4ade80';
            document.getElementById('gen-key-dot').style.background = 'var(--success)';
            // Refresh to show updated provider info
            setTimeout(loadGenKeyStatus, 500);
        } else {
            throw new Error(data.error || 'Save failed');
        }
    } catch (err) {
        status.textContent = '✗ ' + err.message;
        status.style.color = '#ef4444';
    }
}

async function toggleManualMode(enabled) {
    try {
        const res = await fetch('/api/llm-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ manualMode: enabled })
        });
        const data = await res.json();
        if (data.success) {
            showToast(enabled ? 'Manual mode enabled' : 'Manual mode disabled', 'success');
            loadGenKeyStatus();
        } else {
            throw new Error(data.error || 'Failed');
        }
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
        // Revert toggle
        document.getElementById('manual-mode-toggle').checked = !enabled;
    }
}

// Collapsible sidebar sections
function toggleSection(name) {
    const el = document.getElementById('section-' + name);
    if (!el) return;
    el.classList.toggle('open');
    localStorage.setItem('tajarib-section-' + name, el.classList.contains('open'));
}

// Settings modal
function openSettingsModal() {
    document.getElementById('settings-modal').classList.add('open');
    populateTranscriptionFields();
}
function closeSettingsModal() {
    document.getElementById('settings-modal').classList.remove('open');
}

// Prompts modal
var promptsData = [];          // [{name, content}, ...]
var promptsOriginal = {};      // name -> original content (for revert)
var currentPromptName = null;

var PROMPT_GROUPS = {
    'Generation': ['generate-reels-system', 'generate-reels-user', 'generate-youtube-system', 'generate-youtube-user'],
    'Analysis': ['analyze-system', 'analyze-user', 'reel-suggest-system', 'reel-suggest-user', 'topic-clip-system', 'topic-clip-user'],
    'Formats': ['reel-caption-format', 'youtube-description-format'],
    'Revision': ['revision-system', 'revision-user', 'slug-system', 'slug-user'],
    'Compose': ['compose-system', 'compose-user'],
    'Other': [] // catch-all
};

function categorizePrompt(name) {
    for (var group in PROMPT_GROUPS) {
        if (PROMPT_GROUPS[group].indexOf(name) !== -1) return group;
    }
    return 'Other';
}

async function openPromptsModal() {
    document.getElementById('prompts-modal').classList.add('open');
    document.getElementById('prompts-save-status').textContent = 'Loading...';
    try {
        var res = await fetch('/api/prompts');
        promptsData = await res.json();
        promptsOriginal = {};
        promptsData.forEach(function(p) { promptsOriginal[p.name] = p.content; });
        renderPromptsSidebar();
        // Auto-select first generation prompt
        if (!currentPromptName && promptsData.length) {
            selectPrompt(promptsData.find(function(p) { return p.name === 'generate-reels-system'; }) ? 'generate-reels-system' : promptsData[0].name);
        } else if (currentPromptName) {
            selectPrompt(currentPromptName);
        }
        document.getElementById('prompts-save-status').textContent = '';
    } catch (err) {
        document.getElementById('prompts-save-status').textContent = 'Failed to load prompts';
        document.getElementById('prompts-save-status').style.color = 'var(--error)';
    }
}

function closePromptsModal() {
    document.getElementById('prompts-modal').classList.remove('open');
}

function renderPromptsSidebar() {
    var sidebar = document.getElementById('prompts-sidebar');
    var grouped = {};
    // Initialize groups
    for (var g in PROMPT_GROUPS) grouped[g] = [];
    promptsData.forEach(function(p) {
        var group = categorizePrompt(p.name);
        grouped[group].push(p.name);
    });
    var html = '';
    var groupOrder = ['Generation', 'Analysis', 'Formats', 'Revision', 'Compose', 'Other'];
    groupOrder.forEach(function(group) {
        var items = grouped[group];
        if (!items || !items.length) return;
        html += '<div class="prompts-group-label">' + group + '</div>';
        items.forEach(function(name) {
            var label = name.replace(/^(generate|analyze|compose|revision|reel|slug|topic-clip|youtube)-?/, function(m) { return ''; }) || name;
            // Clean up label
            label = name.split('-').slice(-2).join(' ');
            var active = name === currentPromptName ? ' active' : '';
            html += '<div class="prompts-item' + active + '" data-prompt="' + name + '" onclick="selectPrompt(\'' + name + '\')">' + name + '</div>';
        });
    });
    sidebar.innerHTML = html;
}

function selectPrompt(name) {
    currentPromptName = name;
    var prompt = promptsData.find(function(p) { return p.name === name; });
    if (!prompt) return;
    var textarea = document.getElementById('prompts-textarea');
    textarea.value = prompt.content;
    textarea.disabled = false;
    document.getElementById('prompts-editor-name').textContent = name + '.md';
    // Show template variables
    var vars = (prompt.content.match(/\{\{(\w+)\}\}/g) || []);
    var unique = vars.filter(function(v, i, a) { return a.indexOf(v) === i; });
    var varsEl = document.getElementById('prompts-vars');
    if (unique.length) {
        varsEl.innerHTML = 'Variables: ' + unique.map(function(v) { return '<code>' + v + '</code>'; }).join(' ');
        varsEl.style.display = '';
    } else {
        varsEl.style.display = 'none';
    }
    document.getElementById('prompts-save-status').textContent = '';
    // Update sidebar active state
    document.querySelectorAll('.prompts-item').forEach(function(el) {
        el.classList.toggle('active', el.dataset.prompt === name);
    });
}

async function saveCurrentPrompt() {
    if (!currentPromptName) return;
    var textarea = document.getElementById('prompts-textarea');
    var status = document.getElementById('prompts-save-status');
    status.textContent = 'Saving...';
    status.style.color = '#888';
    try {
        var res = await fetch('/api/prompts/' + encodeURIComponent(currentPromptName), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ content: textarea.value })
        });
        var data = await res.json();
        if (data.success) {
            status.textContent = 'Saved';
            status.style.color = 'var(--success)';
            // Update local cache
            var p = promptsData.find(function(p) { return p.name === currentPromptName; });
            if (p) p.content = textarea.value;
            promptsOriginal[currentPromptName] = textarea.value;
        } else {
            status.textContent = data.error || 'Save failed';
            status.style.color = 'var(--error)';
        }
    } catch (err) {
        status.textContent = 'Network error';
        status.style.color = 'var(--error)';
    }
}

function revertPrompt() {
    if (!currentPromptName) return;
    var original = promptsOriginal[currentPromptName];
    if (original !== undefined) {
        document.getElementById('prompts-textarea').value = original;
        var p = promptsData.find(function(p) { return p.name === currentPromptName; });
        if (p) p.content = original;
        document.getElementById('prompts-save-status').textContent = 'Reverted';
        document.getElementById('prompts-save-status').style.color = '#888';
    }
}

// Sync header status dots with the settings modal dots
function syncSettingsDots() {
    var pairs = [
        ['buffer-status-dot', 'settings-dot-publishing'],
        ['api-status-dot', 'settings-dot-transcription'],
        ['gen-key-dot', 'settings-dot-generation'],
        ['storage-status-dot', 'settings-dot-storage']
    ];
    pairs.forEach(function(p) {
        var src = document.getElementById(p[0]);
        var dst = document.getElementById(p[1]);
        if (src && dst) dst.style.background = src.style.background;
    });
}

// Model Management

// Known model aliases for validation
const KNOWN_MODEL_ALIASES = {
    // Auto
    'auto': 'Claude Sonnet 4.5 (default)',
    '': 'Claude Sonnet 4.5 (default)',
    // Claude models
    'claude': 'Claude (Latest)',
    'claude-sonnet-4-5-20241022': 'Claude Sonnet 4.5',
    'claude-sonnet': 'Claude Sonnet',
    'claude-opus': 'Claude Opus',
    'claude-haiku': 'Claude Haiku',
    'anthropic/claude-sonnet-4-20250514': 'Claude Sonnet 4 (2025-05)',
    // OpenAI models
    'openai': 'OpenAI (Latest)',
    'gpt-4': 'GPT-4',
    'gpt-4o': 'GPT-4o',
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4-turbo': 'GPT-4 Turbo',
    // Gemini models
    'gemini': 'Gemini (Latest)',
    'gemini-pro': 'Gemini Pro',
    'gemini-1.5-pro': 'Gemini 1.5 Pro',
    'gemini-1.5-flash': 'Gemini 1.5 Flash',
    // HAI Maker specific
    'haimaker/auto': 'HAI Maker Auto',
    'haimaker/claude-sonnet': 'HAI Maker Claude Sonnet',
    'haimaker/gpt-4o': 'HAI Maker GPT-4o',
    // OpenRouter models (common ones)
    'openrouter/auto': 'OpenRouter Auto',
    'openrouter/anthropic/claude-3.5-sonnet': 'OpenRouter Claude 3.5 Sonnet',
    'openrouter/openai/gpt-4o': 'OpenRouter GPT-4o',
};

function debouncedValidateSidebarModel(input) {
    const value = input.value.trim();
    const validationDiv = document.getElementById('sidebar-model-validation');
    if (!validationDiv) return;

    if (modelValidationTimer) clearTimeout(modelValidationTimer);

    if (!value) {
        validationDiv.textContent = 'Claude Sonnet 4.5 (default)';
        validationDiv.style.color = '#666';
        return;
    }

    validationDiv.textContent = 'Checking...';
    validationDiv.style.color = '#888';

    modelValidationTimer = setTimeout(() => {
        validateModelWithApi(value, validationDiv);
    }, 500);
}

async function validateModelWithApi(value, validationDiv) {
    const normalizedValue = value.toLowerCase();

    // Check known aliases first (instant)
    if (KNOWN_MODEL_ALIASES[normalizedValue]) {
        validationDiv.textContent = '✓ ' + KNOWN_MODEL_ALIASES[normalizedValue];
        validationDiv.style.color = '#4ade80';
        return;
    }

    // Try to validate against Haimaker API
    try {
        const res = await fetch('/api/validate-model?model=' + encodeURIComponent(value));
        const data = await res.json();

        if (data.valid) {
            validationDiv.textContent = '✓ ' + (data.displayName || value);
            validationDiv.style.color = '#4ade80';
            // Save valid custom models
            if (!KNOWN_MODEL_ALIASES[normalizedValue]) {
                saveCustomModel(value);
            }
        } else {
            validationDiv.textContent = '⚠ ' + (data.error || 'Unknown model - will try anyway');
            validationDiv.style.color = '#f59e0b';
        }
    } catch (e) {
        // Offline/fallback - accept anything that looks like a model identifier
        const validPattern = /^[a-z0-9]+([\/:._-][a-z0-9-]+)*$/i;
        if (validPattern.test(value)) {
            validationDiv.textContent = '✓ Custom: ' + value + ' (offline validation)';
            validationDiv.style.color = '#60a5fa';
        } else {
            validationDiv.textContent = '⚠ Invalid format';
            validationDiv.style.color = '#f87171';
        }
    }
}

function saveCustomModel(modelId) {
    const customModels = JSON.parse(localStorage.getItem('customModels') || '[]');
    if (!customModels.find(m => m.id === modelId)) {
        customModels.push({ id: modelId, name: modelId, added: new Date().toISOString() });
        localStorage.setItem('customModels', JSON.stringify(customModels));
        modelListLoaded = false; // Refresh list next time
    }
}
