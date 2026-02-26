"""Process manager for spawning and tracking Claude Code sessions."""

import asyncio
import logging
import os
from typing import Dict, List, Optional

logger = logging.getLogger("uvicorn.error")

# Module-level dict tracking spawned processes: pid -> process info
_managed_processes: Dict[int, dict] = {}


async def start_session(project_dir: str, prompt: Optional[str] = None) -> dict:
    """Start a new Claude Code session in the specified project directory.

    Args:
        project_dir: Path to the project directory to start the session in.
        prompt: Optional prompt to pass to the Claude Code session.

    Returns:
        dict with pid, project_dir, and status.

    Raises:
        ValueError: If project_dir does not exist.
    """
    if not os.path.isdir(project_dir):
        raise ValueError(f"project_dir does not exist: {project_dir}")

    cmd = ["claude"]
    if prompt:
        cmd.append(prompt)

    logger.info(f"Starting claude session in {project_dir!r} with cmd={cmd}")

    process = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=project_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    pid = process.pid
    _managed_processes[pid] = {
        "pid": pid,
        "project_dir": project_dir,
        "status": "started",
        "session_id": None,
        "process": process,
    }

    logger.info(f"Started claude session pid={pid} in {project_dir!r}")

    return {
        "pid": pid,
        "project_dir": project_dir,
        "status": "started",
    }


async def resume_session(session_id: str, project_dir: str) -> dict:
    """Resume an existing Claude Code session.

    Args:
        session_id: The session ID to resume.
        project_dir: Path to the project directory to run the session in.

    Returns:
        dict with pid, session_id, project_dir, and status.

    Raises:
        ValueError: If project_dir does not exist.
    """
    if not os.path.isdir(project_dir):
        raise ValueError(f"project_dir does not exist: {project_dir}")

    cmd = ["claude", "--resume", session_id]

    logger.info(f"Resuming claude session {session_id!r} in {project_dir!r}")

    process = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=project_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    pid = process.pid
    _managed_processes[pid] = {
        "pid": pid,
        "project_dir": project_dir,
        "status": "resumed",
        "session_id": session_id,
        "process": process,
    }

    logger.info(f"Resumed claude session {session_id!r} pid={pid} in {project_dir!r}")

    return {
        "pid": pid,
        "session_id": session_id,
        "project_dir": project_dir,
        "status": "resumed",
    }


def list_managed_processes() -> List[dict]:
    """Return a list of processes started by this manager with their status.

    Returns:
        List of dicts containing process info (excluding the raw process object).
    """
    result = []
    for pid, info in _managed_processes.items():
        process = info.get("process")
        # Determine current status: check if process has exited
        if process is not None and process.returncode is not None:
            current_status = "exited"
        else:
            current_status = info.get("status", "unknown")

        entry = {
            "pid": info["pid"],
            "project_dir": info["project_dir"],
            "status": current_status,
            "session_id": info.get("session_id"),
        }
        result.append(entry)
    return result
