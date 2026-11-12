# DFT Design Review: Plugins v2 Under the Hypothetico-Axiomatic Teleological Vertex

- **Status:** Approved
- **Date:** 2026-11-12
- **Author:** Flow (`@feelingflowingbot`)
- **Reviewer:** Ed Phil (`@edphos`)
- **Target Subsystem:** Plugins v2 Consolidating Architecture (`oc-lane-supervisor`, `oc-task-plane`, `oc-model-nexus`, `oc-memory-nexus`)

---

## 1. Executive Summary

Following live containerized E2E test runs (`tests/e2e/efficiency-energy-bdd-e2e.spec.ts`, `tests/e2e/plugin-boot-gate.spec.ts`, and `tests/e2e/production-sim.spec.ts`), this review evaluates the **Plugins v2 Architecture** against the phosphene **Design for Testability (DFT)** framework, extended by the **Hypothetico-Axiomatic Teleological Vertex**.

The review establishes that testing is not merely an inert regression barrier, but a self-calibrating feedback loop where empirical testbed telemetry dynamically steers runtime incentives and avoids hardcoded constants.

---

## 2. Axiom Audit Matrix (Mechanical Foundation A1–A6)

Verified across all 16 plugin packages via `npm run validate:foundry`:

| Axiom | Requirement | Implementation Status | Evidence / Verification |
|---|---|---|---|
| **A1: Pure Logic / I/O Separation** | `*-logic.ts` imports no Node I/O builtins. File access mediated through protocols. | **PASS** | `efficiency-energy-logic.ts` is 100% pure math/projections. `SessionsReader`/`SessionsWriter` in `oc-session-guard`. |
| **A2: Strict Determinism** | Zero calls to `Date.now()`, `Math.random()`, or `new Date()` in logic files. Time injected as parameters. | **PASS** | `durationMs`, `nowMs`, `p99YieldLatencySec` passed explicitly. |
| **A3: Manifest Conformance** | `openclaw.plugin.json` contracts match registered tools & hooks. | **PASS** | `before_tool_call`, `tool_result_persist`, `agent_end`, `session_health` match bidirectionally. |
| **A4: Structural DFT Docs** | Every source file carries `@dft` or `@invariants` header docblock. | **PASS** | Verified by foundry AST walker. |
| **A5: Real Protocol Doubles** | Stateful in-process doubles used over synthetic `vi.fn()` patchovers. | **PASS** | Real `PluginApi` doubles with actual temp dirs in integration specs. |
| **A6: CheckResult / Mutation Proof** | Mutating/filtering functions return immutable result containers, not `void`. | **PASS** | `applyEnergyAction` returns `TurnEnergyState`; `cleanupSessions` returns `CleanupReport`. |

---

## 3. The Extended Teleological Vertex (A7–A9)

| Axiom | Principle | Implementation & Test Evidence |
|---|---|---|
| **A7: Declarative Definitory Hypotheses** | BDD Gherkin specifications expressing behavioral contracts ($H_1\text{--}H_4$). | `tests/features/plugins-v2-efficiency-energy.feature` and `hypothetico-axiomatic-calibration.feature` (55/55 traceability pass). |
| **A8: Hermetic Containerized Integration** | Real bundled code (`dist/index.js`) executed in production-identical Docker containers. | `tests/e2e/efficiency-energy-bdd-e2e.spec.ts` (4 scenarios pass in 24s against `docker/Dockerfile`). |
| **A9: Empirical Telemetric Feedback** | System telemetry dynamically tunes live economic variables, eliminating magic numbers. | `calibrateEconomicParameters` dynamically lifts advisory thresholds and adjusts rebate/penalty slopes. |

---

## 4. Empirical Modifications Provoked by Containerized E2E Testing

1. **Gating Feedback Inversion:**
   - *Observation:* Emitting hard tool errors on $E \le 0$ provoked OpenClaw's prompt runner into retry loops.
   - *Fix:* Replaced blunt block errors with synthetic soft-landing envelopes (`status: "energy_exhausted"`), cleanly steering the LLM into visible reply synthesis.
2. **Multi-Action Pacing Discount:**
   - *Observation:* Fast, surgical tool bursts were penalized at flat synchronous command rates.
   - *Fix:* Added pacing discount for calls completing under $1.5\text{s}$ with payload $<4\text{KB}$ ($15E \to 5E$).
3. **Dynamic Advisory Buffer Scaling:**
   - *Observation:* Under heavy network latency, $200E$ left insufficient runway for final synthesis.
   - *Fix:* Scaled advisory threshold: $E_{\text{advisory}} = \max(200, 150 + \text{P99} \times 2.5)$ (up to 350E).
4. **Delegation Elasticity Dampener:**
   - *Observation:* Agents could loop subagent spawns to gain infinite turn energy.
   - *Fix:* Clamped energy rebate ($\Delta E = +200E$) to maximum 1 per turn, while maintaining habit points ($+150P$).

---

## 5. Subsystem Consolidation Roadmap (The 4 Domain Engines)

The 16 fragmented extensions consolidate into 4 core engines under `src/plugins/`:

```
┌────────────────────────────────────────────────────────┐
│                   OpenClaw Gateway                     │
└───────────────────────────┬────────────────────────────┘
                            │
   ┌────────────────┬───────┴────────┬────────────────┐
   ▼                ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  oc-lane-    │ │  oc-task-    │ │  oc-model-   │ │  oc-memory-  │
│  supervisor  │ │  plane       │ │  nexus       │ │  nexus       │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

1. **`oc-lane-supervisor`:**
   - Absorbs: `oc-session-guard`, `oc-lane-forecaster`, `oc-topic-worker-pool`, `oc-topic-manager`.
   - Responsibilities: Turn energy budgeting, habit points, soft landing, topic admission, zero-delta compaction, orphan recovery.
2. **`oc-task-plane`:**
   - Absorbs: `oc-task-plane`, `oc-durable-sidecar`, `oc-subagent-orchestrator`, `oc-subagent-watchdog`.
   - Responsibilities: Lock-free async dispatch, durable Postgres reconciliation, timeout propagation, auto-wake loopbacks.
3. **`oc-model-nexus`:**
   - Absorbs: `oc-model-router`, `oc-stream-relay`, `oc-event-loop-monitor`, `oc-context-cache`.
   - Responsibilities: Active failover (schema vs timeout), session override sanity, context cache pre-emption, P99 latency telemetry.
4. **`oc-memory-nexus`:**
   - Absorbs: `oc-compaction-helper`, `oc-memory-recall`, `oc-sidecar`.
   - Responsibilities: In-situ transcript sanitization, successor materialization, off-loop CPU workers, M6 frontmatter validation.
