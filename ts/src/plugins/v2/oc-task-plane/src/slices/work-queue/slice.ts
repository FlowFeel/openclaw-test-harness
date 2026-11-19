/**
 * Work Queue Slice Adapter — binds queue_work, queue_status, queue_results, and merge_results.
 *
 * @invariants
 * - Owns only WorkQueueSliceState; zero direct I/O.
 *
 * @dft
 * - Tested via oc-task-plane integration & manifest specs.
 */

import { Type, type PluginApi } from "../../../../../shared/types.js";
import type { TaskSpec } from "../../../../../shared/work-queue-scheduler.js";
import type { SubagentResult } from "../../../../../shared/result-merger.js";
import { createWorkQueueSliceState, type WorkQueueSliceConfig } from "./state.js";
import { enqueueWorkBatch, projectWorkQueueStatus, mergeWorkOutputs } from "./logic.js";

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function bindWorkQueueSlice(
  api: PluginApi,
  config: WorkQueueSliceConfig,
  clock: () => number = () => Date.now(),
): void {
  let state = createWorkQueueSliceState();

  api.registerTool({
    name: "queue_work",
    description: "Queue a batch of subagent tasks for concurrency-controlled dispatch.",
    parameters: Type.Object({
      tasks: Type.Array(Type.Any(), { description: "Array of task specs { id, prompt }" }),
    }),
    async execute(_id, params) {
      const raw = Array.isArray(params.tasks) ? params.tasks : [];
      const specs: TaskSpec[] = raw.map((item, i) => {
        const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const prio = rec.priority === "high" || rec.priority === "low" ? rec.priority : "normal";
        return {
          id: typeof rec.id === "string" ? rec.id : `work-${i + 1}`,
          prompt: typeof rec.prompt === "string" ? rec.prompt : String(item),
          priority: prio,
        };
      });
      const res = enqueueWorkBatch(state, config, specs, clock());
      state = res.nextState;
      return jsonText({ ok: true, queued: res.queued, dispatched: res.dispatched });
    },
  });

  api.registerTool({
    name: "queue_status",
    description: "Report pending, running, completed, and failed counts in the subagent work queue.",
    parameters: Type.Object({}),
    async execute() {
      return jsonText(projectWorkQueueStatus(state));
    },
  });

  api.registerTool({
    name: "queue_results",
    description: "Retrieve completed results from the active subagent work queue.",
    parameters: Type.Object({}),
    async execute() {
      const entries = state.queue ? Array.from(state.queue.tasks.values()) : [];
      const completed = entries.filter((t) => t.status === "completed");
      return jsonText({ ok: true, completedCount: completed.length, results: completed });
    },
  });

  api.registerTool({
    name: "merge_results",
    description: "Deterministically merge and deduplicate multiple subagent output payloads.",
    parameters: Type.Object({
      outputs: Type.Array(Type.Any(), { description: "Array of subagent outputs to merge" }),
    }),
    async execute(_id, params) {
      const outputs = Array.isArray(params.outputs) ? (params.outputs as SubagentResult[]) : [];
      return jsonText({ ok: true, merged: mergeWorkOutputs(outputs) });
    },
  });
}
