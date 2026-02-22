// Session view component: chronological list of event cards for a session

import { api, formatSessionId, escapeHtml } from '../app.js';
import { renderJsonViewer } from './trace-detail.js';
import { timeAgo } from './data-table.js';

function formatDuration(ms) {
    if (ms == null) return null;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Render the session view page.
 *
 * @param {HTMLElement} container
 * @param {string} projectId
 * @param {string} sessionId
 */
export async function renderSessionView(container, projectId, sessionId) {
    // Fetch session and events
    let session = null;
    try {
        session = await api(`/sessions/${encodeURIComponent(sessionId)}`);
    } catch {
        // fallback
    }

    const events = await api(`/sessions/${encodeURIComponent(sessionId)}/events`);
    const sourceApp = session?.source_app || '';
    const displayId = formatSessionId(sourceApp, sessionId);

    // Match PreToolUse/PostToolUse span pairs for duration display
    const spanDurations = new Map();
    for (const evt of events) {
        if (evt.duration_ms != null && evt.span_id) {
            spanDurations.set(evt.span_id, evt.duration_ms);
        }
    }

    // Track expanded cards
    const expandedCards = new Set();

    function render() {
        let headerHtml = `
            <div class="breadcrumb">
                <a href="#/">Dashboard</a>
                <span class="separator">&#9656;</span>
                <a href="#/projects/${encodeURIComponent(projectId)}/sessions">Sessions</a>
                <span class="separator">&#9656;</span>
                <span class="mono">${escapeHtml(displayId)}</span>
            </div>
            <div class="page-header">
                <h2>Session View</h2>
                <div class="flex items-center gap-3 mt-2">
                    <span class="mono text-sm">${escapeHtml(displayId)}</span>
                    ${session?.model ? `<span class="text-muted">&middot;</span> <span class="text-sm">${escapeHtml(session.model)}</span>` : ''}
                    ${session?.started_at ? `<span class="text-muted">&middot;</span> <span class="text-sm text-muted">${timeAgo(session.started_at)}</span>` : ''}
                </div>
            </div>
            <div class="mb-4">
                <a href="#/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(sessionId)}" class="btn btn-sm">View Trace Detail &rarr;</a>
            </div>
        `;

        let eventsHtml = '';

        if (events.length === 0) {
            eventsHtml = '<div class="empty-state"><h3>No Events</h3><p>No events recorded for this session.</p></div>';
        } else {
            // Get the first event timestamp for relative times
            const firstTime = new Date(events[0].timestamp).getTime();

            for (const evt of events) {
                const isExpanded = expandedCards.has(evt.id);
                const expandedClass = isExpanded ? 'expanded' : '';
                const evtTime = new Date(evt.timestamp).getTime();
                const relativeMs = evtTime - firstTime;
                const relativeStr = relativeMs === 0 ? '0ms' : `+${formatDuration(relativeMs)}`;

                const durationStr = formatDuration(evt.duration_ms);
                const spanDuration = evt.span_id ? spanDurations.get(evt.span_id) : null;
                const spanDurationStr = spanDuration != null && evt.duration_ms == null ? formatDuration(spanDuration) : null;

                let durationDisplay = '';
                if (durationStr) {
                    durationDisplay = `<span class="session-event-duration">${durationStr}</span>`;
                } else if (spanDurationStr) {
                    durationDisplay = `<span class="session-event-duration">${spanDurationStr}</span>`;
                }

                eventsHtml += `
                    <div class="session-event-card ${expandedClass}" data-event-id="${escapeHtml(evt.id)}">
                        <div class="session-event-header">
                            <span class="session-event-time">${escapeHtml(relativeStr)}</span>
                            <span class="badge badge-${escapeHtml(evt.event_type)}">${escapeHtml(evt.event_type)}</span>
                            <span class="session-event-name">${escapeHtml(evt.name || evt.event_type)}</span>
                            ${durationDisplay}
                        </div>
                        ${isExpanded ? `<div class="session-event-body" id="event-body-${escapeHtml(evt.id)}"></div>` : ''}
                    </div>
                `;
            }
        }

        container.innerHTML = headerHtml + eventsHtml;

        // Render JSON for expanded cards
        for (const evtId of expandedCards) {
            const bodyEl = container.querySelector(`#event-body-${evtId}`);
            const evt = events.find(e => e.id === evtId);
            if (bodyEl && evt) {
                const tabData = {};
                if (evt.input != null) tabData.input = evt.input;
                if (evt.output != null) tabData.output = evt.output;
                if (evt.metadata != null) tabData.metadata = evt.metadata;

                const tabKeys = Object.keys(tabData);
                if (tabKeys.length === 0) {
                    bodyEl.innerHTML = '<div class="text-muted text-sm">No input/output/metadata</div>';
                } else {
                    let tabsHtml = '<div class="detail-tabs">';
                    for (let i = 0; i < tabKeys.length; i++) {
                        tabsHtml += `<button class="detail-tab ${i === 0 ? 'active' : ''}" data-evt-tab="${tabKeys[i]}" data-evt-id="${evtId}">${tabKeys[i].charAt(0).toUpperCase() + tabKeys[i].slice(1)}</button>`;
                    }
                    tabsHtml += '</div>';
                    tabsHtml += `<div class="mt-2" id="evt-tab-content-${evtId}"></div>`;
                    bodyEl.innerHTML = tabsHtml;

                    // Render first tab content
                    const firstTabContent = bodyEl.querySelector(`#evt-tab-content-${evtId}`);
                    if (firstTabContent) {
                        renderJsonViewer(firstTabContent, tabData[tabKeys[0]]);
                    }

                    // Bind tab clicks for this card
                    bodyEl.querySelectorAll('.detail-tab').forEach(tab => {
                        tab.addEventListener('click', (e) => {
                            e.stopPropagation();
                            bodyEl.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
                            tab.classList.add('active');
                            const tabKey = tab.getAttribute('data-evt-tab');
                            const contentEl = bodyEl.querySelector(`#evt-tab-content-${evtId}`);
                            if (contentEl) {
                                renderJsonViewer(contentEl, tabData[tabKey]);
                            }
                        });
                    });
                }
            }
        }

        // Bind card clicks to toggle expansion
        container.querySelectorAll('.session-event-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Don't toggle if clicking inside the body (tabs, json toggles, etc.)
                if (e.target.closest('.session-event-body')) return;

                const evtId = card.getAttribute('data-event-id');
                if (expandedCards.has(evtId)) {
                    expandedCards.delete(evtId);
                } else {
                    expandedCards.add(evtId);
                }
                render();
            });
        });
    }

    render();
}
