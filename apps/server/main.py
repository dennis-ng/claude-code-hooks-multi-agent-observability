import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from server.db import get_db, init_db, ensure_project, ensure_session, insert_event
from server.db import get_projects as db_get_projects
from server.db import get_project as db_get_project
from server.db import get_sessions as db_get_sessions
from server.db import get_session as db_get_session
from server.db import get_session_events as db_get_session_events
from server.db import get_events as db_get_events
from server.db import get_event as db_get_event
from server.db import get_stats as db_get_stats
from server.db import get_filter_options as db_get_filter_options
from server.models import EventCreate, EventResponse, SessionResponse, ProjectResponse, StatsResponse

logger = logging.getLogger("uvicorn.error")


# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    """Manages WebSocket connections and broadcasts events to all clients."""

    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket client connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(f"WebSocket client disconnected. Total: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        """Send a JSON message to all connected WebSocket clients."""
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# Application lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup."""
    await init_db()
    logger.info("Database initialized")
    yield


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Claude Code Hooks Observability",
    description="Lightweight observability backend for Claude Code multi-agent systems",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:8000",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helper to ingest a single event
# ---------------------------------------------------------------------------

async def _ingest_event(event: EventCreate) -> dict:
    """Process a single event: ensure project/session, insert event, broadcast."""
    db = await get_db()
    try:
        # Extract model from metadata if present
        model = None
        agent_type = None
        if isinstance(event.metadata, dict):
            model = event.metadata.get("model")
            agent_type = event.metadata.get("agent_type")

        project_id = await ensure_project(db, event.project_dir)
        await ensure_session(
            db,
            session_id=event.session_id,
            project_id=project_id,
            source_app=event.source_app,
            model=model,
            agent_type=agent_type,
        )

        event_data = {
            "session_id": event.session_id,
            "project_id": project_id,
            "event_type": event.event_type,
            "timestamp": event.timestamp,
            "span_id": event.span_id,
            "parent_span_id": event.parent_span_id,
            "name": event.name,
            "input": event.input,
            "output": event.output,
            "metadata": event.metadata,
            "level": event.level,
        }

        inserted = await insert_event(db, event_data)

        # Broadcast to WebSocket clients
        await manager.broadcast({
            "type": "new_event",
            "event": inserted,
        })

        return inserted
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@app.post("/api/events", status_code=201)
async def create_event(event: EventCreate):
    """Ingest a single event."""
    inserted = await _ingest_event(event)
    return inserted


@app.post("/api/events/batch", status_code=201)
async def create_events_batch(events: List[EventCreate]):
    """Ingest multiple events."""
    results = []
    for event in events:
        inserted = await _ingest_event(event)
        results.append(inserted)
    return results


@app.get("/api/projects")
async def list_projects():
    """List all projects."""
    db = await get_db()
    try:
        return await db_get_projects(db)
    finally:
        await db.close()


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    """Get a single project."""
    db = await get_db()
    try:
        project = await db_get_project(db, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        return project
    finally:
        await db.close()


@app.get("/api/sessions")
async def list_sessions(
    project_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List sessions with optional project filter."""
    db = await get_db()
    try:
        return await db_get_sessions(db, project_id=project_id, limit=limit, offset=offset)
    finally:
        await db.close()


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a session with all its events."""
    db = await get_db()
    try:
        session = await db_get_session(db, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        return session
    finally:
        await db.close()


@app.get("/api/sessions/{session_id}/events")
async def get_session_events(session_id: str):
    """Get events for a specific session."""
    db = await get_db()
    try:
        return await db_get_session_events(db, session_id)
    finally:
        await db.close()


@app.get("/api/events")
async def list_events(
    project_id: Optional[str] = Query(None),
    session_id: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """List events with optional filters."""
    db = await get_db()
    try:
        return await db_get_events(
            db,
            project_id=project_id,
            session_id=session_id,
            event_type=event_type,
            limit=limit,
            offset=offset,
        )
    finally:
        await db.close()


@app.get("/api/events/{event_id}")
async def get_event(event_id: str):
    """Get a single event."""
    db = await get_db()
    try:
        event = await db_get_event(db, event_id)
        if not event:
            raise HTTPException(status_code=404, detail="Event not found")
        return event
    finally:
        await db.close()


@app.get("/api/stats")
async def get_stats(project_id: Optional[str] = Query(None)):
    """Get dashboard statistics."""
    db = await get_db()
    try:
        return await db_get_stats(db, project_id=project_id)
    finally:
        await db.close()


@app.get("/api/filter-options")
async def get_filter_options():
    """Get available filter options for dropdowns."""
    db = await get_db()
    try:
        return await db_get_filter_options(db)
    finally:
        await db.close()


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket):
    """WebSocket endpoint for real-time event streaming."""
    await manager.connect(websocket)
    try:
        while True:
            # Keep connection alive; we only use this for server->client broadcast.
            # Clients can send pings or we just wait for disconnect.
            data = await websocket.receive_text()
            # Optionally handle client messages (e.g., ping)
            if data == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Static files (MUST come last so API routes take precedence)
# ---------------------------------------------------------------------------

# In Docker, server/ and client/ are siblings under /app/
# Locally, they're siblings under apps/
client_dir = Path(__file__).parent.parent / "client"
if client_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(client_dir), html=True), name="static")
