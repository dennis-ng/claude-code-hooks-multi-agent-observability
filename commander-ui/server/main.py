import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from server.db import get_db, init_db, get_sessions, get_session, get_session_activity, get_stats
from server.models import SessionResponse, ActivityResponse, StatsResponse, DiscoverResponse, StartSessionRequest, ResumeSessionRequest
from server.process_manager import start_session, resume_session

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
    title="Commander UI",
    description="Claude Code Session Commander - manage and monitor agent sessions",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:4200",
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:8000",
        "http://127.0.0.1:4200",
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
# API Routes
# ---------------------------------------------------------------------------

@app.get("/api/sessions/")
async def list_sessions(
    status: Optional[str] = Query(None),
    needs_attention: Optional[bool] = Query(None),
    project_dir: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List sessions with optional filters."""
    db = await get_db()
    try:
        return await get_sessions(
            db,
            status=status,
            needs_attention=needs_attention,
            project_dir=project_dir,
            limit=limit,
            offset=offset,
        )
    finally:
        await db.close()


@app.get("/api/sessions/{session_id}")
async def get_session_detail(session_id: str):
    """Get a single session by ID."""
    db = await get_db()
    try:
        session = await get_session(db, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        return session
    finally:
        await db.close()


@app.get("/api/sessions/{session_id}/activity")
async def get_session_activity_log(
    session_id: str,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Get activity log for a session with pagination."""
    db = await get_db()
    try:
        return await get_session_activity(db, session_id, limit=limit, offset=offset)
    finally:
        await db.close()


@app.post("/api/sessions/start")
async def start_session_endpoint(request: StartSessionRequest):
    """Start a new Claude Code session in the specified project directory."""
    try:
        result = await start_session(request.project_dir, request.prompt)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/sessions/{session_id}/resume")
async def resume_session_endpoint(session_id: str, request: ResumeSessionRequest):
    """Resume an existing Claude Code session."""
    try:
        result = await resume_session(session_id, request.project_dir)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/sessions/discover")
async def discover_sessions():
    """Discover and import sessions from the filesystem."""
    from server.discovery import discover_sessions as do_discover
    result = await do_discover()
    return result


@app.get("/api/stats")
async def get_dashboard_stats():
    """Return dashboard statistics."""
    db = await get_db()
    try:
        return await get_stats(db)
    finally:
        await db.close()


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time session updates."""
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Static files (MUST come last so API routes take precedence)
# ---------------------------------------------------------------------------

client_dir = Path(__file__).parent.parent / "client"
if client_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(client_dir), html=True), name="static")
