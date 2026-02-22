// Trace detail component: split view with tree/timeline and event detail panel

import { api, formatSessionId, escapeHtml } from '../app.js';
import { renderTraceTree } from './trace-tree.js';
import { renderTraceTimeline } from './trace-timeline.js';
import { timeAgo } from './data-table.js';

/**
 * Render collapsible JSON with syntax highlighting.
 *
 * @param {HTMLElement} container
 * @param {*} data - any JSON-serializable value
 */
export function renderJsonViewer(container, data) {
    if (data == null || data === undefined) {
        container.innerHTML = '<span class="json-null">null</span>';
        return;
    }

    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

    // Track collapsed paths
    const collapsed = new Set();

    function renderValue(value, path, indentLevel) {
        if (value === null) {
            return '<span class="json-null">null</span>';
        }

        if (typeof value === 'string') {
            const escaped = escapeHtml(value);
            // Truncate very long strings for display
            if (escaped.length > 200) {
                return `<span class="json-string">"${escaped.substring(0, 200)}..."</span>`;
            }
            return `<span class="json-string">"${escaped}"</span>`;
        }

        if (typeof value === 'number') {
            return `<span class="json-number">${value}</span>`;
        }

        if (typeof value === 'boolean') {
            return `<span class="json-boolean">${value}</span>`;
        }

        if (Array.isArray(value)) {
            if (value.length === 0) {
                return '<span class="json-bracket">[]</span>';
            }

            const isCollapsed = collapsed.has(path);
            const indent = '  '.repeat(indentLevel);
            const childIndent = '  '.repeat(indentLevel + 1);

            if (isCollapsed) {
                return `<span class="json-toggle" data-path="${escapeHtml(path)}">&#9656;</span><span class="json-bracket">[</span><span class="json-collapsed-indicator">${value.length} items</span><span class="json-bracket">]</span>`;
            }

            let html = `<span class="json-toggle" data-path="${escapeHtml(path)}">&#9662;</span><span class="json-bracket">[</span>\n`;
            for (let i = 0; i < value.length; i++) {
                const childPath = `${path}[${i}]`;
                html += `${childIndent}${renderValue(value[i], childPath, indentLevel + 1)}`;
                if (i < value.length - 1) html += ',';
                html += '\n';
            }
            html += `${indent}<span class="json-bracket">]</span>`;
            return html;
        }

        if (typeof value === 'object') {
            const keys = Object.keys(value);
            if (keys.length === 0) {
                return '<span class="json-bracket">{}</span>';
            }

            const isCollapsed = collapsed.has(path);
            const indent = '  '.repeat(indentLevel);
            const childIndent = '  '.repeat(indentLevel + 1);

            if (isCollapsed) {
                return `<span class="json-toggle" data-path="${escapeHtml(path)}">&#9656;</span><span class="json-bracket">{</span><span class="json-collapsed-indicator">${keys.length} keys</span><span class="json-bracket">}</span>`;
            }

            let html = `<span class="json-toggle" data-path="${escapeHtml(path)}">&#9662;</span><span class="json-bracket">{</span>\n`;
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                const childPath = `${path}.${key}`;
                html += `${childIndent}<span class="json-key">"${escapeHtml(key)}"</span>: ${renderValue(value[key], childPath, indentLevel + 1)}`;
                if (i < keys.length - 1) html += ',';
                html += '\n';
            }
            html += `${indent}<span class="json-bracket">}</span>`;
            return html;
        }

        return escapeHtml(String(value));
    }

    function render() {
        let parsedData = data;
        if (typeof data === 'string') {
            try {
                parsedData = JSON.parse(data);
            } catch {
                // Render as plain string
                container.innerHTML = `<div class="json-viewer"><pre style="white-space:pre-wrap;color:var(--text-primary);">${escapeHtml(data)}</pre></div>`;
                return;
            }
        }

        const rendered = renderValue(parsedData, '$', 0);
        container.innerHTML = `
            <div class="json-viewer">
                <button class="json-copy-btn" id="json-copy">Copy</button>
                <pre style="margin:0;white-space:pre-wrap;word-break:break-word;">${rendered}</pre>
            </div>
        `;

        // Bind toggle clicks
        container.querySelectorAll('.json-toggle').forEach(toggle => {
            toggle.addEventListener('click', () => {
                const path = toggle.getAttribute('data-path');
                if (collapsed.has(path)) {
                    collapsed.delete(path);
                } else {
                    collapsed.add(path);
                }
                render();
            });
        });

        // Copy button
        const copyBtn = container.querySelector('#json-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
                navigator.clipboard.writeText(text).then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
                }).catch(() => {
                    copyBtn.textContent = 'Failed';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
                });
            });
        }
    }

    render();
}

