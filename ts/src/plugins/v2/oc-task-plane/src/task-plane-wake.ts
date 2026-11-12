/**
 * TaskPlane Gateway Wake RPC integration.
 *
 * @behavior
 * - Wraps Gateway RPC `callGateway({ method: "wake", params: { mode: "now", sessionKey, text } })`.
 * - Provides mockable Protocol `GatewayWakeSender` for unit and integration testing.
 * - Dynamic import is executed via runtime indirection so esbuild does not bundle openclaw core dist into the plugin bundle.
 *
 * @invariants
 * - Pure formatters in formatTaskWakeMessage.
 * - Non-throwing wake sender contract.
 *
 * @dft
 * - Tested in wake-rpc.spec.ts with injected mock GatewayWakeSender.
 */

import type { TaskWakeEvent } from "./task-plane-logic.js";

export interface GatewayWakeParams {
  mode: "now" | "next-heartbeat";
  text: string;
  sessionKey: string;
}

export type GatewayWakeSender = (params: GatewayWakeParams) => Promise<{ ok: boolean; error?: string }>;

/**
 * Format a human- and agent-readable wake notification text.
 */
export function formatTaskWakeMessage(
  wake: TaskWakeEvent | { targetSessionKey: string; message?: string; taskId: string; status?: string; output_handle?: string },
): string {
  if ("message" in wake && typeof wake.message === "string" && wake.message.length > 0) {
    return wake.message;
  }

  const taskId = wake.taskId;
  const status = ("status" in wake && wake.status) ? wake.status : "completed";
  const outputHandle = ("output_handle" in wake && wake.output_handle) ? wake.output_handle : "";

  let msg = `[Task Complete] Task ${taskId} finished with status: ${status}.`;
  if (outputHandle) {
    msg += ` Output: ${outputHandle}`;
  }
  return msg;
}

const OPENCLAW_CALL_MODULE = "/usr/lib/nodejs22/lib/node_modules/openclaw/dist/call-BlqKbSL2.js";

/**
 * Default Gateway Wake sender using dynamic import of OpenClaw dist callGateway.
 */
export const defaultGatewayWakeSender: GatewayWakeSender = async (params: GatewayWakeParams) => {
  try {
    const importDynamic = new Function("modulePath", "return import(modulePath)");
    const { c: callGateway } = (await importDynamic(OPENCLAW_CALL_MODULE)) as {
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
