"""Session store abstraction — mirrors OC's session-accessor.ts.

Protocol for persisting session metadata. Implementations can use
SQLite (our registry), JSON (OC's default), or in-memory (tests).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class SessionRecord:
    """Essential session metadata — the fields we care about."""

    session_key: str
    session_id: str | None = None
    status: str | None = None
    model: str | None = None
    spawned_by: str | None = None
    spawn_depth: int = 0
    is_subagent: bool = False
    started_at_ms: int | None = None
    ended_at_ms: int | None = None
    runtime_ms: int | None = None
    aborted: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


class SessionStore(Protocol):
    """Protocol for session persistence — the I/O boundary.

    Implementations:
    - ``MemorySessionStore`` — for unit tests (no I/O)
    - ``SqliteSessionStore`` — for production (our registry.db)
    - ``JsonSessionStore`` — wraps OC's sessions.json (compatibility)
    """

    def get(self, session_key: str) -> SessionRecord | None:
        """Load a session record by key."""
        ...

    def save(self, record: SessionRecord) -> None:
        """Persist a session record."""
        ...

    def delete(self, session_key: str) -> bool:
        """Delete a session record. Returns whether it existed."""
        ...

    def list_active(self) -> list[SessionRecord]:
        """List all sessions with non-terminal status."""
        ...

    def list_subagents(self, parent_key: str | None = None) -> list[SessionRecord]:
        """List subagent sessions, optionally filtered by parent."""
        ...

    def count_active(self) -> int:
        """Count all active (non-terminal) sessions."""
        ...

    def count_children(self, parent_key: str) -> int:
        """Count active children spawned by a parent."""
        ...
