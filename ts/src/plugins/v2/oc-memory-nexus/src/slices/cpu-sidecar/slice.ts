/**
 * CPU Sidecar Slice Adapter — binds sidecar_health, sidecar_exec, and gateway lifecycle hooks.
 *
 * @invariants
 * - All network calls mediated via injectable SidecarClient Protocol (Axiom A5).
 *
 * @dft
 * - Tested via oc-memory-nexus integration & manifest specs with InMemorySidecarClient.
 */

import { Type, type PluginApi } from "../../../../../shared/types.js";
import { createSidecarClient, type SidecarClient } from "../../sidecar-client.js";
import { createCpuSidecarState } from "./state.js";
import { transitionSidecarActive, recordSidecarExecOutcome } from "./logic.js";

export interface CpuSidecarSliceHandle {
  onStart: () => void;
  onStop: () => void;
}

export function bindCpuSidecarSlice(
  api: PluginApi,
  opts: { port: number; client?: SidecarClient },
): CpuSidecarSliceHandle {
  let state = createCpuSidecarState(opts.port);
  const client =
    opts.client ?? createSidecarClient(`http://127.0.0.1:${opts.port}`, { timeoutMs: 5000 });

  api.registerTool({
    name: "sidecar_health",
    description:
      "Check the health of the OC sidecar process — worker pool stats, session registry size, event loop delay, CPU, and heap usage.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const health = await client.get("/health");
        return { content: [{ type: "text" as const, text: JSON.stringify(health, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: `Sidecar unreachable: ${String(err)}` }, null, 2),
            },
          ],
        };
      }
    },
  });

  api.registerTool({
    name: "sidecar_exec",
    description:
      "Execute a CPU-heavy operation in the sidecar worker pool (off the main event loop). Operations: json.stringify, json.parse, serialize.session, compact.context.",
    parameters: Type.Object({
      operation: Type.String({
        description: "Operation name: json.stringify, json.parse, serialize.session, compact.context",
      }),
      data: Type.Any({ description: "Input data for the operation." }),
    }),
    async execute(_id, params) {
      const operation = String(params.operation ?? "");
      try {
        const result = await client.post(`/exec/${encodeURIComponent(operation)}`, params.data);
        state = recordSidecarExecOutcome(state, true).nextState;
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, result }, null, 2) }] };
      } catch (err) {
        state = recordSidecarExecOutcome(state, false).nextState;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }, null, 2) }],
        };
      }
    },
  });

  return {
    onStart() {
      state = transitionSidecarActive(state, true).nextState;
    },
    onStop() {
      state = transitionSidecarActive(state, false).nextState;
      api.logger?.info?.("[oc-memory-nexus] cpu-sidecar slice stopped cleanly.");
    },
  };
}
