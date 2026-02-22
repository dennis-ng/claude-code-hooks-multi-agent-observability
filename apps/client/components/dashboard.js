// Dashboard component: stats, event type chart, recent sessions

import { api, onEvent, formatSessionId, escapeHtml } from '../app.js';
import { timeAgo } from './data-table.js';

// Event type colors for bar chart fills
const EVENT_TYPE_ORDER = [
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'UserPromptSubmit',
    'SessionStart',
    'SessionEnd',
    'Notification',
    'PermissionRequest',
    'SubagentStart',
    'SubagentStop',
    'Stop',
    'PreCompact',
];

/**
 * Render the dashboard page.
 *
 * @param {HTMLElement} container
 */
export async function renderDashboard(container) {
    let stats = await api('/stats');
    let unsubscribe = null;

    function render() {
        const {
            total_events = 0,
            total_sessions = 0,
            total_projects = 0,
            events_today = 0,
            events_by_type = {},
            recent_sessions = [],
        } = stats;

        // Stats grid
        let html = `
            <div class="page-header">
                <h2>Dashboard</h2>
                <p class="subtitle">System overview</p>
            </div>
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-value">${total_events.toLocaleString()}</div>
                    <div class="stat-label">Total Events</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${total_sessions.toLocaleString()}</div>
                    <div class="stat-label">Total Sessions</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${total_projects.toLocaleString()}</div>
                    <div class="stat-label">Total Projects</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${events_today.toLocaleString()}</div>
                    <div class="stat-label">Events Today</div>
                </div>
            </div>
        `;

        // Events by type bar chart
        const typeEntries = Object.entries(events_by_type);
        // Sort by the predefined order, then alphabetically for unknown types
        typeEntries.sort((a, b) => {
            const idxA = EVENT_TYPE_ORDER.indexOf(a[0]);
            const idxB = EVENT_TYPE_ORDER.indexOf(b[0]);
            const orderA = idxA >= 0 ? idxA : EVENT_TYPE_ORDER.length;
            const orderB = idxB >= 0 ? idxB : EVENT_TYPE_ORDER.length;
            if (orderA !== orderB) return orderA - orderB;
            return a[0].localeCompare(b[0]);
        });

        const maxCount = typeEntries.length > 0 ? Math.max(...typeEntries.map(e => e[1])) : 1;

        html += `
            <div class="card mb-6">
                <div class="card-header">
                    <span class="card-title">Events by Type</span>
                </div>
                <div class="bar-chart">
        `;

        if (typeEntries.length === 0) {
            html += '<div class="text-muted text-sm" style="padding:12px;">No events recorded yet.</div>';
        } else {
            for (const [type, count] of typeEntries) {
                const widthPct = Math.max((count / maxCount) * 100, 1);
                html += `
                    <div class="bar-row">
                        <div class="bar-label">
                            <span class="badge badge-${escapeHtml(type)}">${escapeHtml(type)}</span>
                        </div>
                        <div class="bar-track">
                            <div class="bar-fill bar-fill-${escapeHtml(type)}" style="width:${widthPct}%"></div>
                        </div>
                        <div class="bar-count">${count.toLocaleString()}</div>
                    </div>
                `;
            }
        }

        html += `</div></div>`;

        // Recent sessions table
        html += `
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Recent Sessions</span>
                </div>
        `;

        if (recent_sessions.length === 0) {
            html += '<div class="text-muted text-sm" style="padding:12px;">No sessions recorded yet.</div>';
        } else {
            html += `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Session</th>
                            <th>Source App</th>
                            <th>Events</th>
                            <th>Started</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            for (const sess of recent_sessions) {
                const displayId = formatSessionId(sess.source_app, sess.id);
                const traceUrl = `#/projects/${encodeURIComponent(sess.project_id)}/traces/${encodeURIComponent(sess.id)}`;
                html += `
                    <tr class="clickable" data-href="${traceUrl}">
                        <td><span class="mono">${escapeHtml(displayId)}</span></td>
                        <td>${escapeHtml(sess.source_app || '-')}</td>
                        <td>${sess.event_count || 0}</td>
                        <td><span title="${escapeHtml(sess.started_at)}">${timeAgo(sess.started_at)}</span></td>
                    </tr>
                `;
            }

            html += `</tbody></table>`;
        }

        html += `</div>`;

        container.innerHTML = html;

        // Bind row clicks for recent sessions table
        container.querySelectorAll('.data-table tbody tr.clickable').forEach(tr => {
            tr.addEventListener('click', () => {
                const href = tr.getAttribute('data-href');
                if (href) location.hash = href;
            });
        });
    }

    render();

    // Auto-refresh on WebSocket events (debounced)
    let refreshTimer = null;
    unsubscribe = onEvent(() => {
        if (refreshTimer) return;
        refreshTimer = setTimeout(async () => {
            refreshTimer = null;
            try {
                stats = await api('/stats');
                // Only re-render if we're still on the dashboard
                if (location.hash === '#/' || location.hash === '' || location.hash === '#') {
                    render();
                }
            } catch {
                // Ignore refresh errors
            }
        }, 5000);
    });

    // Clean up WebSocket listener when navigating away
    // We check periodically if we're still on the dashboard
    const cleanupInterval = setInterval(() => {
        const hash = location.hash || '#/';
        if (hash !== '#/' && hash !== '' && hash !== '#') {
            if (unsubscribe) unsubscribe();
            if (refreshTimer) clearTimeout(refreshTimer);
            clearInterval(cleanupInterval);
        }
    }, 1000);
}
