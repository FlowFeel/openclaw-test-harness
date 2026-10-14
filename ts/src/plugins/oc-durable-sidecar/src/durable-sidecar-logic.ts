/**
 * OcDurableSidecar — pure logic seam.
 *
 * @behavior
 * Pure request construction and response interpretation for the five durable
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

export interface SpawnParams {
  task_name: string;
  params: Record<string, unknown>;
  queue?: string;
}

export function buildSpawnRequest(
  taskName: string,
  params: Record<string, unknown>,
  queue?: string,
): SidecarRequest {
  const body: Record<string, unknown> = { task_name: taskName, params };
  if (queue !== undefined) body.queue = queue;
  return { method: "POST", path: "/spawn", body };
}

export function buildResultRequest(taskId: string): SidecarRequest {
  return { method: "GET", path: `/task/${taskId}` };
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

export function buildRetryRequest(taskId: string): SidecarRequest {
  return { method: "POST", path: `/task/${taskId}/retry` };
}

export function buildStatusRequest(): SidecarRequest {
  return { method: "GET", path: "/status" };
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

/** Classify a sidecar response into a tool verdict (pure). */
export function interpret(response: SidecarResponse): ToolOutcome {
  if (response.status === 200 || response.status === 202) {
    const state = typeof response.body.state === "string" ? response.body.state : undefined;
    let verdict: ToolVerdict = "ok";
    if (state === "pending" || state === "running" || state === "sleeping") {
      verdict = "pending";
    } else if (state === "failed" || state === "error" || state === "cancelled") {
      verdict = "failed";
    }
    return { verdict, summary: summarize(response.body), detail: response.body };
  }
  if (response.status === 400) {
    return { verdict: "rejected", summary: String(response.body.error ?? "rejected"), detail: response.body };
  }
  if (response.status === 404) {
    return { verdict: "failed", summary: String(response.body.error ?? "not found"), detail: response.body };
  }
  return { verdict: "failed", summary: `sidecar ${response.status}`, detail: response.body };
}

/** Interpret a transport failure (sidecar unreachable) — pure. */
export function interpretTransportFailure(err: unknown): ToolOutcome {
  return {
    verdict: "sidecar-down",
    summary: `sidecar unreachable: ${String(err)}`,
    detail: {},
  };
}

function summarize(body: Record<string, unknown>): string {
  if (typeof body.task_id === "string" && body.state === undefined) {
    return `spawned ${body.task_id}`;
  }
  if (typeof body.state === "string") {
    const tail = typeof body.result === "object" && body.result !== null
      ? JSON.stringify(body.result).slice(0, 200)
      : "";
    return `state=${body.state}${tail ? ` result=${tail}` : ""}`;
  }
  if (body.healthy !== undefined) {
    return `queues healthy=${String(body.healthy)} doing=${String(body.doing)}`;
  }
  return JSON.stringify(body).slice(0, 200);
}
