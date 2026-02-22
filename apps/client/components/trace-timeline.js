// Trace timeline component: Gantt chart visualization of events

// Event type colors for timeline bars
const EVENT_COLORS = {
    SessionStart: '#22c55e',
    SessionEnd: '#ef4444',
    PreToolUse: '#3b82f6',
    PostToolUse: '#06b6d4',
    PostToolUseFailure: '#ef4444',
    UserPromptSubmit: '#a855f7',
    Notification: '#eab308',
    PermissionRequest: '#f97316',
    SubagentStart: '#14b8a6',
    SubagentStop: '#6366f1',
    Stop: '#6b7280',
    PreCompact: '#f59e0b',
};

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function formatDurationLabel(ms) {
    if (ms == null || ms === 0) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format a time value for the scale header.
 * Adapts units based on total duration.
 */
function formatScaleTime(ms, totalMs) {
    if (totalMs < 2000) {
        return `${Math.round(ms)}ms`;
    } else if (totalMs < 120000) {
        return `${(ms / 1000).toFixed(1)}s`;
    } else {
        return `${(ms / 60000).toFixed(1)}m`;
    }
}

/**
 * Render a Gantt-chart timeline of events.
 *
 * @param {HTMLElement} container
 * @param {Array} events - flat array of event objects
 * @param {Function} onSelect - callback(event) when a bar is clicked
 */
export function renderTraceTimeline(container, events, onSelect) {
    let selectedId = null;

    function render() {
        if (!events || events.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No events to display</p></div>';
            return;
        }

        // Sort by timestamp
        const sorted = [...events].sort((a, b) => {
            return new Date(a.timestamp) - new Date(b.timestamp);
        });

        // Find trace start and end
        const traceStart = new Date(sorted[0].timestamp).getTime();
        let traceEnd = traceStart;

        for (const evt of sorted) {
            const evtTime = new Date(evt.timestamp).getTime();
            const evtEnd = evtTime + (evt.duration_ms || 0);
            if (evtEnd > traceEnd) traceEnd = evtEnd;
            if (evtTime > traceEnd) traceEnd = evtTime;
        }

        // Ensure minimum duration for display
        const totalDuration = Math.max(traceEnd - traceStart, 1);

        // Build scale markers (5-7 markers)
        const numMarkers = 6;
        const scaleMarkers = [];
        for (let i = 0; i <= numMarkers; i++) {
            const ms = (totalDuration / numMarkers) * i;
            const pct = (i / numMarkers) * 100;
            scaleMarkers.push({ ms, pct });
        }

        // Build HTML
        let html = '<div class="timeline-container">';

        // Scale header
        html += '<div class="timeline-scale">';
        html += '<span style="width:180px;min-width:180px;font-size:11px;color:var(--text-muted);">Event</span>';
        html += '<div style="flex:1;position:relative;height:20px;">';
        for (const marker of scaleMarkers) {
            html += `<span class="timeline-scale-marker" style="left:${marker.pct}%">${formatScaleTime(marker.ms, totalDuration)}</span>`;
        }
        html += '</div>';
        html += '</div>';

        // Timeline body
        html += '<div class="timeline-body">';

        for (const evt of sorted) {
            const evtTime = new Date(evt.timestamp).getTime();
            const leftPct = ((evtTime - traceStart) / totalDuration) * 100;
            const duration = evt.duration_ms || 0;
            const widthPct = Math.max((duration / totalDuration) * 100, 0.5);
            const color = EVENT_COLORS[evt.event_type] || '#6b7280';
            const selectedClass = evt.id === selectedId ? 'selected' : '';
            const label = evt.name || evt.event_type;
            const durationLabel = formatDurationLabel(evt.duration_ms);
            const barLabel = widthPct > 5 ? escapeHtml(label) : '';
            const tooltip = `${escapeHtml(evt.event_type)}: ${escapeHtml(label)}${durationLabel ? ' (' + durationLabel + ')' : ''}`;

            html += `
                <div class="timeline-row ${selectedClass}" data-event-id="${escapeHtml(evt.id)}">
                    <div class="timeline-row-label" title="${escapeHtml(label)}">
                        <span class="badge badge-${escapeHtml(evt.event_type)}" style="margin-right:4px;font-size:10px;">${escapeHtml(evt.event_type)}</span>
                    </div>
                    <div class="timeline-row-track">
                        <div class="timeline-bar timeline-bar-${escapeHtml(evt.event_type)}"
                             style="left:${leftPct}%;width:${widthPct}%;background:${color};"
                             title="${tooltip}">
                            <span class="timeline-bar-label">${barLabel}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        html += '</div></div>';
        container.innerHTML = html;

        // Bind row clicks
        container.querySelectorAll('.timeline-row').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.getAttribute('data-event-id');
                selectedId = id;
                const evt = events.find(e => e.id === id);
                if (evt && onSelect) onSelect(evt);
                render();
            });
        });
    }

    render();

    return {
        selectEvent(eventId) {
            selectedId = eventId;
            render();
        },
        refresh() {
            render();
        }
    };
}
