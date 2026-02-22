// Main application module
import { renderDashboard } from './components/dashboard.js';
import { renderTraceDetail } from './components/trace-detail.js';
import { renderSessionView } from './components/session-view.js';
import { renderDataTable } from './components/data-table.js';

// API helper
const API_BASE = '';  // Same origin

export async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}/api${path}`, options);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// Format session ID for display: source_app:session_id[:8]
export function formatSessionId(sourceApp, sessionId) {
    if (!sourceApp && !sessionId) return 'unknown';
    const truncated = sessionId ? sessionId.substring(0, 8) : '??';
    return sourceApp ? `${sourceApp}:${truncated}` : truncated;
}

// WebSocket for live updates
let ws = null;
let wsListeners = [];

export function onEvent(callback) {
    wsListeners.push(callback);
    return () => { wsListeners = wsListeners.filter(l => l !== callback); };
}

function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws/stream`);
    ws.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            wsListeners.forEach(cb => cb(data));
        } catch { /* ignore parse errors */ }
    };
    ws.onclose = () => setTimeout(connectWebSocket, 3000);
    ws.onerror = () => ws.close();
}

// Render projects list page
async function renderProjectsList(container) {
    const projects = await api('/projects');

    container.innerHTML = `
        <div class="page-header">
            <h2>Projects</h2>
            <p class="subtitle">All observed projects</p>
        </div>
        <div id="projects-table"></div>
    `;

    const tableContainer = container.querySelector('#projects-table');
    renderDataTable(tableContainer, {
        columns: [
            { key: 'name', label: 'Name' },
            { key: 'session_count', label: 'Sessions', render: (val) => `${val || 0}` },
            { key: 'created_at', label: 'Created' },
        ],
        data: projects,
        onRowClick: (row) => {
            location.hash = `#/projects/${encodeURIComponent(row.id)}/traces`;
        },
    });
}

// Render traces list for a project (live-updating)
async function renderTracesList(container, projectId) {
    container.innerHTML = `
        <div class="breadcrumb">
            <a href="#/">Dashboard</a>
            <span class="separator">&#9656;</span>
            <a href="#/projects">Projects</a>
            <span class="separator">&#9656;</span>
            <span>Traces</span>
        </div>
        <div class="page-header">
            <h2>Traces</h2>
            <p class="subtitle">Project: ${escapeHtml(projectId)}</p>
        </div>
        <div class="live-indicator"><span class="live-dot"></span> Live</div>
        <div id="traces-table"></div>
    `;

    const tableContainer = container.querySelector('#traces-table');

    async function refreshTable() {
        const sessions = await api(`/sessions?project_id=${encodeURIComponent(projectId)}`);
        renderDataTable(tableContainer, {
            columns: [
                {
                    key: 'id',
                    label: 'Session',
                    render: (val, row) => {
                        const display = formatSessionId(row.source_app, val);
                        return `<span class="mono">${escapeHtml(display)}</span>`;
                    },
                },
                { key: 'source_app', label: 'Source App' },
                { key: 'event_count', label: 'Events', render: (val) => `${val || 0}` },
                { key: 'started_at', label: 'Started' },
                { key: 'model', label: 'Model', render: (val) => val || '-' },
            ],
            data: sessions,
            onRowClick: (row) => {
                location.hash = `#/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(row.id)}`;
            },
        });
    }

    await refreshTable();

    // Live update: debounce WebSocket events to refresh every 2 seconds max
    let refreshTimer = null;
    const unsubscribe = onEvent(() => {
        if (!refreshTimer) {
            refreshTimer = setTimeout(async () => {
                refreshTimer = null;
                if (location.hash.includes('/traces') && !location.hash.match(/\/traces\/[^/]+$/)) {
                    await refreshTable();
                }
            }, 2000);
        }
    });

    // Store cleanup so it can be called on navigation (via route change)
    container._cleanup = () => { unsubscribe(); clearTimeout(refreshTimer); };
}

