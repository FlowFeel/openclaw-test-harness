/**
 * TaskPlane Gateway Wake RPC integration.
 *
 * @behavior
 * - Prefers the official OpenClaw PluginApi workflow injection surface
 *   (`api.session.workflow.enqueueNextTurnInjection`) when available.
 * - Falls back to dynamic discovery of OpenClaw's `call-*.js` gateway RPC
 *   module (never hardcoding a build-hash chunk filename).
 * - Provides injectable Protocol `GatewayWakeSender` for unit and integration testing.
 *
 * @invariants
 * - Pure formatters in formatTaskWakeMessage.
 * - Non-throwing wake sender contract (CheckResult `{ ok, error? }`, A6).
 * - Zero hardcoded Vite/Rollup chunk hashes.
 *
 * @dft
 * - Tested in wake-rpc.spec.ts and oc-task-plane integration specs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginApi } from "../../../shared/types.js";
import type { TaskWakeEvent } from "./task-plane-logic.js";

export interface GatewayWakeParams {
  mode: "now" | "next-heartbeat";
  text: string;
  sessionKey: string;
}

export type GatewayWakeSender = (
  params: GatewayWakeParams,
) => Promise<{ ok: boolean; error?: string }>;

/**
 * Format a human- and agent-readable wake notification text.
 */
export function formatTaskWakeMessage(
  wake:
    | TaskWakeEvent
    | {
        targetSessionKey: string;
        message?: string;
        taskId: string;
        status?: string;
        output_handle?: string;
      },
): string {
  if ("message" in wake && typeof wake.message === "string" && wake.message.length > 0) {
    return wake.message;
  }

  const taskId = wake.taskId;
  const status = "status" in wake && wake.status ? wake.status : "completed";
  const outputHandle = "output_handle" in wake && wake.output_handle ? wake.output_handle : "";

  let msg = `[Task Complete] Task ${taskId} finished with status: ${status}.`;
  if (outputHandle) {
    msg += ` Output: ${outputHandle}`;
  }
  return msg;
}

const DEFAULT_OPENCLAW_DIST_DIRS = [
  "/usr/lib/nodejs22/lib/node_modules/openclaw/dist",
  "/usr/local/lib/node_modules/openclaw/dist",
];

/**
 * Dynamically discover OpenClaw's `call-*.js` dist module without hardcoding a build hash.
 */
export function resolveOpenClawCallModule(
  candidateDirs: readonly string[] = DEFAULT_OPENCLAW_DIST_DIRS,
): string | null {
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const match = fs
      .readdirSync(dir)
      .sort()
      .find((entry) => entry.startsWith("call-") && entry.endsWith(".js"));
    if (match) {
      return path.join(dir, match);
    }
  }
  return null;
}

/**
 * Create a PluginApi-first wake sender that uses OpenClaw's official
 * `api.session.workflow.enqueueNextTurnInjection` contract before falling back
 * to dynamic dist RPC discovery.
 */
export function createPluginApiWakeSender(
  api: PluginApi,
  fallback: GatewayWakeSender = defaultGatewayWakeSender,
): GatewayWakeSender {
  return async (params: GatewayWakeParams) => {
    const enqueue = api.session?.workflow?.enqueueNextTurnInjection;
    if (typeof enqueue === "function") {
      try {
        const res = await enqueue({
          sessionKey: params.sessionKey,
          text: params.text,
        });
        return { ok: Boolean(res?.enqueued) };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    return fallback(params);
  };
}

/**
 * Default Gateway Wake sender using dynamic discovery of OpenClaw dist callGateway.
 */
export const defaultGatewayWakeSender: GatewayWakeSender = async (params: GatewayWakeParams) => {
  try {
    const modulePath = resolveOpenClawCallModule();
    if (!modulePath) {
      return { ok: false, error: "OpenClaw gateway call module not found in dist directories" };
    }
    const importDynamic = new Function("modulePath", "return import(modulePath)");
    const { c: callGateway } = (await importDynamic(modulePath)) as {
      c: (opts: { method: string; params: Record<string, unknown> }) => Promise<unknown>;
    };

    const res = await callGateway({
      method: "wake",
      params: {
        mode: params.mode,
        text: params.text,
        sessionKey: params.sessionKey,
      },
    });

    const isOk = Boolean((res as { ok?: boolean })?.ok);
    return { ok: isOk };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
};
