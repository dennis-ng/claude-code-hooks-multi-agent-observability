"""
Observability client for Claude Code hooks.
Posts events to the lightweight observability server via plain HTTP.
No auth, no SDK — just stdlib urllib.
"""

import json
import os
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Optional, Any


def _server_url() -> str:
    """Get the observability server events endpoint URL."""
    return os.environ.get(
        "OBSERVABILITY_SERVER_URL",
        "http://localhost:4000/api/events"
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_dir() -> str:
    """Get project directory from Claude Code env or cwd."""
    return os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())


def send_event(
    event_type: str,
    session_id: str,
    source_app: str,
    name: Optional[str] = None,
    span_id: Optional[str] = None,
    parent_span_id: Optional[str] = None,
    input_data: Optional[Any] = None,
    output_data: Optional[Any] = None,
    metadata: Optional[Any] = None,
    level: str = "DEFAULT",
    timestamp: Optional[str] = None,
):
    """Send a single event to the observability server."""
    payload = {
        "session_id": session_id,
        "project_dir": _project_dir(),
        "source_app": source_app,
        "event_type": event_type,
        "timestamp": timestamp or _now_iso(),
        "level": level,
    }

    if name is not None:
        payload["name"] = name
    if span_id is not None:
        payload["span_id"] = span_id
    if parent_span_id is not None:
        payload["parent_span_id"] = parent_span_id
    if input_data is not None:
        payload["input"] = input_data if isinstance(input_data, (str, dict, list)) else str(input_data)
    if output_data is not None:
        payload["output"] = output_data if isinstance(output_data, (str, dict, list)) else str(output_data)
    if metadata is not None:
        payload["metadata"] = metadata if isinstance(metadata, (str, dict, list)) else str(metadata)

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url=_server_url(),
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        pass  # Silently fail — never block Claude Code
