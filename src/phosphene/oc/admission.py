"""Spawn admission abstraction — mirrors OC's child-admission.ts.

OC's ``resolveChildAdmission`` is a pure function that checks:
- maxSpawnDepth: caller depth vs configured limit
- maxChildrenPerAgent: active children for the parent
- maxTotalPerGroup (swarm only): total children across group

Our abstraction extends this with:
- maxConcurrent: global active subagent count across all parents
- runTimeoutSeconds: reject spawn if any active subagent has exceeded timeout

The Protocol lets us test the admission logic without OC running.
The concrete implementation patches OC's child-admission.ts via diff.
"""

from __future__ import annotations

import enum
import time
from dataclasses import dataclass, field
from typing import Any, Protocol


class AdmissionCap(str, enum.Enum):
    """The governing cap that rejected a spawn."""

    MAX_SPAWN_DEPTH = "subagents.maxSpawnDepth"
    MAX_CHILDREN_PER_AGENT = "subagents.maxChildrenPerAgent"
    MAX_TOTAL_PER_GROUP = "tools.swarm.maxTotalPerGroup"
    MAX_CHILDREN_PER_GROUP = "tools.swarm.maxChildrenPerGroup"
    MAX_CONCURRENT = "subagents.maxConcurrent"
    RUN_TIMEOUT_EXCEEDED = "subagents.runTimeoutSeconds"


@dataclass(frozen=True)
class AdmissionPolicy:
    """Configuration for spawn admission decisions.

    Mirrors OC's config shape with our extensions.
    """

    max_spawn_depth: int = 1
    max_children_per_agent: int = 2
    max_concurrent: int = 2
    run_timeout_seconds: int = 300
    max_total_per_group: int | None = None


@dataclass(frozen=True)
class AdmissionDecision:
    """Result of a spawn admission check.

    Follows the CheckResult pattern — pure data, no side effects.
    ``ok=True`` means the spawn is allowed. ``ok=False`` means rejected,
    with ``cap`` identifying which limit was hit and ``reason`` explaining.
    """

    ok: bool
    cap: AdmissionCap | None = None
    reason: str = ""
    evidence: dict[str, Any] = field(default_factory=dict)


def resolve_admission(
    caller_depth: int,
    active_children: int,
    global_active: int,
    timed_out_subagents: list[str],
    policy: AdmissionPolicy,
    *,
    collect: bool = False,
    total_children: int = 0,
) -> AdmissionDecision:
    """Evaluate whether a spawn should be admitted.

    Pure function — no side effects. This is the abstraction layer over
    OC's ``resolveChildAdmission`` with two additional guards.

    Args:
        caller_depth: Spawn depth of the calling session.
        active_children: Number of active children the caller already has.
        global_active: Total active subagents across all parents.
        timed_out_subagents: Session keys of subagents that exceeded timeout.
        policy: Admission policy configuration.
        collect: Whether this is a swarm collect operation.
        total_children: Total children in the group (swarm only).

    Returns:
        AdmissionDecision with ok/rejected and reason.
    """
    evidence: dict[str, Any] = {
        "caller_depth": caller_depth,
        "active_children": active_children,
        "global_active": global_active,
        "max_spawn_depth": policy.max_spawn_depth,
        "max_children_per_agent": policy.max_children_per_agent,
        "max_concurrent": policy.max_concurrent,
    }

    # Guard 1: maxSpawnDepth (from OC)
    if caller_depth >= policy.max_spawn_depth:
        return AdmissionDecision(
            ok=False,
            cap=AdmissionCap.MAX_SPAWN_DEPTH,
            reason=(
                f"sessions_spawn is not allowed at this depth "
                f"(current: {caller_depth}, max: {policy.max_spawn_depth})"
            ),
            evidence=evidence,
        )

    # Guard 2: maxConcurrent (our extension — global, not per-parent)
    if global_active >= policy.max_concurrent:
        return AdmissionDecision(
            ok=False,
            cap=AdmissionCap.MAX_CONCURRENT,
            reason=(
                f"sessions_spawn has reached global max concurrent "
                f"({global_active}/{policy.max_concurrent})"
            ),
            evidence=evidence,
        )

    # Guard 3: runTimeoutSeconds (our extension — reject if timed-out subs exist)
    if timed_out_subagents:
        return AdmissionDecision(
            ok=False,
            cap=AdmissionCap.RUN_TIMEOUT_EXCEEDED,
            reason=(
                f"sessions_spawn blocked: {len(timed_out_subagents)} subagent(s) "
                f"have exceeded runTimeoutSeconds ({policy.run_timeout_seconds}s) "
                f"and must be cleaned up before spawning"
            ),
            evidence={**evidence, "timed_out": timed_out_subagents},
        )

    # Guard 4: swarm total (from OC, collect mode only)
    if collect and policy.max_total_per_group is not None:
        if total_children >= policy.max_total_per_group:
            return AdmissionDecision(
                ok=False,
                cap=AdmissionCap.MAX_TOTAL_PER_GROUP,
                reason=(
                    f"sessions_spawn reached maxTotalPerGroup "
                    f"({total_children}/{policy.max_total_per_group})"
                ),
                evidence=evidence,
            )

    # Guard 5: maxChildrenPerAgent (from OC)
    if active_children >= policy.max_children_per_agent:
        cap = (
            AdmissionCap.MAX_CHILDREN_PER_GROUP
            if collect
            else AdmissionCap.MAX_CHILDREN_PER_AGENT
        )
        return AdmissionDecision(
            ok=False,
            cap=cap,
            reason=(
                f"sessions_spawn has reached max active children "
                f"({active_children}/{policy.max_children_per_agent})"
            ),
            evidence=evidence,
        )

    return AdmissionDecision(ok=True, evidence=evidence)


class SpawnAdmission(Protocol):
    """Protocol for spawn admission — the I/O boundary.

    The pure function ``resolve_admission`` evaluates. This protocol
    defines how callers fetch the counts and apply the decision.
    """

    def get_caller_depth(self, session_key: str) -> int:
        """Get the spawn depth of the calling session."""
        ...

    def get_active_children(self, parent_key: str) -> int:
        """Count active children spawned by a parent."""
        ...

    def get_global_active_count(self) -> int:
        """Count all active subagents across all parents."""
        ...

    def get_timed_out_subagents(self, timeout_seconds: int) -> list[str]:
        """Get session keys of subagents exceeding the timeout."""
        ...

    def admit(
        self,
        parent_key: str,
        policy: AdmissionPolicy,
    ) -> AdmissionDecision:
        """Full admission check — fetch counts, evaluate, return decision."""
        ...
