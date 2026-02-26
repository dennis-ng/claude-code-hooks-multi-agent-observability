import aiosqlite
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List

DB_PATH = os.environ.get("DB_PATH", "./data/commander.db")


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
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                source_app TEXT NOT NULL,
                session_id TEXT NOT NULL,
                project_dir TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                model TEXT,
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
                needs_attention INTEGER NOT NULL DEFAULT 0,
                metadata TEXT
            );
            CREATE TABLE IF NOT EXISTS activity_log (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                event_type TEXT NOT NULL,
                summary TEXT,
                timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                metadata TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
            CREATE INDEX IF NOT EXISTS idx_sessions_needs_attention ON sessions(needs_attention);
            CREATE INDEX IF NOT EXISTS idx_activity_session_id ON activity_log(session_id);
            CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp);
        """)
        await db.commit()
    finally:
        await db.close()


def _row_to_dict(row) -> Optional[dict]:
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


async def upsert_session(
    db,
    source_app: str,
    session_id: str,
    project_dir: Optional[str] = None,
    status: str = "active",
    model: Optional[str] = None,
    needs_attention: int = 0,
    metadata: Optional[dict] = None,
) -> dict:
    """Insert or update a session record. Uses source_app + session_id as the logical key."""
    metadata_json = json.dumps(metadata) if metadata is not None else None
    now = datetime.now(timezone.utc).isoformat()

    # Check if session already exists by source_app + session_id
    cursor = await db.execute(
        "SELECT id FROM sessions WHERE source_app = ? AND session_id = ?",
        (source_app, session_id),
    )
    existing = await cursor.fetchone()

    if existing:
        record_id = existing[0]
        await db.execute(
            """UPDATE sessions
               SET project_dir = COALESCE(?, project_dir),
                   status = ?,
                   model = COALESCE(?, model),
                   last_activity_at = ?,
                   needs_attention = ?,
                   metadata = COALESCE(?, metadata)
               WHERE id = ?""",
            (project_dir, status, model, now, needs_attention, metadata_json, record_id),
        )
    else:
        record_id = str(uuid.uuid4())
        await db.execute(
            """INSERT INTO sessions
               (id, source_app, session_id, project_dir, status, model,
                started_at, last_activity_at, needs_attention, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (record_id, source_app, session_id, project_dir, status, model,
             now, now, needs_attention, metadata_json),
        )

    await db.commit()

    cursor = await db.execute("SELECT * FROM sessions WHERE id = ?", (record_id,))
    row = await cursor.fetchone()
    result = _row_to_dict(row)
    if result:
        result = _parse_json_fields(result, ["metadata"])
    return result


async def insert_activity(
    db,
    session_id: str,
    event_type: str,
    summary: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    """Insert an activity log entry."""
    activity_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    metadata_json = json.dumps(metadata) if metadata is not None else None

    await db.execute(
        """INSERT INTO activity_log (id, session_id, event_type, summary, timestamp, metadata)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (activity_id, session_id, event_type, summary, now, metadata_json),
    )
    await db.commit()

    cursor = await db.execute("SELECT * FROM activity_log WHERE id = ?", (activity_id,))
    row = await cursor.fetchone()
    result = _row_to_dict(row)
    if result:
        result = _parse_json_fields(result, ["metadata"])
    return result


async def get_sessions(
    db,
    status: Optional[str] = None,
    needs_attention: Optional[bool] = None,
    project_dir: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> List[dict]:
    """List sessions with activity counts, filterable by status, needs_attention, project_dir."""
    conditions = []
    params = []

    if status is not None:
        conditions.append("s.status = ?")
        params.append(status)
    if needs_attention is not None:
        conditions.append("s.needs_attention = ?")
        params.append(1 if needs_attention else 0)
    if project_dir is not None:
        conditions.append("s.project_dir = ?")
        params.append(project_dir)

    where_clause = ""
    if conditions:
        where_clause = "WHERE " + " AND ".join(conditions)

    query = f"""
        SELECT s.*, COUNT(a.id) as activity_count
        FROM sessions s
        LEFT JOIN activity_log a ON a.session_id = s.id
        {where_clause}
        GROUP BY s.id
        ORDER BY s.last_activity_at DESC
        LIMIT ? OFFSET ?
    """
    params.extend([limit, offset])

    cursor = await db.execute(query, params)
    rows = await cursor.fetchall()
    return [_parse_json_fields(_row_to_dict(r), ["metadata"]) for r in rows]


async def get_session(db, session_id: str) -> Optional[dict]:
    """Get a single session by its primary key id."""
    cursor = await db.execute(
        """SELECT s.*, COUNT(a.id) as activity_count
           FROM sessions s
           LEFT JOIN activity_log a ON a.session_id = s.id
           WHERE s.id = ?
           GROUP BY s.id""",
        (session_id,),
    )
    row = await cursor.fetchone()
    result = _row_to_dict(row)
    if result:
        result = _parse_json_fields(result, ["metadata"])
    return result


async def get_session_activity(
    db,
    session_id: str,
    limit: int = 100,
    offset: int = 0,
) -> List[dict]:
    """Get activity log entries for a session ordered by timestamp descending."""
    cursor = await db.execute(
        """SELECT * FROM activity_log
           WHERE session_id = ?
           ORDER BY timestamp DESC
           LIMIT ? OFFSET ?""",
        (session_id, limit, offset),
    )
    rows = await cursor.fetchall()
    return [_parse_json_fields(_row_to_dict(r), ["metadata"]) for r in rows]


async def get_stats(db) -> dict:
    """Return dashboard stats: total_sessions, active_sessions, needs_attention_count, sessions_by_status, sessions_by_project."""
    cursor = await db.execute("SELECT COUNT(*) FROM sessions")
    total_sessions = (await cursor.fetchone())[0]

    cursor = await db.execute("SELECT COUNT(*) FROM sessions WHERE status = 'active'")
    active_sessions = (await cursor.fetchone())[0]

    cursor = await db.execute("SELECT COUNT(*) FROM sessions WHERE needs_attention = 1")
    needs_attention_count = (await cursor.fetchone())[0]

    cursor = await db.execute(
        "SELECT status, COUNT(*) as cnt FROM sessions GROUP BY status"
    )
    rows = await cursor.fetchall()
    sessions_by_status = {row[0]: row[1] for row in rows}

    cursor = await db.execute(
        """SELECT COALESCE(project_dir, 'unknown') as project_dir, COUNT(*) as cnt
           FROM sessions
           GROUP BY project_dir
           ORDER BY cnt DESC"""
    )
    rows = await cursor.fetchall()
    sessions_by_project = {row[0]: row[1] for row in rows}

    return {
        "total_sessions": total_sessions,
        "active_sessions": active_sessions,
        "needs_attention_count": needs_attention_count,
        "sessions_by_status": sessions_by_status,
        "sessions_by_project": sessions_by_project,
    }
