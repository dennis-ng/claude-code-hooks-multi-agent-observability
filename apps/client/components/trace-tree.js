// Trace tree component: renders a collapsible tree of events using span_id/parent_span_id

/**
 * Build a tree from flat events using span_id / parent_span_id relationships.
 * Returns an array of root nodes, each with a .children array.
 */
function buildTree(events) {
    // Map span_id -> event (only for events that have a span_id)
    const spanMap = new Map();
    for (const evt of events) {
        if (evt.span_id) {
            // If multiple events share the same span_id, keep the first one as the canonical node.
            // Others become children or separate root nodes.
            if (!spanMap.has(evt.span_id)) {
                spanMap.set(evt.span_id, evt);
            }
        }
    }

    // Create node wrappers
    const nodeMap = new Map(); // event.id -> node
    const nodes = events.map(evt => {
        const node = { event: evt, children: [] };
        nodeMap.set(evt.id, node);
        return node;
    });

    const roots = [];

    for (const node of nodes) {
        const evt = node.event;
        let placed = false;

        if (evt.parent_span_id) {
            // Find parent by span_id match
            const parentEvt = spanMap.get(evt.parent_span_id);
            if (parentEvt && parentEvt.id !== evt.id) {
                const parentNode = nodeMap.get(parentEvt.id);
                if (parentNode) {
                    parentNode.children.push(node);
                    placed = true;
                }
            }
        }

        if (!placed) {
            roots.push(node);
        }
    }

    return roots;
}

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

/**
 * Extract a smart content preview from an event based on its type.
 * Returns a short string to display inline in the tree node.
 */
function getContentPreview(evt) {
    const MAX_LEN = 120;

    function truncate(s) {
        if (!s) return '';
        s = String(s).replace(/\s+/g, ' ').trim();
        return s.length > MAX_LEN ? s.slice(0, MAX_LEN) + '...' : s;
    }

    function extractText(data) {
        if (!data) return '';
        if (typeof data === 'string') return data;
        // Handle common nested shapes
        if (data.prompt) return data.prompt;
        if (data.message) return data.message;
        if (data.content) return typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
        if (data.file_path) return data.file_path;
        if (data.command) return data.command;
        if (data.pattern) return data.pattern;
        if (data.query) return data.query;
        if (data.url) return data.url;
        if (data.old_string) return `"${data.old_string.slice(0, 40)}" → "${(data.new_string || '').slice(0, 40)}"`;
        if (data.description) return data.description;
        // Fallback: stringify first few keys
        const keys = Object.keys(data);
        if (keys.length === 0) return '';
        const firstKey = keys[0];
        const firstVal = data[firstKey];
        if (typeof firstVal === 'string') return firstVal;
        return '';
    }

    try {
        const input = typeof evt.input === 'string' ? JSON.parse(evt.input) : evt.input;
        const output = typeof evt.output === 'string' ? JSON.parse(evt.output) : evt.output;
        const meta = typeof evt.metadata === 'string' ? JSON.parse(evt.metadata) : evt.metadata;

        switch (evt.event_type) {
            case 'UserPromptSubmit': {
                const text = extractText(input) || (meta && meta.prompt) || '';
                return text ? truncate(text) : '';
            }
            case 'PreToolUse': {
                // Show what tool is doing: file path, command, pattern, etc.
                return truncate(extractText(input));
            }
            case 'PostToolUse': {
                // Show output preview
                const text = extractText(output);
                if (text) return truncate(text);
                // If output is a string blob (file content), show first line
                if (typeof output === 'string') return truncate(output.split('\n')[0]);
                return '';
            }
            case 'PostToolUseFailure': {
                const err = (meta && meta.error) || extractText(output) || 'Error';
                return truncate(err);
            }
            case 'Notification': {
                return truncate((meta && (meta.message || meta.title)) || '');
            }
            case 'PermissionRequest': {
                const tool = (meta && meta.tool_name) || evt.name || '';
                const preview = extractText(input);
                return truncate(tool ? `${tool}: ${preview}` : preview);
            }
            case 'SubagentStart':
            case 'SubagentStop': {
                const agentType = (meta && meta.agent_type) || '';
                return agentType ? truncate(agentType) : '';
            }
            case 'SessionStart': {
                const source = (meta && meta.source) || '';
                const model = (meta && meta.model) || '';
                return truncate([source, model].filter(Boolean).join(' · '));
            }
            case 'SessionEnd': {
                return truncate((meta && meta.reason) || '');
            }
            case 'Stop': {
                return '';
            }
            case 'PreCompact': {
                return truncate((meta && meta.trigger) || '');
            }
            default:
                return '';
        }
    } catch {
        return '';
    }
}

function formatDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Render a collapsible tree of events.
 *
 * @param {HTMLElement} container
 * @param {Array} events - flat array of event objects
 * @param {Function} onSelect - callback(event) when a node is clicked
 */
export function renderTraceTree(container, events, onSelect) {
    const roots = buildTree(events);
    let selectedId = null;

    // Track collapsed state: node id -> boolean
    const collapsed = new Set();

    function renderNode(node, depth) {
        const evt = node.event;
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(evt.id);
        const isSelected = evt.id === selectedId;

        let indent = '';
        for (let i = 0; i < depth; i++) {
            indent += '<span class="tree-indent"></span>';
        }

        const toggleClass = hasChildren ? (isCollapsed ? '' : 'expanded') : 'hidden';
        const selectedClass = isSelected ? 'selected' : '';
        const badgeClass = `badge badge-${escapeHtml(evt.event_type)}`;
        const durationStr = formatDuration(evt.duration_ms);
        const preview = getContentPreview(evt);

        let html = `
            <div class="tree-node ${selectedClass}" data-event-id="${escapeHtml(evt.id)}">
                ${indent}
                <button class="tree-toggle ${toggleClass}" data-toggle-id="${escapeHtml(evt.id)}">&#9656;</button>
                <div class="tree-node-content">
                    <span class="${badgeClass}">${escapeHtml(evt.event_type)}</span>
                    <span class="tree-node-name" title="${escapeHtml(evt.name || '')}">${escapeHtml(evt.name || evt.event_type)}</span>
                    ${durationStr ? `<span class="tree-node-duration">${durationStr}</span>` : ''}
                </div>
                ${preview ? `<div class="tree-node-preview" title="${escapeHtml(preview)}">${escapeHtml(preview)}</div>` : ''}
            </div>
        `;

        if (hasChildren && !isCollapsed) {
            for (const child of node.children) {
                html += renderNode(child, depth + 1);
            }
        }

        return html;
    }

    function render() {
        let html = '<div class="trace-tree">';
        if (roots.length === 0) {
            html += '<div class="empty-state"><p>No events to display</p></div>';
        } else {
            for (const root of roots) {
                html += renderNode(root, 0);
            }
        }
        html += '</div>';
        container.innerHTML = html;

        // Bind toggle clicks
        container.querySelectorAll('.tree-toggle:not(.hidden)').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-toggle-id');
                if (collapsed.has(id)) {
                    collapsed.delete(id);
                } else {
                    collapsed.add(id);
                }
                render();
            });
        });

        // Bind node clicks
        container.querySelectorAll('.tree-node').forEach(node => {
            node.addEventListener('click', () => {
                const id = node.getAttribute('data-event-id');
                selectedId = id;
                const evt = events.find(e => e.id === id);
                if (evt && onSelect) onSelect(evt);
                render();
            });
        });
    }

    render();

    // Return an update function so external code can change selection
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
