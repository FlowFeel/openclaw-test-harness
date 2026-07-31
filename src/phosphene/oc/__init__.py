"""OC abstractions — Protocol interfaces over OC internals.

These abstractions let us test modifications to OC's session management
without OC running. Each abstraction mirrors a real OC module:

- ``SpawnAdmission`` → mirrors ``src/agents/child-admission.ts``
- ``SessionLifecycle`` → mirrors ``src/agents/subagent-registry.ts``
- ``SessionStore`` → mirrors ``src/config/sessions/session-accessor.ts``

The test pyramid verifies:
1. **Unit**: Pure logic functions — admission checks, state transitions
2. **Integration**: Abstractions against a real OC container (patched)
3. **E2E**: Full spawn → timeout → archive → cleanup cycle in a container
"""

from __future__ import annotations

from .admission import AdmissionDecision, AdmissionPolicy, SpawnAdmission
from .lifecycle import (
    LifecycleEvent,
    LifecycleState,
    SessionSnapshot,
    TransitionResult,
)
from .store import SessionRecord, SessionStore

__all__ = [
    "AdmissionDecision",
    "AdmissionPolicy",
    "SpawnAdmission",
    "LifecycleEvent",
    "LifecycleState",
    "SessionSnapshot",
    "TransitionResult",
    "SessionRecord",
    "SessionStore",
]
