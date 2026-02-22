import aiosqlite
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any, List

DB_PATH = os.environ.get("DB_PATH", "./data/events.db")


async def get_db():
    """Get database connection with WAL mode."""
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA synchronous=NORMAL")
    return db


async def init_db():
    """Create tables if they don't exist."""
    db = await get_db()
    try:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id),
                source_app TEXT NOT NULL,
                model TEXT,
                agent_type TEXT,
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                ended_at TEXT,
                metadata TEXT
            );
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                project_id TEXT NOT NULL REFERENCES projects(id),
                event_type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                span_id TEXT,
                parent_span_id TEXT,
                name TEXT,
                input TEXT,
                output TEXT,
                metadata TEXT,
                level TEXT DEFAULT 'DEFAULT',
                duration_ms INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
            CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
            CREATE INDEX IF NOT EXISTS idx_events_span ON events(span_id);
            CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
            CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
            CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
        """)
        await db.commit()
    finally:
        await db.close()


def slugify_project_dir(project_dir: str) -> str:
    """Convert a path to a URL-safe slug (replace / with -, strip leading -)."""
    slug = project_dir.replace("/", "-").replace("\\", "-")
    slug = re.sub(r"-+", "-", slug)
    slug = slug.strip("-")
    return slug


async def ensure_project(db, project_dir: str) -> str:
    """INSERT OR IGNORE project, return project_id."""
    project_id = slugify_project_dir(project_dir)
    name = Path(project_dir).name or project_dir
    await db.execute(
        "INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)",
        (project_id, name),
    )
    await db.commit()
    return project_id


async def ensure_session(
    db,
    session_id: str,
    project_id: str,
    source_app: str,
    model: Optional[str] = None,
    agent_type: Optional[str] = None,
) -> str:
    """INSERT OR IGNORE session, return session_id."""
    metadata_json = json.dumps({"model": model, "agent_type": agent_type})
    await db.execute(
        """INSERT OR IGNORE INTO sessions (id, project_id, source_app, model, agent_type, metadata)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (session_id, project_id, source_app, model, agent_type, metadata_json),
    )
    await db.commit()
    return session_id


def _parse_timestamp(ts: str) -> Optional[datetime]:
    """Parse an ISO-format timestamp string into a datetime."""
    try:
        return datetime.fromisoformat(ts)
    except (ValueError, TypeError):
        return None


def _row_to_dict(row) -> dict:
    """Convert an aiosqlite.Row to a plain dict."""
    if row is None:
        return None
    return dict(row)


def _parse_json_fields(d: dict, fields: List[str]) -> dict:
    """Parse JSON string fields in a dict back to Python objects."""
    for field in fields:
        if field in d and isinstance(d[field], str):
            try:
                d[field] = json.loads(d[field])
            except (json.JSONDecodeError, TypeError):
                pass
    return d


# Span-close event types that should compute duration_ms from a matching start event.
_SPAN_CLOSE_TYPES = {"PostToolUse", "PostToolUseFailure", "SubagentStop"}
# Mapping from close event type to its matching start event type.
_SPAN_START_MAP = {
    "PostToolUse": "PreToolUse",
    "PostToolUseFailure": "PreToolUse",
    "SubagentStop": "SubagentStart",
}


