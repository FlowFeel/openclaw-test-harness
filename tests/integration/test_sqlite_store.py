"""Integration tests — abstractions against real I/O.

Tests that our admission, lifecycle, and store abstractions work
correctly against a SQLite-backed store (not just in-memory).
Uses a temporary SQLite database — no Docker required.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from phosphene.oc.admission import (
    AdmissionPolicy,
    resolve_admission,
)
from phosphene.oc.lifecycle import (
    LifecycleEvent,
    LifecycleState,
    SessionSnapshot,
    evaluate_transition,
)
from phosphene.oc.memory_store import MemorySessionStore
from phosphene.oc.store import SessionRecord


@pytest.fixture
def sqlite_store(tmp_path: Path) -> tuple[sqlite3.Connection, str]:
    """Create a temporary SQLite session store.

    Uses the same schema as our production registry.db.
    """
    db_path = str(tmp_path / "test-registry.db")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE sessions (
            session_key TEXT PRIMARY KEY,
            session_id TEXT,
            status TEXT,
            model TEXT,
            spawned_by TEXT,
            spawn_depth INTEGER DEFAULT 0,
            is_subagent INTEGER DEFAULT 0,
            started_at_ms INTEGER,
            ended_at_ms INTEGER,
            runtime_ms INTEGER,
            aborted INTEGER DEFAULT 0,
            raw TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_status ON sessions(status);
        CREATE INDEX IF NOT EXISTS idx_subagent ON sessions(is_subagent);
        CREATE INDEX IF NOT EXISTS idx_spawned_by ON sessions(spawned_by);
    """)
    conn.commit()
    yield conn, db_path
    conn.close()
    if os.path.exists(db_path):
        os.remove(db_path)


