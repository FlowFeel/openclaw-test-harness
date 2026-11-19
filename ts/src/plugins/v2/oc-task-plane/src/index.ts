/**
 * Unified Task Plane Engine — Declarative Vertical Slice Composer (Plugins v2).
 *
 * @invariants
 * - Zero closure-trapped mutable state: each capability owns its own isolated state slice.
 * - Zero empty catch blocks, zero any casts, zero direct filesystem I/O.
 *
 * @dft
 * - Full 4-tier test pyramid: slice unit tests, Protocol-double integration + manifest tests,
 *   traceable BDD Gherkin features, and containerized E2E boot gate.
 */

import { definePluginEntry, type PluginApi } from "../../../shared/types.js";
import { DEFAULT_TASK_TIMEOUT_MS } from "./task-plane-logic.js";
import { getDefaultRegistryPath, getDefaultOutputDir } from "./task-plane-io.js";
import { SIDECAR_BASE_URL } from "./durable-sidecar-logic.js";
import type { FetchJson } from "./durable-sidecar-io.js";
import type { RevisionFetcher } from "./staging-verify-io.js";
import { bindTaskDispatchSlice, type TaskDispatchIoDeps } from "./slices/task-dispatch/slice.js";
import { bindPipelineVerifySlice } from "./slices/pipeline-verify/slice.js";
import { bindWorkQueueSlice } from "./slices/work-queue/slice.js";
import { bindSubagentWatchdogSlice } from "./slices/subagent-watchdog/slice.js";
import { bindDurableProxySlice } from "./slices/durable-proxy/slice.js";

export interface TaskPlaneConfig extends TaskDispatchIoDeps {
  registryPath?: string;
  outputDir?: string;
  defaultTimeoutMs?: number;
  supervisorIntervalMs?: number;
  sidecarBaseUrl?: string;
  sidecarTimeoutMs?: number;
  maxConcurrentSubagents?: number;
  subagentTimeoutSeconds?: number;
  fetchStagingRevision?: RevisionFetcher;
  fetchJson?: FetchJson;
}

export default definePluginEntry({
  id: "oc-task-plane",
  name: "OC Task Plane",
  description:
    "Unified Task Plane Engine (Plugins v2) — consolidates lock-free async dispatch, multi-step pipeline execution, staging verification, durable postgres sidecar proxying, subagent work queueing, and watchdog lifecycle tracking.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as TaskPlaneConfig) ?? {};
    const clock = cfg.clock ?? (() => Date.now());

    const dispatch = bindTaskDispatchSlice(
      api,
      {
        registryPath: cfg.registryPath ?? getDefaultRegistryPath(),
        outputDir: cfg.outputDir ?? getDefaultOutputDir(),
        defaultTimeoutMs: cfg.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
        supervisorIntervalMs: cfg.supervisorIntervalMs ?? 1000,
      },
      cfg,
    );

    bindPipelineVerifySlice(api, {
      revisionFetcher: cfg.fetchStagingRevision,
      spawner: cfg.spawner,
    });

    bindWorkQueueSlice(
      api,
      { maxConcurrentSubagents: cfg.maxConcurrentSubagents ?? 6 },
      clock,
    );

    bindSubagentWatchdogSlice(
      api,
      { timeoutSeconds: cfg.subagentTimeoutSeconds ?? 300 },
      clock,
    );

    bindDurableProxySlice(
      api,
      {
        sidecarBaseUrl: cfg.sidecarBaseUrl ?? SIDECAR_BASE_URL,
        sidecarTimeoutMs: cfg.sidecarTimeoutMs ?? 180000,
      },
      cfg.fetchJson,
    );

    api.on("gateway_start", async () => dispatch.onGatewayStart());
    api.on("gateway_stop", async () => dispatch.onGatewayStop());
  },
});
