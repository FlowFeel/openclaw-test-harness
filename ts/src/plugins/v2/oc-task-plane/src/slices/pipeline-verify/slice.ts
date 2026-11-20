/**
 * Pipeline & Staging Verification Slice Adapter — binds exec_pipeline and staging_verify.
 *
 * @invariants
 * - All network/process I/O mediated via injectable RevisionFetcher and ProcessSpawner protocols.
 *
 * @dft
 * - Tested via oc-task-plane integration & manifest specs.
 */

import { Type, type PluginApi } from "../../../../../shared/types.js";
import {
  defaultFetchStagingRevision,
  type RevisionFetcher,
} from "../../staging-verify-io.js";
import { defaultProcessSpawner, type ProcessSpawner } from "../../task-plane-io.js";
import { createPipelineVerifyState } from "./state.js";
import { verifyStagingPayload, validateAndCountPipeline } from "./logic.js";

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function bindPipelineVerifySlice(
  api: PluginApi,
  deps?: { revisionFetcher?: RevisionFetcher; spawner?: ProcessSpawner },
): void {
  let state = createPipelineVerifyState();
  const fetcher: RevisionFetcher = deps?.revisionFetcher ?? defaultFetchStagingRevision;
  const spawner: ProcessSpawner = deps?.spawner ?? defaultProcessSpawner;

  api.registerTool({
    name: "exec_pipeline",
    description: "Execute a validated multi-step command pipeline with exit-code gating.",
    parameters: Type.Object({
      steps: Type.Array(Type.Any(), { description: "Ordered list of shell commands" }),
      mode: Type.Optional(Type.String({ description: "'sequential' (default) or 'piped'" })),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const check = validateAndCountPipeline(state, params);
      state = check.nextState;
      if (!check.valid || !check.spec) return jsonText({ ok: false, error: check.error });

      const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
      const stepResults: Array<{ command: string; exitCode: number | null }> = [];

      for (const step of check.spec.steps) {
        const exitCode = await new Promise<number | null>((resolve) => {
          spawner(step.command, {
            cwd,
            onStdoutChunk: () => undefined,
            onStderrChunk: () => undefined,
            onExit: (code) => resolve(code),
          });
        });
        stepResults.push({ command: step.command, exitCode });
        if (step.condition === "on_success" && exitCode !== 0) break;
      }

      const ok = stepResults.every((r) => r.exitCode === 0);
      return jsonText({ ok, mode: check.spec.mode, steps: stepResults });
    },
  });

  api.registerTool({
    name: "staging_verify",
    description: "Verify that a staging endpoint is serving the expected git commit SHA.",
    parameters: Type.Object({
      url: Type.String({ description: "Staging version endpoint URL" }),
      expectedSha: Type.String({ description: "Expected git commit SHA" }),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const url = String(params.url ?? "");
      const expectedSha = String(params.expectedSha ?? "");
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
      const fetched = await fetcher(url, timeoutMs);
      const res = verifyStagingPayload(state, fetched, expectedSha);
      state = res.nextState;
      return jsonText(res.verdict);
    },
  });
}
