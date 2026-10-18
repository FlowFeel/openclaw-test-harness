/**
 * OcDurableSidecar — pure logic seam.
 *
 * @behavior
 * Pure request construction and response interpretation for the durable
 * proxy tools. Fetch is NEVER called here — the io layer executes requests
 * built by this module, and interpretation functions classify responses.
 *
 * @invariants
 * - Every function is pure: same input → same output, no side effects.
 * - No imports of I/O modules (node:fs, node:http, fetch). No Date.now().
 * - Request builders are total: any valid tool input maps to one request.
 *
 * @dft
 * - Tested in durable-sidecar-logic.spec.ts with inline data, zero fixtures.
 */

export const SIDECAR_BASE_URL = "http://127.0.0.1:18950";

export interface SidecarRequest {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

export interface SidecarResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface NotifySpec {
  url?: string;
  session_key?: string;
  gateway_url?: string;
  token?: string;
  custom_message?: string;
}

export interface SpawnParams {
  task_name: string;
  params: Record<string, unknown>;
  queue?: string;
  notify?: NotifySpec;
}

export interface ListFilters {
  task_name?: string;
  state?: string;
  since?: string;
  limit?: number;
}

export interface ResultOptions {
  maxBytes?: number;
  tailLines?: number;
}

export interface TaskDefinition {
  name: string;
  description?: string;
  queue?: string;
  params_schema?: Record<string, unknown>;
}

export interface RunSummary {
  task_id: string;
  task_name: string;
  state: string;
  queue?: string;
  created_at?: string;
  finished_at?: string;
  summary?: string;
}

export function buildSpawnRequest(
  taskName: string,
  params: Record<string, unknown>,
  queue?: string,
  notify?: NotifySpec,
): SidecarRequest {
  const body: Record<string, unknown> = { task_name: taskName, params };
  if (queue !== undefined) body.queue = queue;
  if (notify !== undefined) body.notify = notify;
  return { method: "POST", path: "/spawn", body };
}

export function buildResultRequest(taskId: string, opts?: ResultOptions): SidecarRequest {
  const params: string[] = [];
  if (opts?.maxBytes !== undefined) params.push(`max_bytes=${encodeURIComponent(opts.maxBytes)}`);
  if (opts?.tailLines !== undefined) params.push(`tail_lines=${encodeURIComponent(opts.tailLines)}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return { method: "GET", path: `/task/${taskId}${query}` };
}

export function buildWaitRequest(
  taskId: string,
  timeoutSeconds: number,
): SidecarRequest {
  return {
    method: "POST",
    path: `/task/${taskId}/wait`,
    body: { timeout_seconds: timeoutSeconds },
  };
}

export function buildRetryRequest(taskId: string, resume = true): SidecarRequest {
  return { method: "POST", path: `/task/${taskId}/retry`, body: { resume } };
}

export function buildStatusRequest(): SidecarRequest {
  return { method: "GET", path: "/status" };
}

export function buildTasksRequest(taskName?: string): SidecarRequest {
  const query = taskName ? `?name=${encodeURIComponent(taskName)}` : "";
  return { method: "GET", path: `/tasks${query}` };
}

export function buildListRequest(filters?: ListFilters): SidecarRequest {
  const params: string[] = [];
  if (filters?.task_name) params.push(`task_name=${encodeURIComponent(filters.task_name)}`);
  if (filters?.state) params.push(`state=${encodeURIComponent(filters.state)}`);
  if (filters?.since) params.push(`since=${encodeURIComponent(filters.since)}`);
  if (filters?.limit !== undefined) params.push(`limit=${encodeURIComponent(filters.limit)}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return { method: "GET", path: `/tasks/runs${query}` };
}

export function buildEventRequest(
  eventName: string,
  payload?: Record<string, unknown>,
): SidecarRequest {
  return { method: "POST", path: `/event/${eventName}`, body: { payload } };
}

export type ToolVerdict = "ok" | "pending" | "failed" | "sidecar-down" | "rejected";

export interface ToolOutcome {
  verdict: ToolVerdict;
  summary: string;
  detail: Record<string, unknown>;
}

export interface InterpretOptions {
  mode?: "result" | "tasks" | "list" | "default";
  maxBytes?: number;
}

/** Classify a sidecar response into a tool verdict (pure). */
export function interpret(
  response: SidecarResponse,
  options?: InterpretOptions,
): ToolOutcome {
  if (response.status === 200 || response.status === 202) {
    const state = typeof response.body.state === "string" ? response.body.state : undefined;
    let verdict: ToolVerdict = "ok";
    if (state === "pending" || state === "running" || state === "sleeping") {
      verdict = "pending";
    } else if (state === "failed" || state === "error" || state === "cancelled") {
      verdict = "failed";
    }
    return {
      verdict,
      summary: summarize(response.body, options),
      detail: response.body,
    };
  }
  if (response.status === 400) {
    const error = String(response.body.error ?? "rejected");
    let summary = error;
    if (Array.isArray(response.body.allowed_tasks) && response.body.allowed_tasks.length > 0) {
      const allowed = response.body.allowed_tasks.join(", ");
      summary = `${error}. Allowed tasks: [${allowed}]`;
      if (response.body.suggestion) {
        summary += ` (${response.body.suggestion})`;
      }
    }
    return { verdict: "rejected", summary, detail: response.body };
  }
  if (response.status === 404) {
    return { verdict: "failed", summary: String(response.body.error ?? "not found"), detail: response.body };
  }
  return { verdict: "failed", summary: `sidecar ${response.status}`, detail: response.body };
}

export function interpretTasks(response: SidecarResponse): ToolOutcome {
  return interpret(response, { mode: "tasks" });
}

export function interpretList(response: SidecarResponse): ToolOutcome {
  return interpret(response, { mode: "list" });
}

export function interpretResult(
  response: SidecarResponse,
  opts?: ResultOptions,
): ToolOutcome {
  return interpret(response, { mode: "result", maxBytes: opts?.maxBytes });
}

/** Interpret a transport failure (sidecar unreachable) — pure. */
export function interpretTransportFailure(err: unknown): ToolOutcome {
  return {
    verdict: "sidecar-down",
    summary: `sidecar unreachable: ${String(err)}`,
    detail: {},
  };
}

function summarize(
  body: Record<string, unknown>,
  options?: InterpretOptions,
): string {
  if (options?.mode === "tasks" || Array.isArray(body.tasks)) {
    const tasks = Array.isArray(body.tasks) ? (body.tasks as TaskDefinition[]) : [];
    if (tasks.length === 0) return "no tasks registered";
    const lines = tasks.map((t) => {
      const q = t.queue ? ` [queue: ${t.queue}]` : "";
      const desc = t.description ? ` — ${t.description}` : "";
      const schema = t.params_schema ? ` (params: ${JSON.stringify(t.params_schema)})` : "";
      return `- ${t.name}${q}${desc}${schema}`;
    });
    return `tasks registered (${tasks.length}):\n${lines.join("\n")}`;
  }

  if (options?.mode === "list" || Array.isArray(body.runs)) {
    const runs = Array.isArray(body.runs) ? (body.runs as RunSummary[]) : [];
    if (runs.length === 0) return "no recent runs found";
    const lines = runs.map((r) => {
      const sum = r.summary ? `: ${r.summary}` : "";
      return `- ${r.task_id} (${r.task_name}) [${r.state}]${sum}`;
    });
    return `recent runs (${runs.length}):\n${lines.join("\n")}`;
  }

  if (typeof body.task_id === "string" && body.state === undefined) {
    return `spawned ${body.task_id}`;
  }

  if (typeof body.state === "string") {
    let progress = "";
    if (typeof body.last_progress_at === "string") {
      progress = ` (heartbeat: ${body.last_progress_at}`;
      if (typeof body.progress_message === "string") {
        progress += ` - ${body.progress_message}`;
      }
      progress += ")";
    }

    if (options?.mode === "result") {
      const maxBytes = options.maxBytes ?? 8192;
      let resultText = "";
      if (typeof body.result === "object" && body.result !== null) {
        resultText = JSON.stringify(body.result, null, 2);
        if (resultText.length > maxBytes) {
          resultText = `${resultText.slice(0, maxBytes)}... [truncated at ${maxBytes} bytes]`;
        }
      }
      const artifacts = Array.isArray((body.result as Record<string, unknown> | undefined)?.artifacts)
        ? `\nartifacts: ${JSON.stringify((body.result as Record<string, unknown>).artifacts)}`
        : "";
      return `state=${body.state}${progress}${resultText ? `\nresult:\n${resultText}` : ""}${artifacts}`;
    }

    // Default compact summary (wait / status) caps at 200 chars
    const tail = typeof body.result === "object" && body.result !== null
      ? JSON.stringify(body.result).slice(0, 200)
      : "";
    return `state=${body.state}${progress}${tail ? ` result=${tail}` : ""}`;
  }

  if (body.healthy !== undefined) {
    let queueInfo = "";
    if (typeof body.queues === "object" && body.queues !== null) {
      const qEntries = Object.entries(body.queues as Record<string, Record<string, unknown>>);
      if (qEntries.length > 0) {
        queueInfo = ` queues: ${qEntries.map(([name, stats]) => `${name}(doing=${stats.doing ?? 0})`).join(", ")}`;
      }
    }
    return `queues healthy=${String(body.healthy)} doing=${String(body.doing)}${queueInfo}`;
  }

  return JSON.stringify(body).slice(0, 200);
}
