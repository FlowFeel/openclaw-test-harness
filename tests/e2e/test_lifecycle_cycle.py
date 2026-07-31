"""E2E tests — full spawn → timeout → archive cycle.

Tests the complete pipeline using a mock LLM server and the
admission/lifecycle abstractions. No real OC container needed —
these tests verify the abstractions work end-to-end against
a mock provider and SQLite store.
"""

from __future__ import annotations

import json
import sqlite3
import time
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
from phosphene.oc.mock_llm import MockLLMServer
from phosphene.oc.store import SessionRecord


@pytest.fixture
def policy() -> AdmissionPolicy:
    """Test policy with short timeout for fast E2E tests."""
    return AdmissionPolicy(
        max_spawn_depth=1,
        max_children_per_agent=2,
        max_concurrent=2,
        run_timeout_seconds=1,  # 1 second — fast timeout
    )


@pytest.fixture
def sqlite_store(tmp_path: Path) -> tuple[sqlite3.Connection, str]:
    """SQLite session store for E2E tests."""
    db_path = str(tmp_path / "e2e-registry.db")
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
    """)
    conn.commit()
    yield conn, db_path
    conn.close()


def save_record(conn: sqlite3.Connection, record: SessionRecord) -> None:
    """Save a record to SQLite."""
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


class TestSpawnToTimeoutCycle:
    """E2E: spawn a subagent, let it timeout, archive it."""

    def test_full_lifecycle(
        self,
        sqlite_store: tuple,
        policy: AdmissionPolicy,
    ) -> None:
        """Complete lifecycle: spawn → run → timeout → archive."""
        conn, _ = sqlite_store
        parent = "agent:main:main"
        sub_key = "agent:main:subagent:e2e-1"

        # Step 1: Check admission — should pass (empty store)
        result = resolve_admission(0, 0, 0, [], policy)
        assert result.ok, f"Spawn should be admitted: {result.reason}"

        # Step 2: Create subagent (DISPATCHED state)
        started = int(time.time() * 1000)
        save_record(
            conn,
            SessionRecord(
                session_key=sub_key,
                status="processing",
                is_subagent=True,
                spawned_by=parent,
                spawn_depth=1,
                started_at_ms=started,
            ),
        )

        # Step 3: Verify lifecycle is RUNNING
        snap = SessionSnapshot(
            session_key=sub_key,
            state=LifecycleState.RUNNING,
            started_at_ms=started,
        )

        # Step 4: Wait for timeout
        time.sleep(1.5)  # timeout is 1s

        # Step 5: Evaluate timeout transition
        now = int(time.time() * 1000)
        elapsed = now - started
        assert elapsed > 1000, "Should have exceeded timeout"

        timeout_result = evaluate_transition(snap, LifecycleEvent.TIMEOUT)
        assert timeout_result.accepted
        assert timeout_result.to_state == LifecycleState.TIMED_OUT

        # Step 6: Update store — mark as timed out
        conn.execute(
            "UPDATE sessions SET status = 'timeout', "
            "ended_at_ms = ? WHERE session_key = ?",
            (now, sub_key),
        )
        conn.commit()

        # Step 7: Now a new spawn should be blocked (timed-out subagent exists)
        timed_out_keys = [sub_key]
        result = resolve_admission(0, 0, 0, timed_out_keys, policy)
        assert not result.ok, "Spawn should be blocked by timed-out subagent"

        # Step 8: Archive the timed-out subagent
        archived_snap = SessionSnapshot(
            session_key=sub_key,
            state=LifecycleState.TIMED_OUT,
            ended_at_ms=now,
        )
        archive_result = evaluate_transition(archived_snap, LifecycleEvent.ARCHIVE)
        assert archive_result.accepted
        assert archive_result.to_state == LifecycleState.ARCHIVED

        # Step 9: Remove from store (archive = cleanup)
        conn.execute("DELETE FROM sessions WHERE session_key = ?", (sub_key,))
        conn.commit()

        # Step 10: New spawn should now be admitted (no blockers)
        result = resolve_admission(0, 0, 0, [], policy)
        assert result.ok, "Spawn should be admitted after cleanup"


class TestBurstCascadePrevention:
    """E2E: verify that admission prevents burst cascades."""

    def test_concurrent_limit_blocks_burst(
        self,
        sqlite_store: tuple,
        policy: AdmissionPolicy,
    ) -> None:
        """Two subagents running — third spawn blocked by concurrent limit."""
        conn, _ = sqlite_store
        parent = "agent:main:main"

        # Spawn two subagents (at concurrent limit)
        for i in range(2):
            save_record(
                conn,
                SessionRecord(
                    session_key=f"agent:main:subagent:burst-{i}",
                    status="running",
                    is_subagent=True,
                    spawned_by=parent,
                    started_at_ms=int(time.time() * 1000),
                ),
            )

        # Count active
        cur = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE status IN ('running', 'processing')"
        )
        active = cur.fetchone()[0]
        assert active == 2

        # Try to spawn a third — should be blocked
        result = resolve_admission(0, 0, active, [], policy)
        assert not result.ok
        assert "concurrent" in result.reason.lower()

        # Complete one subagent
        conn.execute(
            "UPDATE sessions SET status = 'done' WHERE session_key = ?",
            ("agent:main:subagent:burst-0",),
        )
        conn.commit()

        # Now spawn should be admitted
        cur = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE status IN ('running', 'processing')"
        )
        active = cur.fetchone()[0]
        result = resolve_admission(0, 0, active, [], policy)
        assert result.ok


class TestMockLLMIntegration:
    """Integration test with mock LLM server — verifies streaming works."""

    def test_mock_llm_responds(self) -> None:
        """Mock LLM server should return canned responses."""
        with MockLLMServer(port=9991) as server:
            server.set_response("Hello from mock LLM")

            import urllib.request

            req = urllib.request.Request(
                "http://127.0.0.1:9991/v1/chat/completions",
                data=json.dumps(
                    {
                        "model": "test/model",
                        "messages": [{"role": "user", "content": "Say hello"}],
                        "stream": False,
                    }
                ).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read())
                assert data["choices"][0]["message"]["content"] == "Hello from mock LLM"

    def test_mock_llm_streaming(self) -> None:
        """Mock LLM server should stream SSE chunks."""
        with MockLLMServer(port=9992) as server:
            server.set_response("Hello world", stream=True)

            import urllib.request

            req = urllib.request.Request(
                "http://127.0.0.1:9992/v1/chat/completions",
                data=json.dumps(
                    {
                        "model": "test/model",
                        "messages": [{"role": "user", "content": "Say hello"}],
                        "stream": True,
                    }
                ).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req) as resp:
                body = resp.read().decode()
                assert "data: " in body
                assert "[DONE]" in body
                # Should contain the response text in chunks
                assert "Hello" in body or "world" in body

    def test_mock_llm_health(self) -> None:
        """Mock LLM health endpoint should return 200."""
        with MockLLMServer(port=9993):
            import urllib.request

            with urllib.request.urlopen("http://127.0.0.1:9993/health") as resp:
                assert resp.status == 200
                data = json.loads(resp.read())
                assert data["status"] == "ok"
