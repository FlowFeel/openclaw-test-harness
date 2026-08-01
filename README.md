# OpenClaw Test Harness

**A test pyramid and patch harness for OpenClaw modifications — containers, abstractions, and conformance tests built to phosphene axiomatic standards.**

---

## Why This Exists

OpenClaw (OC) is a Node.js application that manages AI agent sessions, subagent spawning, topic fan-out, heartbeat dispatchers, and model provider routing. It is a single-threaded V8 runtime — all session serialization, context compaction, JSON parsing, and stream ingestion happen on one event loop. Under heavy load with multiple active topics and subagent burst cascades, the event loop saturates: P99 delays exceed 800ms, streams stall, and the system becomes unresponsive.

We run OC locally on a managed cloud agent (AgentiMolt). We have been granted development team privileges to modify OC's source code directly. This repo is the engineering discipline around those modifications — a test harness that verifies our patches before they touch production, and abstractions that let us reason about OC's session management without OC running.

The design philosophy is simple: **every modification to OC is proven by a test pyramid before deployment.** No patch ships without passing unit, integration, and E2E layers. The same pure-logic functions that pass in 0.08s against an in-memory store must also pass against a real OC container with patched source.

---

## Design Principles

### 1. Pure Logic / I/O Separation (Phosphene Axiomatic)

Every evaluation function is pure — it takes immutable snapshots, returns result dataclasses, and has no side effects. I/O is behind Protocol interfaces. The same function that decides "should this subagent be timed out?" in a unit test decides it in production against SQLite, and in integration against a real OC container.

This follows the pattern established in:
- **`phosphene.taskflow`** — `StepExecutorInterface` Protocol separates task state transitions from persistence
- **Observatory deploy scripts** — `CheckResult` dataclass carries accepted/rejected + reason + evidence
- **`phosphene.tools.search`** — SQLite repository pattern with builder + repository layers

The principle: **logic is the valuable part. I/O is plumbing. Test the logic exhaustively; test the plumbing once.**

### 2. CheckResult / TransitionResult Pattern

Every decision returns a result object with:
- `accepted: bool` — was the action allowed?
- `reason: str` — human-readable explanation
- `evidence: dict` — the numbers that led to the decision

This is the same pattern used by Observatory's deploy gate checks. It means:
- Tests assert on `accepted` + `reason` (stable, readable)
- Logs include `evidence` (debuggable)
- The function doesn't log or print — the caller decides what to do with the result

### 3. Explicit Transition Table

State transitions are a flat dict mapping `(state, event) → target_state`. Not a switch statement. Not nested if/else. A data table.

```python
TRANSITIONS = {
    (LifecycleState.CREATED, LifecycleEvent.DISPATCH): LifecycleState.DISPATCHED,
    (LifecycleState.RUNNING, LifecycleEvent.FINISH): LifecycleState.COMPLETED,
    ...
}
```

Adding a transition is one line. Inspecting valid transitions is a dict lookup. The anti-pattern this avoids is the "god switch" — one massive function with nested conditionals that nobody can audit by reading.

### 4. Protocol Interfaces for I/O