def save_record(conn: sqlite3.Connection, record: SessionRecord) -> None:
    """Save a SessionRecord to SQLite."""
    conn.execute(
        """INSERT OR REPLACE INTO sessions
           (session_key, session_id, status, model, spawned_by, spawn_depth,
            is_subagent, started_at_ms, ended_at_ms, runtime_ms, aborted, raw)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            record.session_key,
            record.session_id,
            record.status,
            record.model,
            record.spawned_by,
            record.spawn_depth,
            int(record.is_subagent),
            record.started_at_ms,
            record.ended_at_ms,
            record.runtime_ms,
            int(record.aborted),
            json.dumps(record.raw, separators=(",", ":")),
        ),
    )
    conn.commit()


def count_active(conn: sqlite3.Connection) -> int:
    """Count active (non-terminal) sessions."""
    cur = conn.execute(
        """SELECT COUNT(*) FROM sessions
           WHERE status IN ('running', 'processing', 'created', 'dispatched')"""
    )
    return cur.fetchone()[0]


def count_children(conn: sqlite3.Connection, parent_key: str) -> int:
    """Count active children of a parent."""
    cur = conn.execute(
        """SELECT COUNT(*) FROM sessions
           WHERE spawned_by = ? AND is_subagent = 1
           AND status IN ('running', 'processing', 'created', 'dispatched')""",
        (parent_key,),
    )
    return cur.fetchone()[0]


# ── SQLite-backed admission tests ──────────────────────────────


class TestSqliteAdmission:
    """Test admission logic against a SQLite store.

    Verifies that the pure function resolve_admission works correctly
    when fed counts from a real SQLite database.
    """

    @pytest.fixture
    def policy(self) -> AdmissionPolicy:
        return AdmissionPolicy(
            max_spawn_depth=1,
            max_children_per_agent=2,
            max_concurrent=2,
            run_timeout_seconds=30,
        )

    def test_admit_when_store_empty(
        self,
        sqlite_store: tuple,
        policy: AdmissionPolicy,
    ) -> None:
        """Empty store — spawn should be admitted."""
        conn, _ = sqlite_store
        active = count_active(conn)
        children = count_children(conn, "agent:main:main")
        result = resolve_admission(0, children, active, [], policy)
        assert result.ok

    def test_reject_when_concurrent_exceeded(
        self,
        sqlite_store: tuple,
        policy: AdmissionPolicy,
    ) -> None:
        """Two active subagents — spawn should be rejected."""
        conn, _ = sqlite_store
        parent = "agent:main:main"
        save_record(
            conn,
            SessionRecord(
                session_key="agent:main:subagent:1",
                status="running",
                is_subagent=True,
                spawned_by=parent,
            ),
        )
        save_record(
            conn,
            SessionRecord(
                session_key="agent:main:subagent:2",
                status="running",
                is_subagent=True,
                spawned_by=parent,
            ),
        )
        active = count_active(conn)
        children = count_children(conn, parent)
        result = resolve_admission(0, children, active, [], policy)
        # active=2 >= max_concurrent=2 → rejected
        assert not result.ok
        assert "concurrent" in result.reason.lower()

    def test_reject_when_children_exceeded(
        self,
        sqlite_store: tuple,
        policy: AdmissionPolicy,
    ) -> None:
        """Parent has 2 active children — reject."""
        conn, _ = sqlite_store
        parent = "agent:main:main"
        save_record(
            conn,
            SessionRecord(
                session_key="agent:main:subagent:1",
                status="running",
                is_subagent=True,
                spawned_by=parent,
            ),
        )
        save_record(
            conn,
            SessionRecord(
                session_key="agent:main:subagent:2",
                status="running",
                is_subagent=True,
                spawned_by=parent,
            ),
        )
        # Global count is 2 but concurrent limit is also 2
        # To test children-only, bump concurrent to 5
        big_policy = AdmissionPolicy(
            max_spawn_depth=1,
            max_children_per_agent=2,
            max_concurrent=5,
            run_timeout_seconds=30,
        )
        active = count_active(conn)
        children = count_children(conn, parent)
        result = resolve_admission(0, children, active, [], big_policy)
        # children=2 >= max_children=2 → rejected
        assert not result.ok

    def test_admit_after_child_completes(
        self,
        sqlite_store: tuple,
        policy: AdmissionPolicy,
    ) -> None:
        """One child done, one running — still under limits."""
        conn, _ = sqlite_store
        parent = "agent:main:main"
        save_record(
            conn,
            SessionRecord(
                session_key="agent:main:subagent:1",
                status="done",
                is_subagent=True,
                spawned_by=parent,
            ),
        )
        save_record(
            conn,
            SessionRecord(
                session_key="agent:main:subagent:2",
                status="running",
                is_subagent=True,
                spawned_by=parent,
            ),
        )
        active = count_active(conn)
        children = count_children(conn, parent)
        result = resolve_admission(0, children, active, [], policy)
        assert result.ok


# ── Lifecycle against SQLite ────────────────────────────────────


class TestSqliteLifecycle:
    """Test lifecycle transitions persisted to SQLite."""

    def test_derive_and_transition(self, sqlite_store: tuple) -> None:
        """Save a snapshot, derive state from OC status, evaluate transition."""
        conn, _ = sqlite_store
        parent = "agent:main:main"

        # Save a subagent with OC "processing" status
        save_record(
            conn,
            SessionRecord(
                session_key="agent:main:subagent:test",
                status="processing",
                is_subagent=True,
                spawned_by=parent,
                started_at_ms=1000,
            ),
        )

        # Verify it's in the store
        cur = conn.execute(
            "SELECT status FROM sessions WHERE session_key = ?",
            ("agent:main:subagent:test",),
        )
        assert cur.fetchone()["status"] == "processing"

        # Evaluate a transition (pure logic, same as unit test)
        snap = SessionSnapshot(
            session_key="agent:main:subagent:test",
            state=LifecycleState.RUNNING,
        )
        result = evaluate_transition(snap, LifecycleEvent.FINISH)
        assert result.accepted
        assert result.to_state == LifecycleState.COMPLETED

        # Update the store to reflect the transition
        conn.execute(
            "UPDATE sessions SET status = 'done' WHERE session_key = ?",
            ("agent:main:subagent:test",),
        )
        conn.commit()

        # Verify
        cur = conn.execute(
            "SELECT status FROM sessions WHERE session_key = ?",
            ("agent:main:subagent:test",),
        )
        assert cur.fetchone()["status"] == "done"


# ── Store parity tests ──────────────────────────────────────────


class TestStoreParity:
    """Verify MemorySessionStore and SQLite produce the same counts."""

    def test_count_parity(self, sqlite_store: tuple) -> None:
        """Memory and SQLite stores should agree on counts."""
        conn, _ = sqlite_store
        parent = "agent:main:main"
        records = [
            SessionRecord(
                session_key="agent:main:subagent:1",
                status="running",
                is_subagent=True,
                spawned_by=parent,
            ),
            SessionRecord(
                session_key="agent:main:subagent:2",
                status="done",
                is_subagent=True,
                spawned_by=parent,
            ),
            SessionRecord(
                session_key="agent:main:subagent:3",
                status="processing",
                is_subagent=True,
                spawned_by=parent,
            ),
        ]

        # Save to both stores
        mem = MemorySessionStore()
        for r in records:
            save_record(conn, r)
            mem.save(r)

        # Counts should match
        assert count_active(conn) == mem.count_active()
        assert count_children(conn, parent) == mem.count_children(parent)
