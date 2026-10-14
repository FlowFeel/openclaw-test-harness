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

The plugin registers five tools with the OpenClaw agent runtime:

### 1. `durable_spawn`
Dispatches a durable task to the worker queue.
- **Parameters:**
  - `task_name` (`string`, required): Name of the registered task (e.g., `agent_step`, `ci_check`, `batch_sync`). Allowlist enforced by the sidecar.
  - `params` (`object`, required): JSON parameters passed to the task worker.
  - `queue` (`string`, optional): Target queue override (defaults to the sidecar's configured queue).
- **Returns:** Verdict and task ID (e.g. `ok: spawned task-8f92b`).

### 2. `durable_status`
Returns a health and queue backlog snapshot across all queues.
- **Parameters:** None (`{}`).
- **Returns:** Current counts for `todo`, `doing`, `failed`, and `succeeded` tasks plus overall health verdict.

### 3. `durable_result`
Fetches the current state and result payload of an existing durable task.
- **Parameters:**
  - `task_id` (`string`, required): Task ID returned from `durable_spawn`.
- **Returns:** Current state (`pending`, `running`, `sleeping`, `completed`, `failed`) and truncated result summary.

### 4. `durable_wait`
Waits server-side inside the sidecar for a task to reach a terminal state (`completed` or `failed`).
- **Parameters:**
  - `task_id` (`string`, required): Task ID to wait on.
  - `timeout_seconds` (`number`, optional): Max wait in seconds (default: 120s, server cap: 600s).
- **Behavior:** The plugin dynamically sets the client HTTP timeout to `(timeout_seconds + 15)` seconds so that network latency or server timeouts are captured before client aborts trigger.
- **Returns:** Terminal state with result summary or `pending` if wait timed out.

### 5. `durable_retry`
Re-dispatches a previously failed or terminated task.
- **Parameters:**
  - `task_id` (`string`, required): Task ID to re-enqueue.
- **Returns:** Re-dispatch status and task ID.

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
