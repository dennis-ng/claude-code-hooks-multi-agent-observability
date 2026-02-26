// API helper
async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, options);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// Format session ID as "source_app:session_id_8chars"
function formatSessionId(source_app, session_id) {
    const shortId = session_id ? session_id.substring(0, 8) : '????????';
    return `${source_app}:${shortId}`;
}

// Relative time helper
function timeAgo(timestamp) {
    if (!timestamp) return 'unknown';
    const now = Date.now();
    const ts = new Date(timestamp).getTime();
    const diff = Math.floor((now - ts) / 1000);

    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hour${Math.floor(diff / 3600) !== 1 ? 's' : ''} ago`;
    return `${Math.floor(diff / 86400)} day${Math.floor(diff / 86400) !== 1 ? 's' : ''} ago`;
}

const App = {
    data() {
        return {
            sessions: [],
            stats: {},
            currentView: 'dashboard',
            selectedSession: null,
            selectedSessionActivity: [],
            loading: false,
            error: null,
            ws: null,
            refreshTimer: null,
            activityLoading: false,
            copySuccess: false,
            showStartForm: false,
            newSessionDir: '',
            newSessionPrompt: '',
            startingSession: false,
        };
    },

    computed: {
        needsAttentionSessions() {
            return this.sessions.filter(s => s.needs_attention);
        },
        activeSessions() {
            return this.sessions.filter(s => s.status === 'active');
        },
        totalCount() {
            return this.stats.total_sessions ?? this.sessions.length;
        },
        activeCount() {
            return this.stats.active_sessions ?? this.activeSessions.length;
        },
        needsAttentionCount() {
            return this.stats.needs_attention_count ?? this.needsAttentionSessions.length;
        },
    },

    methods: {
        formatSessionId,
        timeAgo,

        truncatePath(path, maxLen = 48) {
            if (!path) return '';
            if (path.length <= maxLen) return path;
            return '...' + path.slice(path.length - (maxLen - 3));
        },

        statusClass(status) {
            const map = {
                active: 'status-active',
                idle: 'status-idle',
                completed: 'status-completed',
                error: 'status-error',
            };
            return map[status] || 'status-idle';
        },

        statusLabel(status) {
            if (!status) return 'unknown';
            return status.charAt(0).toUpperCase() + status.slice(1);
        },

        async loadSessions() {
            try {
                this.error = null;
                const data = await api('/sessions/');
                this.sessions = Array.isArray(data) ? data : (data.sessions || []);
            } catch (e) {
                this.error = e.message;
            }
        },

        async loadStats() {
            try {
                const data = await api('/stats');
                this.stats = data || {};
            } catch (e) {
                // stats endpoint may not exist; silently ignore
            }
        },

        async refresh() {
            await Promise.all([this.loadSessions(), this.loadStats()]);
        },

        async discover() {
            this.loading = true;
            try {
                await api('/sessions/discover', { method: 'POST' });
                await this.refresh();
            } catch (e) {
                this.error = e.message;
            } finally {
                this.loading = false;
            }
        },

        async resumeSession(session) {
            try {
                await api(`/sessions/${session.session_id}/resume`, { method: 'POST' });
                await this.refresh();
            } catch (e) {
                this.error = e.message;
            }
        },

        async startNewSession() {
            if (!this.newSessionDir.trim()) {
                this.error = 'Project directory is required';
                return;
            }
            this.startingSession = true;
            try {
                await api('/sessions/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        project_dir: this.newSessionDir.trim(),
                        prompt: this.newSessionPrompt.trim() || null,
                    }),
                });
                this.showStartForm = false;
                this.newSessionDir = '';
                this.newSessionPrompt = '';
                await this.refresh();
            } catch (e) {
                this.error = e.message;
            } finally {
                this.startingSession = false;
            }
        },

        async viewSession(session) {
            this.selectedSession = session;
            this.currentView = 'detail';
            this.selectedSessionActivity = [];
            this.activityLoading = true;
            try {
                const data = await api(`/sessions/${session.id}/activity`);
                this.selectedSessionActivity = Array.isArray(data) ? data : (data.activity || data.events || []);
            } catch (e) {
                this.selectedSessionActivity = [];
            } finally {
                this.activityLoading = false;
            }
        },

        backToDashboard() {
            this.currentView = 'dashboard';
            this.selectedSession = null;
            this.selectedSessionActivity = [];
        },

        copyResumeCommand() {
            if (!this.selectedSession) return;
            const cmd = `claude --resume ${this.selectedSession.session_id}`;
            navigator.clipboard.writeText(cmd).then(() => {
                this.copySuccess = true;
                setTimeout(() => { this.copySuccess = false; }, 2000);
            }).catch(() => {
                // Fallback for non-HTTPS
                const el = document.createElement('textarea');
                el.value = cmd;
                document.body.appendChild(el);
                el.select();
                document.execCommand('copy');
                document.body.removeChild(el);
                this.copySuccess = true;
                setTimeout(() => { this.copySuccess = false; }, 2000);
            });
        },

        connectWebSocket() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = `${protocol}//${location.host}/ws`;
            try {
                this.ws = new WebSocket(url);
                this.ws.addEventListener('message', () => {
                    this.refresh();
                });
                this.ws.addEventListener('close', () => {
                    // Reconnect after 5s
                    setTimeout(() => this.connectWebSocket(), 5000);
                });
                this.ws.addEventListener('error', () => {
                    this.ws.close();
                });
            } catch (e) {
                // WS unavailable, rely on polling
            }
        },

        startPolling() {
            this.refreshTimer = setInterval(() => {
                this.refresh();
            }, 10000);
        },

        activityIcon(event) {
            const type = (event.event_type || event.type || '').toLowerCase();
            if (type.includes('tool')) return '[T]';
            if (type.includes('error')) return '[E]';
            if (type.includes('start')) return '[S]';
            if (type.includes('stop') || type.includes('end')) return '[X]';
            if (type.includes('message') || type.includes('msg')) return '[M]';
            return '[*]';
        },

        activityIconClass(event) {
            const type = (event.event_type || event.type || '').toLowerCase();
            if (type.includes('error')) return 'event-error';
            if (type.includes('tool')) return 'event-tool';
            if (type.includes('start')) return 'event-start';
            if (type.includes('stop') || type.includes('end')) return 'event-end';
            return 'event-default';
        },

        eventSummary(event) {
            return event.summary || event.message || event.content || event.event_type || event.type || 'Event';
        },
    },

    async mounted() {
        await this.refresh();
        this.connectWebSocket();
        this.startPolling();
    },

    beforeUnmount() {
        if (this.ws) this.ws.close();
        if (this.refreshTimer) clearInterval(this.refreshTimer);
    },

    template: `
<div class="app-container">
    <!-- DASHBOARD VIEW -->
    <div v-if="currentView === 'dashboard'">
        <!-- Header -->
        <header class="app-header">
            <div class="header-inner">
                <h1 class="app-title">Commander UI</h1>
                <div class="stats-bar">
                    <div class="stat-card">
                        <span class="stat-value">{{ totalCount }}</span>
                        <span class="stat-label">Total Sessions</span>
                    </div>
                    <div class="stat-card stat-active">
                        <span class="stat-value">{{ activeCount }}</span>
                        <span class="stat-label">Active</span>
                    </div>
                    <div class="stat-card" :class="needsAttentionCount > 0 ? 'stat-attention' : ''">
                        <span class="stat-value">{{ needsAttentionCount }}</span>
                        <span class="stat-label">Needs Attention</span>
                    </div>
                </div>
                <div class="header-buttons">
                    <button class="btn btn-primary" @click="discover" :disabled="loading">
                        <span v-if="loading">Discovering...</span>
                        <span v-else>Discover Sessions</span>
                    </button>
                    <button class="btn btn-secondary" @click="showStartForm = !showStartForm">
                        + New Session
                    </button>
                </div>
            </div>
        </header>

        <main class="main-content">
            <!-- Error banner -->
            <div v-if="error" class="error-banner">
                {{ error }}
                <button class="btn-close" @click="error = null">&times;</button>
            </div>

            <!-- Start New Session Form -->
            <section v-if="showStartForm" class="start-session-form">
                <h2 class="section-title">Start New Session</h2>
                <div class="form-group">
                    <label class="form-label">Project Directory</label>
                    <input
                        v-model="newSessionDir"
                        type="text"
                        class="form-input"
                        placeholder="/path/to/your/project"
                        @keydown.enter="startNewSession"
                    />
                </div>
                <div class="form-group">
                    <label class="form-label">Initial Prompt (optional)</label>
                    <input
                        v-model="newSessionPrompt"
                        type="text"
                        class="form-input"
                        placeholder="e.g. fix the login bug"
                        @keydown.enter="startNewSession"
                    />
                </div>
                <div class="form-actions">
                    <button class="btn btn-primary" @click="startNewSession" :disabled="startingSession">
                        <span v-if="startingSession">Starting...</span>
                        <span v-else>Start Session</span>
                    </button>
                    <button class="btn btn-ghost" @click="showStartForm = false">Cancel</button>
                </div>
            </section>

            <!-- Needs Attention Section -->
            <section v-if="needsAttentionSessions.length > 0" class="attention-section">
                <h2 class="section-title attention-title">
                    <span class="attention-icon">!</span>
                    Needs Attention
                    <span class="badge badge-attention">{{ needsAttentionSessions.length }}</span>
                </h2>
                <div class="session-list">
                    <div
                        v-for="session in needsAttentionSessions"
                        :key="session.session_id"
                        class="session-card attention-card"
                    >
                        <div class="session-card-inner">
                            <div class="session-info">
                                <div class="session-id-row">
                                    <span :class="['status-dot', statusClass(session.status)]"></span>
                                    <span class="session-id">{{ formatSessionId(session.source_app, session.session_id) }}</span>
                                    <span :class="['status-badge', statusClass(session.status)]">{{ statusLabel(session.status) }}</span>
                                </div>
                                <div class="session-meta">
                                    <span class="meta-item meta-path" :title="session.project_dir">{{ truncatePath(session.project_dir) }}</span>
                                    <span class="meta-sep">&middot;</span>
                                    <span class="meta-item">{{ session.model || 'unknown' }}</span>
                                    <span class="meta-sep">&middot;</span>
                                    <span class="meta-item meta-time">{{ timeAgo(session.last_activity_at || session.updated_at) }}</span>
                                </div>
                            </div>
                            <div class="session-actions">
                                <button class="btn btn-secondary btn-sm" @click="viewSession(session)">View</button>
                                <button class="btn btn-primary btn-sm" @click="resumeSession(session)">Resume</button>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <!-- All Sessions -->
            <section class="sessions-section">
                <h2 class="section-title">All Sessions</h2>
                <div v-if="sessions.length === 0" class="empty-state">
                    <p>No sessions found. Click "Discover Sessions" to scan for active Claude sessions.</p>
                </div>
                <div v-else class="session-list">
                    <div
                        v-for="session in sessions"
                        :key="session.session_id"
                        class="session-card"
                        :class="session.needs_attention ? 'attention-card' : ''"
                    >
                        <div class="session-card-inner">
                            <div class="session-info">
                                <div class="session-id-row">
                                    <span :class="['status-dot', statusClass(session.status)]"></span>
                                    <span class="session-id">{{ formatSessionId(session.source_app, session.session_id) }}</span>
                                    <span :class="['status-badge', statusClass(session.status)]">{{ statusLabel(session.status) }}</span>
                                </div>
                                <div class="session-meta">
                                    <span class="meta-item meta-path" :title="session.project_dir">{{ truncatePath(session.project_dir) }}</span>
                                    <span class="meta-sep">&middot;</span>
                                    <span class="meta-item">{{ session.model || 'unknown' }}</span>
                                    <span class="meta-sep">&middot;</span>
                                    <span class="meta-item meta-time">{{ timeAgo(session.last_activity_at || session.updated_at) }}</span>
                                </div>
                            </div>
                            <div class="session-actions">
                                <button class="btn btn-secondary btn-sm" @click="viewSession(session)">View</button>
                                <button class="btn btn-primary btn-sm" @click="resumeSession(session)">Resume</button>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        </main>
    </div>

    <!-- DETAIL VIEW -->
    <div v-else-if="currentView === 'detail' && selectedSession">
        <header class="app-header">
            <div class="header-inner">
                <button class="btn btn-ghost" @click="backToDashboard">&#8592; Back</button>
                <h1 class="app-title">Session Detail</h1>
            </div>
        </header>

        <main class="main-content">
            <!-- Session Header Card -->
            <section class="detail-header-card">
                <div class="detail-header-row">
                    <div>
                        <div class="detail-id-row">
                            <span :class="['status-dot', 'status-dot-lg', statusClass(selectedSession.status)]"></span>
                            <span class="detail-session-id">{{ selectedSession.session_id }}</span>
                            <span :class="['status-badge', statusClass(selectedSession.status)]">{{ statusLabel(selectedSession.status) }}</span>
                        </div>
                        <div class="detail-meta-grid">
                            <div class="detail-meta-item">
                                <span class="detail-meta-label">Source App</span>
                                <span class="detail-meta-value">{{ selectedSession.source_app }}</span>
                            </div>
                            <div class="detail-meta-item">
                                <span class="detail-meta-label">Model</span>
                                <span class="detail-meta-value">{{ selectedSession.model || 'unknown' }}</span>
                            </div>
                            <div class="detail-meta-item">
                                <span class="detail-meta-label">Project</span>
                                <span class="detail-meta-value meta-path" :title="selectedSession.project_dir">{{ truncatePath(selectedSession.project_dir, 64) }}</span>
                            </div>
                            <div class="detail-meta-item">
                                <span class="detail-meta-label">Started</span>
                                <span class="detail-meta-value">{{ selectedSession.started_at || selectedSession.created_at || 'unknown' }}</span>
                            </div>
                        </div>
                    </div>
                    <div class="detail-actions">
                        <button class="btn btn-primary" @click="resumeSession(selectedSession)">Resume Session</button>
                        <button class="btn btn-secondary" @click="copyResumeCommand">
                            <span v-if="copySuccess">Copied!</span>
                            <span v-else>Copy Resume Command</span>
                        </button>
                    </div>
                </div>
            </section>

            <!-- Activity Timeline -->
            <section class="timeline-section">
                <h2 class="section-title">Activity Timeline</h2>
                <div v-if="activityLoading" class="loading-state">Loading activity...</div>
                <div v-else-if="selectedSessionActivity.length === 0" class="empty-state">
                    <p>No activity recorded for this session.</p>
                </div>
                <div v-else class="timeline">
                    <div
                        v-for="(event, idx) in selectedSessionActivity"
                        :key="idx"
                        class="timeline-event"
                    >
                        <div :class="['timeline-dot', activityIconClass(event)]"></div>
                        <div class="timeline-content">
                            <div class="timeline-header">
                                <span class="timeline-type">{{ event.event_type || event.type || 'event' }}</span>
                                <span class="timeline-time">{{ timeAgo(event.timestamp || event.created_at) }}</span>
                            </div>
                            <div class="timeline-summary">{{ eventSummary(event) }}</div>
                        </div>
                    </div>
                </div>
            </section>
        </main>
    </div>
</div>
    `
};

Vue.createApp(App).mount('#app');