function formatDuration(ms) {
    if (ms == null) return null;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Render event detail in the right panel.
 */
function renderEventDetail(panel, event) {
    if (!event) {
        panel.innerHTML = `
            <div class="detail-panel">
                <div class="detail-content">
                    <div class="empty-state"><p>Select an event to view details</p></div>
                </div>
            </div>
        `;
        return;
    }

    const durationStr = formatDuration(event.duration_ms);
    const levelClass = event.level !== 'DEFAULT' ? `level-${event.level}` : '';

    let headerMeta = `
        <div class="detail-panel-meta">
            <div class="meta-item"><span class="meta-label">Time:</span> ${escapeHtml(event.timestamp)}</div>
    `;
    if (durationStr) {
        headerMeta += `<div class="meta-item"><span class="meta-label">Duration:</span> ${durationStr}</div>`;
    }
    if (event.level && event.level !== 'DEFAULT') {
        headerMeta += `<div class="meta-item"><span class="meta-label">Level:</span> <span class="${levelClass}">${escapeHtml(event.level)}</span></div>`;
    }
    if (event.span_id) {
        headerMeta += `<div class="meta-item"><span class="meta-label">Span:</span> <span class="mono text-sm">${escapeHtml(event.span_id)}</span></div>`;
    }
    headerMeta += '</div>';

    panel.innerHTML = `
        <div class="detail-panel">
            <div class="detail-panel-header">
                <div class="flex items-center gap-2">
                    <span class="badge badge-${escapeHtml(event.event_type)}">${escapeHtml(event.event_type)}</span>
                    <h3>${escapeHtml(event.name || event.event_type)}</h3>
                </div>
                ${headerMeta}
            </div>
            <div class="detail-tabs">
                <button class="detail-tab active" data-tab="input">Input</button>
                <button class="detail-tab" data-tab="output">Output</button>
                <button class="detail-tab" data-tab="metadata">Metadata</button>
            </div>
            <div class="detail-content" id="detail-tab-content"></div>
        </div>
    `;

    // Auto-select the best tab based on available data
    const hasInput = event.input != null && !(typeof event.input === 'object' && Object.keys(event.input).length === 0);
    const hasOutput = event.output != null && !(typeof event.output === 'object' && Object.keys(event.output).length === 0);
    let activeTab = hasInput ? 'input' : hasOutput ? 'output' : 'metadata';

    // Update tab button active state to match
    panel.querySelectorAll('.detail-tab').forEach(t => {
        t.classList.toggle('active', t.getAttribute('data-tab') === activeTab);
    });

    function renderTab() {
        const tabContent = panel.querySelector('#detail-tab-content');
        if (!tabContent) return;

        let data;
        if (activeTab === 'input') data = event.input;
        else if (activeTab === 'output') data = event.output;
        else data = event.metadata;

        if (data == null || (typeof data === 'object' && Object.keys(data).length === 0)) {
            tabContent.innerHTML = '<div class="empty-state"><p>No data</p></div>';
        } else {
            renderJsonViewer(tabContent, data);
        }
    }

    // Tab clicks
    panel.querySelectorAll('.detail-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            panel.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeTab = tab.getAttribute('data-tab');
            renderTab();
        });
    });

    renderTab();
}

/**
 * Render session summary when no event is selected.
 */
