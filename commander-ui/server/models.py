from typing import Optional, Dict, Any
from pydantic import BaseModel


class SessionResponse(BaseModel):
    id: str
    source_app: str
    session_id: str
    project_dir: Optional[str] = None
    status: str
    model: Optional[str] = None
    started_at: str
    last_activity_at: str
    needs_attention: int = 0
    metadata: Optional[Dict[str, Any]] = None
    activity_count: int = 0


class ActivityResponse(BaseModel):
    id: str
    session_id: str
    event_type: str
    summary: Optional[str] = None
    timestamp: str
    metadata: Optional[Dict[str, Any]] = None


class StatsResponse(BaseModel):
    total_sessions: int
    active_sessions: int
    needs_attention_count: int
    sessions_by_status: Dict[str, int]
    sessions_by_project: Dict[str, int]


class StartSessionRequest(BaseModel):
    project_dir: str
    prompt: Optional[str] = None


class ResumeSessionRequest(BaseModel):
    session_id: str
    project_dir: str


class DiscoverResponse(BaseModel):
    discovered: int
    updated: int
    total: int
