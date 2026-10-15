# OcDurableSidecar Plugin (`@flowfeel/oc-durable-sidecar`)

OpenClaw proxy plugin for durable workflow execution over the `prime-durable` HTTP sidecar API on loopback (`http://127.0.0.1:18950`).

---

## Overview

The `oc-durable-sidecar` plugin gives all OpenClaw agents in every channel/topic durable execution capabilities:
- **Durable Tasks:** Spawns asynchronous, checkpointed, crash-recoverable tasks backed by the absurd/SQLite task engine.
- **Server-Side Wait:** Allows agents to block for task completion server-side (`durable_wait`) instead of wasting LLM turns and prompt tokens in client-side polling loops.
- **Lifecycle Independence (Entry-007):** The sidecar runs as a separate systemd unit (`prime-durable-sidecar.service`). The OpenClaw gateway connects over loopback HTTP. If the sidecar is unreachable, the plugin returns a structured `sidecar-down` verdict instead of crashing or blocking the gateway.

---

## Proxy Tools

The plugin registers seven tools with the OpenClaw agent runtime:

### 1. `durable_tasks`
Lists registered durable task types, their parameter schemas, and subscribed queues.
- **Parameters:**
  - `task_name` (`string`, optional): Specific task name to inspect.
- **Returns:** Formatted list of registered tasks and schema definitions for dynamic discovery.

### 2. `durable_spawn`
Dispatches a durable task to the worker queue.
- **Parameters:**
  - `task_name` (`string`, required): Name of the registered task (e.g., `agent_step`, `ci_check`, `batch_sync`). Allowlist enforced by the sidecar.
  - `params` (`object`, required): JSON parameters passed to the task worker.
  - `queue` (`string`, optional): Target queue override (defaults to the sidecar's configured queue).
- **Returns:** Verdict and task ID (e.g. `ok: spawned task-8f92b`). On allowlist rejection (HTTP 400), includes allowed task names and parameter schemas.

### 3. `durable_status`
Returns a health and queue backlog snapshot across all queues.
- **Parameters:** None (`{}`).
- **Returns:** Current counts for `todo`, `doing`, `failed`, and `succeeded` tasks plus queue breakdowns and overall health verdict.

### 4. `durable_result`
Fetches the current state, progress heartbeat, full result payload, and artifact pointers of an existing durable task.
- **Parameters:**
  - `task_id` (`string`, required): Task ID returned from `durable_spawn`.
  - `max_bytes` (`number`, optional): Max payload bytes to return (default: `8192`).
  - `tail_lines` (`number`, optional): Optional line limit for `output_tail`.
- **Returns:** Full output tail (not capped at 200 chars), step heartbeat status, and enumerated `artifacts` paths.

### 5. `durable_wait`
Waits server-side inside the sidecar for a task to reach a terminal state (`completed` or `failed`).
- **Parameters:**
  - `task_id` (`string`, required): Task ID to wait on.
  - `timeout_seconds` (`number`, optional): Max wait in seconds (default: 120s, server cap: 600s).
- **Behavior:** The plugin dynamically sets the client HTTP timeout to `(timeout_seconds + 15)` seconds so that network latency or server timeouts are captured before client aborts trigger.
- **Returns:** Terminal state with concise 200-char status summary or `pending` if wait timed out.

### 6. `durable_retry`
Re-dispatches a previously failed or terminated task.
- **Parameters:**
  - `task_id` (`string`, required): Task ID to re-enqueue.
  - `resume` (`boolean`, optional): If `true` (default), preserves existing checkpoints and resumes from the last completed step; if `false`, re-executes cleanly from scratch.
- **Returns:** Re-dispatch status and task ID.

### 7. `durable_list`
Lists recent durable task executions across all queues for crash recovery and audit.
- **Parameters:**
  - `task_name` (`string`, optional): Filter by task name (e.g. `agent_step`).
  - `state` (`string`, optional): Filter by `pending`, `running`, `completed`, or `failed`.
  - `since` (`string`, optional): Filter by ISO timestamp or relative duration (e.g. `1h`, `24h`).
  - `limit` (`number`, optional): Max tasks to list (default: `20`, max: `100`).
- **Returns:** List of recent run IDs, states, timestamps, and execution summaries.

---

## Production Worked Example: Durable Rebuild & Verify Pattern

To avoid unrecoverable state loss during delivery disruptions (the October 11 incident pattern):

1. **State Store:** Use SQLite/absurd inside the durable task rather than ephemeral in-memory state.
2. **Boundary:** Pass JSON only at the input/output boundary (`prompt`, `params`).
3. **Artifact Pointers:** For large outputs, write artifacts to disk (e.g. `ingest_verification.json`) and return an artifact pointer in the result payload:
   ```json
   {
     "status": "completed",
     "output_tail": "Checked 142 links. All 142 valid. Verification green.",
     "artifacts": [
       "/data/openclaw/sessions/01a14066/ingest_verification.json"
     ]
   }
   ```
4. **Agent Turn Workflow:**
   ```
   1. durable_tasks()
      ↳ lists available tasks, discovers agent_step schema
   2. durable_spawn("agent_step", { prompt: "Rebuild link history", cwd: "/app" })
      ↳ task_id: 01a14066-2c31-7cdc-8e48-f7e4a53d095b
   3. durable_wait("01a14066-2c31-7cdc-8e48-f7e4a53d095b", 300)
      ↳ ok: state=completed
   4. durable_result("01a14066-2c31-7cdc-8e48-f7e4a53d095b")
      ↳ state=completed (heartbeat: 2026-10-15T10:04:10Z)
        result: { exit_code: 0, output_tail: "Checked 142 links..." }
        artifacts: ["/data/openclaw/sessions/01a14066/ingest_verification.json"]
   ```

---

## Lifecycle Hooks

### `gateway_start`
On gateway boot, fires a non-blocking `GET /health` probe against `baseUrl` (2-second timeout):
- **Healthy:** Logs `[oc-durable-sidecar] sidecar health at gateway start: 200`.
- **Unreachable:** Logs a warning pointing to `prime-durable-sidecar.service` without aborting gateway boot.

---

## Configuration

In `openclaw.json` (or plugin configuration):

```json
{
  "plugins": {
    "entries": {
      "oc-durable-sidecar": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:18950",
          "timeoutMs": 180000
        }
      }
    }
  }
}
```

- `baseUrl` (`string`, default: `http://127.0.0.1:18950`): Loopback endpoint of `prime-durable-sidecar`.
- `timeoutMs` (`number`, default: `180000`): Default HTTP client timeout for non-wait endpoints.

---

## Verdict Semantics

The plugin formats all responses into a standardized outcome line: `<verdict>: <summary>`:

| Verdict | Meaning |
|---|---|
| `ok` | Task spawned successfully, queue healthy, or task completed normally. |
| `pending` | Task is currently queued, running, sleeping, or a server-side wait timed out. |
| `failed` | Task failed execution (`state: "failed"` / `"error"`) or HTTP 404 / 500 returned. |
| `rejected` | HTTP 400 validation rejection (e.g., unknown task name). |
| `sidecar-down` | Sidecar process is unreachable (connection refused, network timeout, or AbortError). |

---

## Build & Packaging

Build the self-contained esbuild bundle:
```bash
cd ts
npm run build:plugins
```

Package into a distributable `.tgz` archive:
```bash
npm run pack:plugins
# Emits ts/dist-plugins/flowfeel-oc-durable-sidecar-0.1.0.tgz
```

Run tests:
```bash
npm test -- src/plugins/oc-durable-sidecar
```
