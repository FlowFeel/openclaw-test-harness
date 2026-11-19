/**
 * Durable Proxy Slice Adapter — binds all 7 durable_* tools via injectable FetchJson Protocol.
 *
 * @invariants
 * - Owns only DurableProxyState; all HTTP access mediated via FetchJson (Axiom A5).
 *
 * @dft
 * - Tested via oc-task-plane integration & manifest specs.
 */

import { Type, type PluginApi } from "../../../../../shared/types.js";
import {
  buildSpawnRequest,
  buildStatusRequest,
  buildResultRequest,
  buildWaitRequest,
  buildRetryRequest,
  buildTasksRequest,
  buildListRequest,
  type SidecarRequest,
  type NotifySpec,
  type ListFilters,
} from "../../durable-sidecar-logic.js";
import { makeHttpFetchJson, type FetchJson } from "../../durable-sidecar-io.js";
import { createDurableProxyState, type DurableProxyConfig } from "./state.js";
import { recordDurableOutcome } from "./logic.js";

export function bindDurableProxySlice(
  api: PluginApi,
  config: DurableProxyConfig,
  fetchJson?: FetchJson,
): void {
  let state = createDurableProxyState();
  const fetcher: FetchJson = fetchJson ?? makeHttpFetchJson(config.sidecarBaseUrl);

  async function executeDurable(req: SidecarRequest) {
    try {
      const response = await fetcher(req, config.sidecarTimeoutMs);
      const res = recordDurableOutcome(state, response);
      state = res.nextState;
      return { content: [{ type: "text" as const, text: res.text }] };
    } catch (err) {
      const res = recordDurableOutcome(state, undefined, err);
      state = res.nextState;
      return { content: [{ type: "text" as const, text: res.text }] };
    }
  }

  api.registerTool({
    name: "durable_spawn",
    description: "Spawn a durable background task via PostgreSQL sidecar.",
    parameters: Type.Object({
      task_name: Type.String(),
      params: Type.Optional(Type.Any()),
      queue: Type.Optional(Type.String()),
      notify: Type.Optional(Type.Any()),
    }),
    execute: (_id, p) => {
      const rawParams =
        p.params && typeof p.params === "object" ? (p.params as Record<string, unknown>) : {};
      return executeDurable(
        buildSpawnRequest(
          String(p.task_name ?? ""),
          rawParams,
          typeof p.queue === "string" ? p.queue : undefined,
          p.notify as NotifySpec | undefined,
        ),
      );
    },
  });

  api.registerTool({
    name: "durable_status",
    description: "Query durable task status.",
    parameters: Type.Object({ job_id: Type.Optional(Type.Number()) }),
    execute: () => executeDurable(buildStatusRequest()),
  });

  api.registerTool({
    name: "durable_result",
    description: "Fetch durable task result payload.",
    parameters: Type.Object({ task_id: Type.String() }),
    execute: (_id, p) => executeDurable(buildResultRequest(String(p.task_id ?? "0"))),
  });

  api.registerTool({
    name: "durable_wait",
    description: "Wait for durable task completion up to timeout_seconds.",
    parameters: Type.Object({
      task_id: Type.String(),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    execute: (_id, p) =>
      executeDurable(
        buildWaitRequest(
          String(p.task_id ?? "0"),
          typeof p.timeout_seconds === "number" ? p.timeout_seconds : 120,
        ),
      ),
  });

  api.registerTool({
    name: "durable_retry",
    description: "Retry a failed durable task.",
    parameters: Type.Object({ task_id: Type.String() }),
    execute: (_id, p) => executeDurable(buildRetryRequest(String(p.task_id ?? "0"))),
  });

  api.registerTool({
    name: "durable_tasks",
    description: "List registered durable task types.",
    parameters: Type.Object({}),
    execute: () => executeDurable(buildTasksRequest()),
  });

  api.registerTool({
    name: "durable_list",
    description: "List durable task runs with optional filters.",
    parameters: Type.Object({
      queue: Type.Optional(Type.String()),
      task_name: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    execute: (_id, p) => executeDurable(buildListRequest(p as ListFilters)),
  });
}