function renderSessionSummary(panel, events, sourceApp, sessionId) {
    const totalEvents = events.length;
    const types = {};
    for (const e of events) {
        types[e.event_type] = (types[e.event_type] || 0) + 1;
    }

    let earliest = null;
    let latest = null;
    for (const e of events) {
        const t = new Date(e.timestamp).getTime();
        if (!isNaN(t)) {
            if (earliest === null || t < earliest) earliest = t;
            if (latest === null || t > latest) latest = t;
        }
    }

    const duration = earliest !== null && latest !== null ? latest - earliest : null;
    const displayId = formatSessionId(sourceApp, sessionId);

    let typesHtml = '';
    for (const [type, count] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
        typesHtml += `<div class="flex items-center gap-2 mb-1"><span class="badge badge-${escapeHtml(type)}">${escapeHtml(type)}</span> <span class="text-muted">${count}</span></div>`;
    }

    panel.innerHTML = `
        <div class="detail-panel">
            <div class="detail-panel-header">
                <h3>Session Summary</h3>
                <div class="detail-panel-meta">
                    <div class="meta-item"><span class="meta-label">Session:</span> <span class="mono">${escapeHtml(displayId)}</span></div>
                    <div class="meta-item"><span class="meta-label">Events:</span> ${totalEvents}</div>
                    ${duration !== null ? `<div class="meta-item"><span class="meta-label">Duration:</span> ${formatDuration(duration)}</div>` : ''}
                </div>
            </div>
            <div class="detail-content">
                <h4 class="mb-2 text-sm" style="color:var(--text-secondary);font-weight:600;">Events by Type</h4>
                ${typesHtml}
                <p class="text-muted mt-4 text-sm">Click an event in the tree or timeline to view details.</p>
            </div>
        </div>
    `;
}

/**
 * Main trace detail view: split layout with tree/timeline on left, detail on right.
 *
 * @param {HTMLElement} container
 * @param {string} projectId
 * @param {string} sessionId
 */
export async function renderTraceDetail(container, projectId, sessionId) {
    // Fetch events for this session
    const events = await api(`/sessions/${encodeURIComponent(sessionId)}/events`);

    // Try to get session info
    let session = null;
    try {
        session = await api(`/sessions/${encodeURIComponent(sessionId)}`);
    } catch {
        // Session endpoint may not exist separately
    }

    const sourceApp = session?.source_app || '';
    const displayId = formatSessionId(sourceApp, sessionId);

    container.innerHTML = `
        <div class="breadcrumb">
            <a href="#/">Dashboard</a>
            <span class="separator">&#9656;</span>
            <a href="#/projects/${encodeURIComponent(projectId)}/traces">Traces</a>
            <span class="separator">&#9656;</span>
            <span class="mono">${escapeHtml(displayId)}</span>
        </div>
        <div class="page-header">
            <h2>Trace Detail</h2>
            <p class="subtitle mono">${escapeHtml(displayId)}${session?.model ? ' &middot; ' + escapeHtml(session.model) : ''}</p>
        </div>
        <div class="flex items-center gap-2 mb-4">
            <div class="toggle-group">
                <button class="toggle-btn active" data-view="tree">Tree</button>
                <button class="toggle-btn" data-view="timeline">Timeline</button>
            </div>
        </div>
        <div class="split-view">
            <div class="split-left" id="trace-left-panel"></div>
            <div class="split-right" id="trace-right-panel"></div>
        </div>
    `;

    const leftPanel = container.querySelector('#trace-left-panel');
    const rightPanel = container.querySelector('#trace-right-panel');
    let activeView = 'tree';
    let treeController = null;
    let timelineController = null;

    function onSelectEvent(event) {
        renderEventDetail(rightPanel, event);
    }

    function renderLeftPanel() {
        if (activeView === 'tree') {
            treeController = renderTraceTree(leftPanel, events, onSelectEvent);
        } else {
            timelineController = renderTraceTimeline(leftPanel, events, onSelectEvent);
        }
    }

    // Show session summary initially
    renderSessionSummary(rightPanel, events, sourceApp, sessionId);

    // Render initial view
    renderLeftPanel();

    // Toggle buttons
    container.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeView = btn.getAttribute('data-view');
            renderLeftPanel();
        });
    });
}
