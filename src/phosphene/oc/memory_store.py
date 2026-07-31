"""In-memory session store — for unit tests, no I/O required.

Implements SessionStore Protocol with plain dicts.
Zero dependencies, zero fixtures, zero setup.
"""

from __future__ import annotations

from phosphene.oc.store import SessionRecord


class MemorySessionStore:
    """In-memory session store for tests.

    Implements the SessionStore Protocol. No persistence —
    state lives only for the test's lifetime.
    """

    def __init__(self) -> None:
        self._records: dict[str, SessionRecord] = {}

    def get(self, session_key: str) -> SessionRecord | None:
        return self._records.get(session_key)

    def save(self, record: SessionRecord) -> None:
        self._records[record.session_key] = record

    def delete(self, session_key: str) -> bool:
        return self._records.pop(session_key, None) is not None

    def list_active(self) -> list[SessionRecord]:
        active_statuses = {"processing", "running", "created", "dispatched"}
        return [
            r for r in self._records.values() if (r.status or "") in active_statuses
        ]

    def list_subagents(self, parent_key: str | None = None) -> list[SessionRecord]:
        subs = [r for r in self._records.values() if r.is_subagent]
        if parent_key:
            subs = [r for r in subs if r.spawned_by == parent_key]
        return subs

    def count_active(self) -> int:
        return len(self.list_active())

    def count_children(self, parent_key: str) -> int:
        active_statuses = {"processing", "running", "created", "dispatched"}
        return sum(
            1
            for r in self._records.values()
            if r.spawned_by == parent_key
            and r.is_subagent
            and (r.status or "") in active_statuses
        )
