"""Session lifecycle abstraction — mirrors OC's subagent-registry.ts.

States and transitions for subagent lifecycle management. Pure logic
separated from I/O via Protocol.

This is the OC-patchable layer — our lifecycle state machine can be
wired into OC's subagent-registry.ts via patch.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class LifecycleState(enum.StrEnum):
    """Subagent lifecycle states."""

    CREATED = "created"
    DISPATCHED = "dispatched"
    RUNNING = "running"
    YIELDING = "yielding"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    ABORTED = "aborted"
    ARCHIVED = "archived"


class LifecycleEvent(enum.StrEnum):
    """Events triggering lifecycle transitions."""

    DISPATCH = "dispatch"
    START = "start"
    YIELD = "yield"
    CHILD_DONE = "child_done"
    FINISH = "finish"
    ERROR = "error"
    TIMEOUT = "timeout"
    PARENT_ABORT = "parent_abort"
    ARCHIVE = "archive"


@dataclass(frozen=True)
class SessionSnapshot:
    """Immutable snapshot of a subagent's state."""

    session_key: str
    state: LifecycleState
    spawned_by: str | None = None
    spawn_depth: int = 0
    started_at_ms: int | None = None
    ended_at_ms: int | None = None
    runtime_ms: int | None = None
    status: str | None = None
    aborted: bool = False
    retry_count: int = 0


@dataclass(frozen=True)
class TransitionResult:
    """Result of a lifecycle transition attempt."""

    from_state: LifecycleState
    to_state: LifecycleState
    event: LifecycleEvent
    accepted: bool
    reason: str
    evidence: dict[str, Any] = field(default_factory=dict)


# Transition table: (state, event) → target_state
TRANSITIONS: dict[tuple[LifecycleState, LifecycleEvent], LifecycleState] = {
    (LifecycleState.CREATED, LifecycleEvent.DISPATCH): LifecycleState.DISPATCHED,
    (LifecycleState.DISPATCHED, LifecycleEvent.START): LifecycleState.RUNNING,
    (LifecycleState.RUNNING, LifecycleEvent.YIELD): LifecycleState.YIELDING,
    (LifecycleState.YIELDING, LifecycleEvent.CHILD_DONE): LifecycleState.RUNNING,
    (LifecycleState.RUNNING, LifecycleEvent.FINISH): LifecycleState.COMPLETED,
    (LifecycleState.RUNNING, LifecycleEvent.ERROR): LifecycleState.FAILED,
    (LifecycleState.RUNNING, LifecycleEvent.TIMEOUT): LifecycleState.TIMED_OUT,
    (LifecycleState.DISPATCHED, LifecycleEvent.ERROR): LifecycleState.FAILED,
    (LifecycleState.DISPATCHED, LifecycleEvent.TIMEOUT): LifecycleState.TIMED_OUT,
    (LifecycleState.CREATED, LifecycleEvent.PARENT_ABORT): LifecycleState.ABORTED,
    (LifecycleState.DISPATCHED, LifecycleEvent.PARENT_ABORT): LifecycleState.ABORTED,
    (LifecycleState.RUNNING, LifecycleEvent.PARENT_ABORT): LifecycleState.ABORTED,
    (LifecycleState.YIELDING, LifecycleEvent.PARENT_ABORT): LifecycleState.ABORTED,
    (LifecycleState.COMPLETED, LifecycleEvent.ARCHIVE): LifecycleState.ARCHIVED,
    (LifecycleState.FAILED, LifecycleEvent.ARCHIVE): LifecycleState.ARCHIVED,
    (LifecycleState.TIMED_OUT, LifecycleEvent.ARCHIVE): LifecycleState.ARCHIVED,
    (LifecycleState.ABORTED, LifecycleEvent.ARCHIVE): LifecycleState.ARCHIVED,
}

TERMINAL_STATES = frozenset(
    {
        LifecycleState.COMPLETED,
        LifecycleState.FAILED,
        LifecycleState.TIMED_OUT,
        LifecycleState.ABORTED,
    }
)


def is_terminal(state: LifecycleState) -> bool:
    """Check if a state is terminal."""
    return state in TERMINAL_STATES


def evaluate_transition(
    snapshot: SessionSnapshot,
    event: LifecycleEvent,
) -> TransitionResult:
    """Evaluate whether a lifecycle transition is valid.

    Pure function — no side effects.
    """
    current = snapshot.state

    if current == LifecycleState.ARCHIVED:
        return TransitionResult(
            from_state=current,
            to_state=current,
            event=event,
            accepted=False,
            reason="Subagent is archived — no transitions possible",
        )

    target = TRANSITIONS.get((current, event))
    if target is None:
        return TransitionResult(
            from_state=current,
            to_state=current,
            event=event,
            accepted=False,
            reason=f"No valid transition from {current.value} on {event.value}",
        )

    return TransitionResult(
        from_state=current,
        to_state=target,
        event=event,
        accepted=True,
        reason=f"{current.value} → {target.value} on {event.value}",
    )