// Render sessions list for a project
async function renderSessionsList(container, projectId) {
    const sessions = await api(`/sessions?project_id=${encodeURIComponent(projectId)}`);

    container.innerHTML = `
        <div class="breadcrumb">
            <a href="#/">Dashboard</a>
            <span class="separator">&#9656;</span>
            <a href="#/projects">Projects</a>
            <span class="separator">&#9656;</span>
            <span>Sessions</span>
        </div>
        <div class="page-header">
            <h2>Sessions</h2>
            <p class="subtitle">Project: ${escapeHtml(projectId)}</p>
        </div>
        <div id="sessions-table"></div>
    `;

    const tableContainer = container.querySelector('#sessions-table');
    renderDataTable(tableContainer, {
        columns: [
            {
                key: 'id',
                label: 'Session',
                render: (val, row) => {
                    const display = formatSessionId(row.source_app, val);
                    return `<span class="mono">${escapeHtml(display)}</span>`;
                },
            },
            { key: 'source_app', label: 'Source App' },
            { key: 'event_count', label: 'Events', render: (val) => `${val || 0}` },
            { key: 'started_at', label: 'Started' },
            { key: 'model', label: 'Model', render: (val) => val || '-' },
        ],
        data: sessions,
        onRowClick: (row) => {
            location.hash = `#/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(row.id)}`;
        },
    });
}

// Update sidebar navigation
async function updateSidebar() {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return;

    let projects = [];
    try {
        projects = await api('/projects');
    } catch {
        // API might not be ready yet
    }

    const currentHash = location.hash || '#/';

    let html = `
        <div class="nav-section">
            <a class="nav-link ${currentHash === '#/' || currentHash === '' ? 'active' : ''}" href="#/">
                <span class="nav-icon">&#9632;</span> Dashboard
            </a>
            <a class="nav-link ${currentHash === '#/projects' ? 'active' : ''}" href="#/projects">
                <span class="nav-icon">&#9830;</span> Projects
            </a>
        </div>
    `;

    if (projects.length > 0) {
        html += `<div class="nav-section"><div class="nav-section-title">Projects</div>`;
        for (const p of projects) {
            const tracesHash = `#/projects/${encodeURIComponent(p.id)}/traces`;
            html += `
                <a class="nav-link nav-link-indent ${currentHash.startsWith(tracesHash) ? 'active' : ''}" href="${tracesHash}">
                    ${escapeHtml(p.name)}
                </a>
            `;
        }
        html += `</div>`;
    }

    nav.innerHTML = html;
}

// HTML escape helper
function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// Make escapeHtml available to other modules
export { escapeHtml };

// Router
async function route() {
    const hash = location.hash || '#/';
    const content = document.getElementById('content');
    // Cleanup previous view's listeners
    if (content._cleanup) { content._cleanup(); content._cleanup = null; }
    content.innerHTML = '<div class="loading">Loading...</div>';

    try {
        if (hash === '#/' || hash === '') {
            await renderDashboard(content);
        } else if (hash === '#/projects') {
            await renderProjectsList(content);
        } else if (hash.match(/^#\/projects\/([^/]+)\/traces\/([^/]+)$/)) {
            const [, projectId, sessionId] = hash.match(/^#\/projects\/([^/]+)\/traces\/([^/]+)$/);
            await renderTraceDetail(content, decodeURIComponent(projectId), decodeURIComponent(sessionId));
        } else if (hash.match(/^#\/projects\/([^/]+)\/traces$/)) {
            const [, projectId] = hash.match(/^#\/projects\/([^/]+)\/traces$/);
            await renderTracesList(content, decodeURIComponent(projectId));
        } else if (hash.match(/^#\/projects\/([^/]+)\/sessions\/([^/]+)$/)) {
            const [, projectId, sessionId] = hash.match(/^#\/projects\/([^/]+)\/sessions\/([^/]+)$/);
            await renderSessionView(content, decodeURIComponent(projectId), decodeURIComponent(sessionId));
        } else if (hash.match(/^#\/projects\/([^/]+)\/sessions$/)) {
            const [, projectId] = hash.match(/^#\/projects\/([^/]+)\/sessions$/);
            await renderSessionsList(content, decodeURIComponent(projectId));
        } else {
            content.innerHTML = '<div class="empty-state"><h3>404 Not Found</h3><p>The page you are looking for does not exist.</p></div>';
        }
    } catch (err) {
        content.innerHTML = `<div class="error-msg">Error: ${escapeHtml(err.message)}</div>`;
    }

    // Update active link in sidebar
    updateSidebar();
}

// Initialize
connectWebSocket();
updateSidebar();
window.addEventListener('hashchange', route);
route();
