"""Session discovery service for Claude Code Commander UI.

Scans ~/.claude/projects/ for session files and detects active Claude processes.
"""

import asyncio
import json
import os
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from server.db import upsert_session, get_sessions


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CLAUDE_HOME = Path(os.environ.get("CLAUDE_HOME", "~/.claude")).expanduser()
PROJECTS_DIR = CLAUDE_HOME / "projects"

# Sessions idle for more than this many minutes are considered "idle"
IDLE_THRESHOLD_MINUTES = 5


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def discover_sessions(db) -> dict:
    """Main discovery function.

    Scans ~/.claude/projects/ for project directories and session files,
    detects active Claude Code processes, and upserts session records into the
    database.

    Returns:
        {"discovered": int, "updated": int, "total": int}
    """
    active_pids = await _detect_active_processes()

    # Gather all session info objects from the filesystem
    session_infos = []
    if PROJECTS_DIR.exists():
        for project_entry in _scan_claude_projects():
            for session in project_entry.get("sessions", []):
                session["project_dir"] = _slug_to_path(project_entry["project_slug"])
                session_infos.append(session)

    discovered = 0
    updated = 0

    for info in session_infos:
        session_id = info["session_id"]
        project_dir = info.get("project_dir")
        status = _determine_status(info, active_pids)
        needs_attention = 1 if _determine_needs_attention(info) else 0

        # Check whether this session already exists in the DB
        existing = await _find_existing_session(db, session_id)

        metadata = {
            "jsonl_path": info.get("jsonl_path"),
            "file_size": info.get("file_size"),
            "last_modified": info.get("last_modified"),
        }

        await upsert_session(
            db,
            source_app="claude-code",
            session_id=session_id,
            project_dir=project_dir,
            status=status,
            needs_attention=needs_attention,
            metadata=metadata,
        )

        if existing:
            updated += 1
        else:
            discovered += 1

    # Total sessions in DB after upserting
    all_sessions = await get_sessions(db, limit=10_000)
    total = len(all_sessions)

    return {"discovered": discovered, "updated": updated, "total": total}


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _scan_claude_projects() -> list:
    """Scan ~/.claude/projects/ and return session info per project.

    Returns:
        List of dicts:
            {
                "project_dir": str,        # absolute path to the project slug dir
                "project_slug": str,       # directory name under ~/.claude/projects/
                "sessions": [
                    {
                        "session_id": str,
                        "jsonl_path": str,
                        "file_size": int,
                        "last_modified": str,  # ISO-8601
                    },
                    ...
                ]
            }
    """
    results = []

    if not PROJECTS_DIR.exists():
        return results

    for project_dir in sorted(PROJECTS_DIR.iterdir()):
        if not project_dir.is_dir():
            continue

        project_slug = project_dir.name
        sessions = []

        # Each UUID-named .jsonl file is a session conversation log
        for entry in sorted(project_dir.iterdir()):
            if not entry.is_file():
                continue
            if not entry.suffix == ".jsonl":
                continue

            # The stem is the session ID (UUID)
            session_id = entry.stem
            if not _looks_like_uuid(session_id):
                continue

            stat = entry.stat()
            last_modified_ts = datetime.fromtimestamp(
                stat.st_mtime, tz=timezone.utc
            ).isoformat()

            sessions.append(
                {
                    "session_id": session_id,
                    "jsonl_path": str(entry),
                    "file_size": stat.st_size,
                    "last_modified": last_modified_ts,
                }
            )

        results.append(
            {
                "project_dir": str(project_dir),
                "project_slug": project_slug,
                "sessions": sessions,
            }
        )

    return results


