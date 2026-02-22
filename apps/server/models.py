from pydantic import BaseModel, Field
from typing import Optional, Any, List
from datetime import datetime


class EventCreate(BaseModel):
    session_id: str
    project_dir: str
    source_app: str
    event_type: str
    timestamp: str
    span_id: Optional[str] = None
    parent_span_id: Optional[str] = None
    name: Optional[str] = None
    input: Optional[Any] = None
    output: Optional[Any] = None
    metadata: Optional[Any] = None
    level: str = "DEFAULT"


class EventResponse(BaseModel):
    id: str
    session_id: str
    project_id: str
    event_type: str
    timestamp: str
    span_id: Optional[str] = None
    parent_span_id: Optional[str] = None
    name: Optional[str] = None
    input: Optional[Any] = None
    output: Optional[Any] = None
    metadata: Optional[Any] = None
    level: str = "DEFAULT"
    duration_ms: Optional[int] = None
    created_at: str


class SessionResponse(BaseModel):
    id: str
    project_id: str
    source_app: str
    model: Optional[str] = None
    agent_type: Optional[str] = None
    started_at: str
    ended_at: Optional[str] = None
    event_count: int = 0
    metadata: Optional[Any] = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    created_at: str
    session_count: int = 0


class StatsResponse(BaseModel):
    total_events: int
    total_sessions: int
    total_projects: int
    events_today: int
    events_by_type: dict
    recent_sessions: list
