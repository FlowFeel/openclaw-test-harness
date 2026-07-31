"""Unit tests for spawn admission — pure logic, no I/O.

Tests the admission abstraction against OC's child-admission.ts
behavior, plus our extensions (maxConcurrent, runTimeoutSeconds).
"""

from __future__ import annotations

import pytest

from phosphene.oc.admission import (
    AdmissionCap,
    AdmissionPolicy,
    resolve_admission,
)
from phosphene.oc.lifecycle import (
    LifecycleEvent,
    LifecycleState,
    SessionSnapshot,
    evaluate_transition,
    is_terminal,
)
from phosphene.oc.memory_store import MemorySessionStore
from phosphene.oc.store import SessionRecord

# ── Admission tests ────────────────────────────────────────────


class TestResolveAdmission:
    """Test the pure admission function — mirrors OC's resolveChildAdmission."""

    @pytest.fixture
    def policy(self) -> AdmissionPolicy:
        return AdmissionPolicy(
            max_spawn_depth=1,
            max_children_per_agent=2,
            max_concurrent=2,
            run_timeout_seconds=300,
        )

    def test_admit_within_limits(self, policy: AdmissionPolicy) -> None:
        """Spawn should be admitted when all limits are within bounds."""
        result = resolve_admission(0, 0, 0, [], policy)
        assert result.ok

    def test_reject_depth_exceeded(self, policy: AdmissionPolicy) -> None:
        """Spawn should be rejected when caller depth >= max_spawn_depth."""
        result = resolve_admission(1, 0, 0, [], policy)
        assert not result.ok
        assert result.cap == AdmissionCap.MAX_SPAWN_DEPTH
        assert "depth" in result.reason.lower()

    def test_reject_children_exceeded(self, policy: AdmissionPolicy) -> None:
        """Spawn should be rejected when active children >= max."""
        result = resolve_admission(0, 2, 0, [], policy)
        assert not result.ok
        assert result.cap == AdmissionCap.MAX_CHILDREN_PER_AGENT

    def test_reject_global_concurrent_exceeded(self, policy: AdmissionPolicy) -> None:
        """Our extension: reject when global active >= max_concurrent."""
        result = resolve_admission(0, 0, 2, [], policy)
        assert not result.ok
        assert result.cap == AdmissionCap.MAX_CONCURRENT
        assert "concurrent" in result.reason.lower()

    def test_reject_when_timed_out_exists(self, policy: AdmissionPolicy) -> None:
        """Our extension: reject when timed-out subagents haven't been cleaned."""
        result = resolve_admission(0, 0, 0, ["agent:main:subagent:stale"], policy)
        assert not result.ok
        assert result.cap == AdmissionCap.RUN_TIMEOUT_EXCEEDED
        assert "timeout" in result.reason.lower()
        assert "stale" in result.evidence["timed_out"][0]

    def test_depth_checked_before_concurrent(self, policy: AdmissionPolicy) -> None:
        """Depth is the first guard — if exceeded, concurrent doesn't matter."""
        result = resolve_admission(5, 0, 0, [], policy)
        assert result.cap == AdmissionCap.MAX_SPAWN_DEPTH

    def test_concurrent_checked_before_children(self, policy: AdmissionPolicy) -> None:
        """Concurrent is checked before per-parent children."""
        result = resolve_admission(0, 0, 2, [], policy)
        assert result.cap == AdmissionCap.MAX_CONCURRENT

    def test_evidence_includes_all_metrics(self, policy: AdmissionPolicy) -> None:
        """Evidence dict should carry all metrics for debugging."""
        result = resolve_admission(0, 1, 1, [], policy)
        ev = result.evidence
        assert "caller_depth" in ev
        assert "active_children" in ev
        assert "global_active" in ev
        assert "max_spawn_depth" in ev
        assert "max_children_per_agent" in ev
        assert "max_concurrent" in ev


# ── Lifecycle tests ─────────────────────────────────────────────


