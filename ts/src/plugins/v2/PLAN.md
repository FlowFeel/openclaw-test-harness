# Plugins v2: 4 Domain Engines Architecture Plan

- **Branch:** `feat/plugins-v2-four-domain-engines`
- **Specification:** `team/specs/plugins-v2-efficiency-and-energy-spec.md`
- **DFT Review:** `docs/dft-design-review-plugins-v2.md`

## The 4 Consolidated Engines

### 1. `oc-lane-supervisor`
* **Domain:** Topic admission, turn energy budgeting, habit economics, zero-delta compaction, 480s/E soft landing, topic recovery & orphan audit.
* **Consolidates:**
  - `oc-session-guard`
  - `oc-lane-forecaster`
  - `oc-topic-worker-pool`
  - `oc-topic-manager`
* **Tools Exported:**
  - `session_health`
  - `session_cleanup`
  - `lane_forecast`
  - `topic_audit`
  - `topic_recover`
* **Hooks Handled:**
  - `before_dispatch` (topic semaphores & concurrency admission)
  - `before_agent_run` (turn energy initialization, prompt classification)
  - `before_tool_call` (circuit breaker & turn energy gating soft-landing)
  - `tool_result_persist` (pacing discount, zero-delta compaction, energy drain, habit rewards)
  - `before_message_write` (zero-delta frame suppression)
  - `agent_end` (rollup, TES evaluation, EMA tier promotion, rescue alert on empty turn)
  - `subagent_spawning` / `subagent_ended`
  - `after_compaction` / `session_end`

---

### 2. `oc-task-plane`
* **Domain:** Lock-free async dispatch, background subagent orchestration, queueing, durable task plane, postgres reconciliation.
* **Consolidates:**
  - `oc-task-plane`
  - `oc-durable-sidecar`
  - `oc-subagent-orchestrator`
  - `oc-subagent-watchdog`
* **Tools Exported:**
  - `task_dispatch`
  - `task_status`
  - `task_output`
  - `task_cancel`
  - `exec_pipeline`
  - `staging_verify`
  - `subagent_health`
  - `queue_work`
  - `queue_status`
  - `queue_results`
  - `merge_results`
  - `durable_spawn`
  - `durable_status`
  - `durable_result`
  - `durable_tasks`
* **Hooks Handled:**
  - `gateway_start` (start reconciliation supervisor & sidecar connector)
  - `gateway_stop` (clean task drain & pool shutdown)

---

### 3. `oc-model-nexus`
* **Domain:** Active model routing, failover intervention, stream relay, event-loop telemetry, context cache stats.
* **Consolidates:**
  - `oc-model-router`
  - `oc-stream-relay`
  - `oc-event-loop-monitor`
  - `oc-context-cache`
* **Tools Exported:**
  - `model_health`
  - `stream_relay_health`
  - `event_loop_health`
  - `context_cache_stats`
* **Hooks Handled:**
  - `model_call_started`
  - `model_call_ended` (inspect fast schema error bodies vs true timeouts, session override integrity)

---

### 4. `oc-memory-nexus`
* **Domain:** State sanitization, transcript rotation & successor materialization, off-loop CPU sidecar, memory recall registry.
* **Consolidates:**
  - `oc-compaction-helper`
  - `oc-memory-recall`
  - `oc-sidecar`
* **Tools Exported:**
  - `compact_check`
  - `compact_delta`
  - `sanitize_transcript`
  - `sidecar_health`
  - `sidecar_exec`
  - `recall_status`
  - `recall_verify`
  - `recall_catalogue`
* **Hooks Handled:**
  - `gateway_start` (sidecar process boot)
  - `after_tool_call` (M1 telemetry push)
  - `before_agent_reply` (recall injection)
  - `before_compaction`