`SessionStore` and `SpawnAdmission` are `typing.Protocol` classes — structural typing, not inheritance. Any class with the right methods implements them. This means:
- `MemorySessionStore` for unit tests (in-memory dict, zero setup)
- `SqliteSessionStore` for production (our `registry.db`)
- `OcContainerStore` for integration (real OC container, real sessions.json)
- `JsonSessionStore` for compatibility (wraps OC's sessions.json directly)

The unit tests never know which store they're running against. The store is injected, not imported.

### 5. Immutable Snapshots

`SessionSnapshot`, `SessionRecord`, `AdmissionDecision`, `TransitionResult` are all `frozen=True` dataclasses. You cannot accidentally mutate state mid-evaluation. When `apply_transition` produces a new snapshot, it constructs a new instance — the old one is unchanged.

This prevents an entire class of bugs: "the evaluation function modified the state it was evaluating."

---

## Architecture

### Abstractions (`src/phosphene/oc/`)

Each abstraction mirrors a real OC source module. The mapping is explicit:

| Abstraction | OC Source Module | What It Does |
|-------------|-----------------|--------------|
| `admission.py` | `src/agents/child-admission.ts` | Evaluates whether a spawn should be admitted (depth, children, concurrent, timeout guards) |
| `lifecycle.py` | `src/agents/subagent-registry.ts` | State machine for subagent lifecycle (9 states, 9 events, transition table) |
| `store.py` | `src/config/sessions/session-accessor.ts` | Protocol for session persistence (get/save/delete/list/count) |
| `memory_store.py` | — | In-memory store for unit tests (zero I/O) |

#### Spawn Admission (`admission.py`)

OC's `resolveChildAdmission` is a pure function that checks:
- `maxSpawnDepth` — caller's depth vs configured limit
- `maxChildrenPerAgent` — active children for the parent
- `maxTotalPerGroup` (swarm only) — total children across group

Our abstraction extends this with two guards that OC is missing:
- **`maxConcurrent`** — global active subagent count across all parents, not just per-parent. This prevents burst cascades where multiple parents each spawn 2 children simultaneously.
- **`runTimeoutSeconds`** — rejects spawn if any active subagent has exceeded its timeout. This forces cleanup before new work is accepted, preventing the "spawn into a saturated system" anti-pattern.

The guard order is: depth → concurrent → timeout → swarm total → children. Depth is checked first because it's the cheapest (no I/O). Concurrent is checked before children because it's a global invariant (one count query) vs a per-parent query.

#### Lifecycle State Machine (`lifecycle.py`)

Nine states, nine events, explicit transition table:

```
CREATED → DISPATCHED → RUNNING → ┬→ COMPLETED
                                 ├→ FAILED
                                 ├→ TIMED_OUT
                                 └→ ABORTED
                                    → ARCHIVED
```

Terminal states (COMPLETED, FAILED, TIMED_OUT, ABORTED) can only transition to ARCHIVED. ARCHIVED is fully terminal — no transitions out. This prevents "zombie" subagents that come back from archived state.

The transition table is a module-level constant. Tests verify that every (state, event) pair either has a valid transition or is correctly rejected. No hidden paths.

#### Session Store Protocol (`store.py`)

The Protocol defines six methods:
- `get(session_key)` — single record lookup
- `save(record)` — persist a record
- `delete(session_key)` — remove a record
- `list_active()` — all non-terminal sessions
- `list_subagents(parent_key)` — filtered subagent query
- `count_active()` / `count_children(parent_key)` — fast counts

Implementations:
- `MemorySessionStore` — plain dict, for unit tests
- `SqliteSessionStore` — (planned) backed by `registry.db`
- `OcContainerStore` — (planned) backed by real OC container

---

## Test Pyramid

The pyramid has three layers. Each layer tests the same logic against a different I/O boundary.

### Layer 1: Unit Tests (`tests/unit/`)

**What:** Pure logic functions — admission checks, state transitions, memory store operations.

**How:** `MemorySessionStore` (in-memory dict). No Docker, no SQLite, no OC. Zero fixtures.

**Speed:** 19 tests in 0.08s.

**What it proves:**
- `resolve_admission()` correctly accepts/rejects based on depth, concurrent, timeout, children
- `evaluate_transition()` correctly validates all (state, event) pairs
- `MemorySessionStore` correctly stores, retrieves, counts, and filters
- Guard ordering is correct (depth before concurrent before timeout)
- Terminal states can only transition to ARCHIVED
- ARCHIVED rejects all events

**Conformance:** Pure functions, immutable dataclasses, CheckResult pattern, Protocol interfaces. Follows `python-axiomatics` skill standards — `from __future__ import annotations`, strict typing, Google docstrings, `ruff` lint, `pytest` with coverage.

### Layer 2: Integration Tests (`tests/integration/`) — Powered by Testcontainers

**What:** Real-time verification of code modifications and patches applied directly to a running OpenClaw instance.

**How:** Instead of using static, external Docker Compose configurations that are difficult to manage, configure, and teardown across test suites, this project utilizes **Testcontainers**. Testcontainers is an open-source library that allows us to spin up, configure, orchestrate, and stop Docker containers directly from our test code (`Vitest` or `pytest`).

**The Testcontainers Integration Workflow:**
1. **Dynamic Build & Setup**: When the integration test suite starts, the test runner invokes `new GenericContainer("node:22-bookworm-slim")`.
2. **On-the-Fly Patching**: The test runner programmatically mounts or copies our modified source files (such as `patches/child-admission.ts`) directly into the container filesystem, replacing OpenClaw's internal `src/agents/child-admission.ts`.
3. **Isolation and Parallelism**: Testcontainers exposes the container's internal API ports (e.g., port `3000`) and binds them to ephemeral ports on the host system (e.g., `http://localhost:32768`). This ensures multiple tests can run concurrently on the same host or CI runner without port collisions.
4. **Automatic Garbage Collection**: The Ryuk sidecar container runs alongside our test containers. If a test runner crashes, times out, or gets killed, Ryuk ensures all orphaned containers, volumes, and networks are completely destroyed, preventing environment pollution.

**What it proves:**
- Our `maxConcurrent` guard correctly counts active subagents from OC's session store.
- Our `runTimeoutSeconds` guard correctly detects timed-out subagents in real session data.
- The lifecycle state machine correctly derives state from OC's raw status strings.
- Patches to `child-admission.ts` don't break OC's existing spawn admission behavior.

### Layer 3: E2E Tests (`tests/e2e/`) — Powered by Testcontainers

**What:** Full spawn → timeout → archive → cleanup cycle in a container.

**How:** We use Testcontainers to spin up the full OpenClaw container topology (e.g. OpenClaw + SQLite registry sync daemon). The test runner sends API calls to the dynamic OpenClaw endpoints to trigger actions (such as spawning a subagent), manipulates virtual time, and verifies the end-to-end flow.

**What it will prove:**
- The entire pipeline works end-to-end: config → spawn → run → timeout → sweep → archive → registry cleanup.
- The heartbeat correctly calls `sweep_timeouts()` and `sweep_archives()`.
- `sessions.json` is correctly pruned after archival.
- SQLite registry stays in sync with JSON.

---

## OC Patches (`patches/`) — Planned

Versioned diff files against OC source. Each patch is minimal, documented, and tested by the integration layer.

### Planned Patches

1. **`child-admission.maxConcurrent.patch`** — Adds global `maxConcurrent` guard to `resolveChildAdmission` in `src/agents/child-admission.ts`. Counts all active subagents across all parents, not just per-parent children. ~15 lines.

2. **`child-admission.runTimeoutSeconds.patch`** — Adds `runTimeoutSeconds` guard to `resolveChildAdmission`. Rejects spawn if any active subagent has exceeded its timeout. Forces cleanup before new work. ~20 lines.

3. **`session-store.sqlite-backend.patch`** — (Optional, larger) Adds SQLite as an alternative session store backend, replacing the JSON blob. This is a deeper change but would eliminate the event loop pressure at its source.

Each patch file includes:
- The OC version it's tested against (`2026.6.8`, commit `f47542c5`)
- The diff
- The integration test that verifies it
- A rollback note (how to revert if something breaks)

---

## Python Ecosystem Considerations

We considered existing Python state machine libraries:

- **`transitions`** — Popular, but adds a metaclass layer that makes pure-function testing harder. The machine holds state, which violates our "no internal state" principle.
- **`pydantic-model-params`** — Not a state machine library, but its model-based configuration pattern informed our `AdmissionPolicy` design.
- **`xstate` (TypeScript)** — Our TypeScript axiomatics skill uses XState v5 for the dashboard. The pattern (setup → assign → transitions as data) informed our transition table design. But XState is TypeScript; we need Python.

**Decision:** Build our own. The transition table is 18 lines. The guard functions are 40 lines each. A library would add a dependency, a learning curve, and a layer of indirection for something that's already simple. The phosphene pattern is: **logic is pure functions, I/O is Protocol, tests are fixtures-free.** A state machine library that holds internal state breaks this pattern.

---

## Phosphene Standard Conformance

This repo conforms to the phosphene axiomatic standards:

| Standard | How |
|----------|-----|
| Pure logic / I/O separation | All evaluation functions are pure. I/O behind Protocol. |
| CheckResult pattern | `AdmissionDecision` and `TransitionResult` carry accepted/rejected + reason + evidence. |
| Immutable snapshots | `frozen=True` dataclasses everywhere. |
| Open-World Assumption | `SessionRecord.raw` preserves unknown fields. |
| Logic/IO Separation | Pure functions evaluate; Protocol implementations persist. |
| ID-Path Parity | Session keys are the primary identity; store keys map 1:1. |
| Testability | Unit tests run in 0.08s with zero fixtures. |
| Docstrings | Google-style on all public functions and classes. |
| Typing | `from __future__ import annotations` + strict hints. |
| Linting | `ruff` with E, F, I, UP, B, SIM, ANN, RUF rules. |
| Testing | `pytest` with coverage. Coverage is informational, not a gate. |
| Dependencies | `uv` exclusively. No pip. |

---

## Usage

```bash
# Clone
git clone https://github.com/FlowFeel/openclaw-test-harness.git
cd openclaw-test-harness

# Install
uv venv && uv pip install -e ".[dev]"

# Run unit tests
uv run pytest tests/unit/ -v

# Run with coverage
uv run pytest --cov=src/phosphene --cov-report=term-missing

# Lint
uv run ruff check --fix . && uv run ruff format .
```

---

## Repository

- **GitHub:** [FlowFeel/openclaw-test-harness](https://github.com/FlowFeel/openclaw-test-harness)
- **OC version tested against:** `2026.6.8` (commit `f47542c5`)
- **License:** Private (FlowFeel)
- **Owner:** Ed Phil (systems architect)
- **Maintainer:** Flow (feelingflowingbot)

---

## Related

- **`phosphene.sessions`** — The production session registry and lifecycle state machine (in `lib/python/sessions/`)
- **`phosphene.taskflow`** — Multi-step task coordination with the same Protocol + pure logic pattern
- **`phosphene.tools.search`** — SQLite repository pattern that informed our store design
- **Observatory deploy scripts** — CheckResult pattern that informed our admission/lifecycle results
- **OpenClaw source** — Cloned at `work/flow/openclaw-src/` for patch development