async def _detect_active_processes() -> set:
    """Run `ps aux` and return a set of session identifiers for active Claude processes.

    The returned set contains PIDs (as strings) of processes whose command line
    contains "claude".
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "ps", "aux",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        output = stdout.decode("utf-8", errors="replace")
    except Exception:
        return set()

    active_pids: set = set()
    for line in output.splitlines():
        # Filter for lines that mention "claude" but skip our own ps invocation
        lower = line.lower()
        if "claude" not in lower:
            continue
        if "ps aux" in lower:
            continue
        # ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
        parts = line.split(None, 10)
        if len(parts) >= 2:
            pid = parts[1]
            active_pids.add(pid)

    return active_pids


def _determine_status(session_info: dict, active_pids: set) -> str:
    """Determine the status string for a session.

    Returns one of: "active", "idle", "completed", "error".
    """
    # If we can associate this session with a running process consider it active.
    # (A more precise mapping would require parsing the jsonl; here we rely on
    #  recency as a proxy since we cannot easily map PID -> session ID from ps alone.)
    last_modified_str = session_info.get("last_modified")

    if last_modified_str:
        try:
            last_modified = datetime.fromisoformat(last_modified_str)
            age = datetime.now(timezone.utc) - last_modified
            if age < timedelta(minutes=IDLE_THRESHOLD_MINUTES):
                return "active"
            return "idle"
        except (ValueError, TypeError):
            pass

    # Fallback: if active_pids is non-empty there is at least one running Claude,
    # but we cannot tie it to this specific session.
    return "idle"


def _determine_needs_attention(session_info: dict) -> bool:
    """Return True if the session appears to be waiting for user input.

    Heuristic: read the last few lines of the session's JSONL file and check
    for known permission/question event types.
    """
    jsonl_path = session_info.get("jsonl_path")
    if not jsonl_path:
        return False

    path = Path(jsonl_path)
    if not path.exists() or path.stat().st_size == 0:
        return False

    try:
        # Read the tail of the file (last 4096 bytes) to find recent events
        with open(path, "rb") as fh:
            fh.seek(max(0, path.stat().st_size - 4096))
            tail = fh.read().decode("utf-8", errors="replace")

        lines = [l.strip() for l in tail.splitlines() if l.strip()]
        # Examine the last few complete lines
        for raw_line in reversed(lines[-10:]):
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError:
                continue

            event_type = event.get("type", "")
            # Known event types that indicate the agent is waiting
            if event_type in {
                "permission_request",
                "permission_prompt",
                "ask_user",
                "input_required",
                "waiting_for_input",
            }:
                return True

            # Check message content for permission/question patterns
            content = str(event.get("message", "")) + str(event.get("content", ""))
            if any(
                phrase in content.lower()
                for phrase in (
                    "do you want to",
                    "would you like to",
                    "please confirm",
                    "permission",
                    "allow this",
                    "waiting for user",
                )
            ):
                return True

    except (OSError, IOError):
        pass

    return False


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------


_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _looks_like_uuid(value: str) -> bool:
    """Return True if *value* looks like a UUID."""
    return bool(_UUID_RE.match(value))


def _slug_to_path(slug: str) -> str:
    """Convert a project slug (directory name) back to a filesystem path.

    Claude Code encodes project paths by replacing '/' with '-'.
    Example: '-Users-user-projects-myapp' -> '/Users/user/projects/myapp'

    Strategy: recursively try all possible splits, preferring the one that
    produces a valid path on disk. Uses longest-segment-first to handle
    directory names containing hyphens (e.g. 'claude-code-hooks-multi-agent-observability').
    """
    if not slug.startswith("-"):
        return slug

    parts = slug[1:].split("-")  # strip leading '-', split on '-'
    if not parts:
        return slug

    def _rebuild(parts_remaining: list, current_path: str) -> str:
        if not parts_remaining:
            return current_path

        # Try longest possible segment first (all remaining parts joined by '-')
        # then progressively shorter segments
        for take in range(len(parts_remaining), 0, -1):
            segment = "-".join(parts_remaining[:take])
            candidate = current_path + "/" + segment
            rest = parts_remaining[take:]

            if not rest:
                # Last segment — check if full path exists
                if Path(candidate).exists():
                    return candidate
            else:
                # More segments remain — check if this is a valid directory
                if Path(candidate).is_dir():
                    result = _rebuild(rest, candidate)
                    if Path(result).exists():
                        return result

        # Fallback: take one part as a path segment
        return _rebuild(parts_remaining[1:], current_path + "/" + parts_remaining[0])

    return _rebuild(parts, "")


async def _find_existing_session(db, session_id: str) -> Optional[dict]:
    """Return the existing DB row for (source_app='claude-code', session_id) or None."""
    cursor = await db.execute(
        "SELECT id FROM sessions WHERE source_app = ? AND session_id = ?",
        ("claude-code", session_id),
    )
    row = await cursor.fetchone()
    if row is None:
        return None
    return dict(row)