async def insert_event(db, event_data: dict) -> dict:
    """Insert an event. Auto-compute duration_ms for span-close events."""
    event_id = str(uuid.uuid4())
    event_type = event_data.get("event_type", "")
    span_id = event_data.get("span_id")
    timestamp = event_data.get("timestamp", datetime.now(timezone.utc).isoformat())
    session_id = event_data.get("session_id", "")
    project_id = event_data.get("project_id", "")

    # Serialize complex fields to JSON strings for storage.
    input_val = event_data.get("input")
    if input_val is not None and not isinstance(input_val, str):
        input_val = json.dumps(input_val)

    output_val = event_data.get("output")
    if output_val is not None and not isinstance(output_val, str):
        output_val = json.dumps(output_val)

    metadata_val = event_data.get("metadata")
    if metadata_val is not None and not isinstance(metadata_val, str):
        metadata_val = json.dumps(metadata_val)

    # Compute duration_ms for span-close events by finding matching start event.
    duration_ms = None
    if event_type in _SPAN_CLOSE_TYPES and span_id:
        start_type = _SPAN_START_MAP.get(event_type)
        if start_type:
            cursor = await db.execute(
                "SELECT timestamp FROM events WHERE span_id = ? AND event_type = ? ORDER BY timestamp ASC LIMIT 1",
                (span_id, start_type),
            )
            start_row = await cursor.fetchone()
            if start_row:
                start_ts = _parse_timestamp(start_row[0])
                end_ts = _parse_timestamp(timestamp)
                if start_ts and end_ts:
                    delta = end_ts - start_ts
                    duration_ms = int(delta.total_seconds() * 1000)

    await db.execute(
        """INSERT INTO events (id, session_id, project_id, event_type, timestamp,
            span_id, parent_span_id, name, input, output, metadata, level, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            event_id,
            session_id,
            project_id,
            event_type,
            timestamp,
            span_id,
            event_data.get("parent_span_id"),
            event_data.get("name"),
            input_val,
            output_val,
            metadata_val,
            event_data.get("level", "DEFAULT"),
            duration_ms,
        ),
    )
    await db.commit()

    # Return the inserted event as a dict.
    cursor = await db.execute("SELECT * FROM events WHERE id = ?", (event_id,))
    row = await cursor.fetchone()
    result = _row_to_dict(row)
    if result:
        result = _parse_json_fields(result, ["input", "output", "metadata"])
    return result


async def get_projects(db) -> list:
    """List all projects with session counts."""
    cursor = await db.execute(
        """SELECT p.*, COUNT(s.id) as session_count
           FROM projects p
           LEFT JOIN sessions s ON s.project_id = p.id
           GROUP BY p.id
           ORDER BY p.created_at DESC"""
    )
    rows = await cursor.fetchall()
    return [_parse_json_fields(_row_to_dict(r), []) for r in rows]


async def get_project(db, project_id: str) -> Optional[dict]:
    """Get single project."""
    cursor = await db.execute(
        """SELECT p.*, COUNT(s.id) as session_count
           FROM projects p
           LEFT JOIN sessions s ON s.project_id = p.id
           WHERE p.id = ?
           GROUP BY p.id""",
        (project_id,),
    )
    row = await cursor.fetchone()
    return _row_to_dict(row)


async def get_sessions(
    db, project_id: Optional[str] = None, limit: int = 50, offset: int = 0
) -> list:
    """List sessions with event counts, filterable by project_id."""
    if project_id:
        cursor = await db.execute(
            """SELECT s.*, COUNT(e.id) as event_count
               FROM sessions s
               LEFT JOIN events e ON e.session_id = s.id
               WHERE s.project_id = ?
               GROUP BY s.id
               ORDER BY s.started_at DESC
               LIMIT ? OFFSET ?""",
            (project_id, limit, offset),
        )
    else:
        cursor = await db.execute(
            """SELECT s.*, COUNT(e.id) as event_count
               FROM sessions s
               LEFT JOIN events e ON e.session_id = s.id
               GROUP BY s.id
               ORDER BY s.started_at DESC
               LIMIT ? OFFSET ?""",
            (limit, offset),
        )
    rows = await cursor.fetchall()
    return [_parse_json_fields(_row_to_dict(r), ["metadata"]) for r in rows]


async def get_session(db, session_id: str) -> Optional[dict]:
    """Get session with all its events."""
    cursor = await db.execute(
        """SELECT s.*, COUNT(e.id) as event_count
           FROM sessions s
           LEFT JOIN events e ON e.session_id = s.id
           WHERE s.id = ?
           GROUP BY s.id""",
        (session_id,),
    )
    row = await cursor.fetchone()
    session = _row_to_dict(row)
    if session:
        session = _parse_json_fields(session, ["metadata"])
        session["events"] = await get_session_events(db, session_id)
    return session


async def get_session_events(db, session_id: str) -> list:
    """Get events for a session ordered by timestamp."""
    cursor = await db.execute(
        "SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC",
        (session_id,),
    )
    rows = await cursor.fetchall()
    return [_parse_json_fields(_row_to_dict(r), ["input", "output", "metadata"]) for r in rows]


async def get_events(
    db,
    project_id: Optional[str] = None,
    session_id: Optional[str] = None,
    event_type: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list:
    """List events with filters."""
    conditions = []
    params = []

    if project_id:
        conditions.append("project_id = ?")
        params.append(project_id)
    if session_id:
        conditions.append("session_id = ?")
        params.append(session_id)
    if event_type:
        conditions.append("event_type = ?")
        params.append(event_type)

    where_clause = ""
    if conditions:
        where_clause = "WHERE " + " AND ".join(conditions)

    query = f"SELECT * FROM events {where_clause} ORDER BY timestamp DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    cursor = await db.execute(query, params)
    rows = await cursor.fetchall()
    return [_parse_json_fields(_row_to_dict(r), ["input", "output", "metadata"]) for r in rows]


async def get_event(db, event_id: str) -> Optional[dict]:
    """Get single event."""
    cursor = await db.execute("SELECT * FROM events WHERE id = ?", (event_id,))
    row = await cursor.fetchone()
    result = _row_to_dict(row)
    if result:
        result = _parse_json_fields(result, ["input", "output", "metadata"])
    return result


async def get_stats(db, project_id: Optional[str] = None) -> dict:
    """Dashboard stats: total_events, total_sessions, total_projects, events_today, events_by_type, recent_sessions."""
    project_filter = ""
    project_params: list = []
    if project_id:
        project_filter = "WHERE project_id = ?"
        project_params = [project_id]

    # Total events
    cursor = await db.execute(f"SELECT COUNT(*) FROM events {project_filter}", project_params)
    total_events = (await cursor.fetchone())[0]

    # Total sessions
    cursor = await db.execute(f"SELECT COUNT(*) FROM sessions {project_filter}", project_params)
    total_sessions = (await cursor.fetchone())[0]

    # Total projects
    cursor = await db.execute("SELECT COUNT(*) FROM projects")
    total_projects = (await cursor.fetchone())[0]

    # Events today
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if project_id:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM events WHERE timestamp >= ? AND project_id = ?",
            (today, project_id),
        )
    else:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM events WHERE timestamp >= ?",
            (today,),
        )
    events_today = (await cursor.fetchone())[0]

    # Events by type
    cursor = await db.execute(
        f"SELECT event_type, COUNT(*) as cnt FROM events {project_filter} GROUP BY event_type",
        project_params,
    )
    rows = await cursor.fetchall()
    events_by_type = {row[0]: row[1] for row in rows}

    # Recent sessions (last 10)
    if project_id:
        cursor = await db.execute(
            """SELECT s.*, COUNT(e.id) as event_count
               FROM sessions s
               LEFT JOIN events e ON e.session_id = s.id
               WHERE s.project_id = ?
               GROUP BY s.id
               ORDER BY s.started_at DESC
               LIMIT 10""",
            (project_id,),
        )
    else:
        cursor = await db.execute(
            """SELECT s.*, COUNT(e.id) as event_count
               FROM sessions s
               LEFT JOIN events e ON e.session_id = s.id
               GROUP BY s.id
               ORDER BY s.started_at DESC
               LIMIT 10"""
        )
    session_rows = await cursor.fetchall()
    recent_sessions = [_parse_json_fields(_row_to_dict(r), ["metadata"]) for r in session_rows]

    return {
        "total_events": total_events,
        "total_sessions": total_sessions,
        "total_projects": total_projects,
        "events_today": events_today,
        "events_by_type": events_by_type,
        "recent_sessions": recent_sessions,
    }


async def get_filter_options(db) -> dict:
    """Return available event_types, project_ids, session_ids for filter dropdowns."""
    cursor = await db.execute("SELECT DISTINCT event_type FROM events ORDER BY event_type")
    event_types = [row[0] for row in await cursor.fetchall()]

    cursor = await db.execute("SELECT id, name FROM projects ORDER BY name")
    projects = [{"id": row[0], "name": row[1]} for row in await cursor.fetchall()]

    cursor = await db.execute(
        "SELECT id, source_app, project_id FROM sessions ORDER BY started_at DESC"
    )
    sessions = [
        {"id": row[0], "source_app": row[1], "project_id": row[2]}
        for row in await cursor.fetchall()
    ]

    return {
        "event_types": event_types,
        "projects": projects,
        "sessions": sessions,
    }
