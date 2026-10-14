/**
 * OcDurableSidecar — plugin entry point (wiring layer).
 *
 * @behavior
 * Registers five durable proxy tools that talk to the prime-durable sidecar
 * HTTP API on loopback. Every tool: build request (pure seam) → execute
 * (I/O wrapper) → interpret (pure seam) → render as text content.
 * gateway_start fires a sidecar health probe and logs the verdict.
 *
 * @invariants
 * - No logic in this file — wiring only (build → execute → interpret).
 * - Sidecar unreachability is a verdict ("sidecar-down"), never an exception
 *   that blocks the agent run.
 * - The sidecar runs independent of the gateway lifecycle (systemd unit
 *   prime-durable-sidecar); a down sidecar means "check the unit", not
 *   "restart the gateway" (entry-007).
 *
 * @dft
 * - Request building and response interpretation are pure (logic spec).
 * - Wiring tested via integration spec with an injected fetch double.
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import {
  SIDECAR_BASE_URL,
  buildEventRequest,
  buildResultRequest,
  buildRetryRequest,
  buildSpawnRequest,
  buildStatusRequest,
  buildWaitRequest,
  interpret,
  interpretTransportFailure,
  type SidecarRequest,
} from "./durable-sidecar-logic.js";
import { makeHttpFetchJson, type FetchJson } from "./durable-sidecar-io.js";

export interface OcDurableSidecarConfig {
  /** Loopback base URL of the prime-durable sidecar. */
  baseUrl?: string;
  /** Per-call timeout in ms (server-side waits live inside the sidecar). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const SIDECAR_DOC = "Operated by systemd unit prime-durable-sidecar (loopback 18950).";

function text(outcome: { verdict: string; summary: string; detail: Record<string, unknown> }) {
  return {
    content: [{ type: "text" as const, text: `${outcome.verdict}: ${outcome.summary}` }],
  };
}

export default definePluginEntry({
  id: "oc-durable-sidecar",
  name: "OcDurableSidecar",
  description:
    "Durable sidecar proxy tools — spawn/status/result/wait/retry over the prime-durable sidecar HTTP API (loopback 18950)",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as OcDurableSidecarConfig) ?? {};
    const baseUrl = cfg.baseUrl ?? SIDECAR_BASE_URL;
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchJson: FetchJson = makeHttpFetchJson(baseUrl);

    async function execute(request: SidecarRequest) {
      try {
        const response = await fetchJson(request, timeoutMs);
        return text(interpret(response));
      } catch (err) {
        return text(interpretTransportFailure(err));
      }
    }

    // ── Hook: gateway_start ──────────────────────────────────────────
    api.on("gateway_start", async () => {
      try {
        const response = await fetchJson(
          { method: "GET", path: "/health" }, 2_000,
        );
        api.logger?.info?.(
          `[oc-durable-sidecar] sidecar health at gateway start: ${response.status}`,
        );
      } catch (err) {
        api.logger?.warn?.(
          `[oc-durable-sidecar] sidecar unreachable at gateway start ` +
          `(check systemd unit prime-durable-sidecar): ${String(err)}`,
        );
      }
    });

    // ── Tool: durable_spawn ──────────────────────────────────────────
    api.registerTool({
      name: "durable_spawn",
      description:
        "Spawn a durable task on the absurd-backed worker (checkpointed, " +
        "crash-recoverable). Returns a task id. " + SIDECAR_DOC,
      parameters: Type.Object({
        task_name: Type.String({ description: "Registered task name (allowlist enforced by the sidecar)" }),
        params: Type.Object({}, { description: "JSON params passed to the task handler" }),
        queue: Type.Optional(Type.String({ description: "Queue override" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const p = params as { task_name: string; params: Record<string, unknown>; queue?: string };
        return execute(buildSpawnRequest(p.task_name, p.params ?? {}, p.queue));
      },
    });

    // ── Tool: durable_status ──────────────────────────────────────────
    api.registerTool({
      name: "durable_status",
      description:
        "Durable queue status snapshot (todo/doing/failed/succeeded per queue, healthy verdict).",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        return execute(buildStatusRequest());
      },
    });

    // ── Tool: durable_result ──────────────────────────────────────────
    api.registerTool({
      name: "durable_result",
      description: "Fetch the current state/result of a durable task by id.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task id returned by durable_spawn" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return execute(buildResultRequest(String(params.task_id)));
      },
    });

    // ── Tool: durable_wait ──────────────────────────────────────────
    api.registerTool({
      name: "durable_wait",
      description:
        "Wait (server-side, inside the sidecar) for a durable task to reach a " +
        "terminal state — one call instead of a poll loop.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task id returned by durable_spawn" }),
        timeout_seconds: Type.Optional(Type.Number({
          description: "Max server-side wait (default 120s, cap 600s)",
        })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const timeout = typeof params.timeout_seconds === "number"
          ? params.timeout_seconds
          : 120;
        return execute(buildWaitRequest(String(params.task_id), timeout));
      },
    });

    // ── Tool: durable_retry ──────────────────────────────────────────
    api.registerTool({
      name: "durable_retry",
      description: "Re-dispatch a failed durable task by id.",
      parameters: Type.Object({
        task_id: Type.String({ description: "Task id returned by durable_spawn" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return execute(buildRetryRequest(String(params.task_id)));
      },
    });
  },
});