class TestLifecycleTransitions:
    """Test lifecycle state transitions — pure logic."""

    def test_created_to_dispatched(self) -> None:
        snap = SessionSnapshot("test", LifecycleState.CREATED)
        result = evaluate_transition(snap, LifecycleEvent.DISPATCH)
        assert result.accepted
        assert result.to_state == LifecycleState.DISPATCHED

    def test_running_to_completed(self) -> None:
        snap = SessionSnapshot("test", LifecycleState.RUNNING)
        result = evaluate_transition(snap, LifecycleEvent.FINISH)
        assert result.accepted
        assert result.to_state == LifecycleState.COMPLETED

    def test_running_to_timeout(self) -> None:
        snap = SessionSnapshot("test", LifecycleState.RUNNING)
        result = evaluate_transition(snap, LifecycleEvent.TIMEOUT)
        assert result.accepted
        assert result.to_state == LifecycleState.TIMED_OUT

    def test_archived_rejects_all(self) -> None:
        snap = SessionSnapshot("test", LifecycleState.ARCHIVED)
        for event in LifecycleEvent:
            result = evaluate_transition(snap, event)
            assert not result.accepted

    def test_invalid_transition_rejected(self) -> None:
        snap = SessionSnapshot("test", LifecycleState.COMPLETED)
        result = evaluate_transition(snap, LifecycleEvent.START)
        assert not result.accepted

    def test_terminal_states(self) -> None:
        """Terminal states can only transition to ARCHIVED."""
        terminal = [
            LifecycleState.COMPLETED,
            LifecycleState.FAILED,
            LifecycleState.TIMED_OUT,
            LifecycleState.ABORTED,
        ]
        for state in terminal:
            assert is_terminal(state)
            result = evaluate_transition(
                SessionSnapshot("test", state), LifecycleEvent.ARCHIVE
            )
            assert result.accepted
            assert result.to_state == LifecycleState.ARCHIVED


# ── Memory store tests ──────────────────────────────────────────


class TestMemorySessionStore:
    """Test the in-memory store — implements SessionStore Protocol."""

    def test_save_and_get(self) -> None:
        store = MemorySessionStore()
        record = SessionRecord(
            session_key="agent:main:subagent:test",
            status="running",
            is_subagent=True,
            spawned_by="agent:main:main",
        )
        store.save(record)
        got = store.get("agent:main:subagent:test")
        assert got is not None
        assert got.status == "running"

    def test_delete(self) -> None:
        store = MemorySessionStore()
        store.save(SessionRecord(session_key="test", status="done"))
        assert store.delete("test")
        assert store.get("test") is None

    def test_count_active(self) -> None:
        store = MemorySessionStore()
        store.save(SessionRecord(session_key="a", status="running", is_subagent=True))
        store.save(SessionRecord(session_key="b", status="done", is_subagent=True))
        store.save(
            SessionRecord(
                session_key="c",
                status="processing",
                is_subagent=True,
            )
        )
        assert store.count_active() == 2

    def test_count_children(self) -> None:
        store = MemorySessionStore()
        parent = "agent:main:main"
        store.save(
            SessionRecord(
                session_key="c1",
                status="running",
                is_subagent=True,
                spawned_by=parent,
            )
        )
        store.save(
            SessionRecord(
                session_key="c2",
                status="done",
                is_subagent=True,
                spawned_by=parent,
            )
        )
        store.save(
            SessionRecord(
                session_key="c3",
                status="running",
                is_subagent=True,
                spawned_by=parent,
            )
        )
        assert store.count_children(parent) == 2  # only active

    def test_list_subagents_filtered(self) -> None:
        store = MemorySessionStore()
        parent = "agent:main:main"
        other = "agent:main:telegram:group:-100:topic:1"
        store.save(SessionRecord(session_key="s1", is_subagent=True, spawned_by=parent))
        store.save(SessionRecord(session_key="s2", is_subagent=True, spawned_by=other))
        result = store.list_subagents(parent_key=parent)
        assert len(result) == 1
        assert result[0].session_key == "s1"
