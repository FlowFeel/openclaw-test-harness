/**
 * TaskPlane Gateway Wake RPC integration.
 *
 * @behavior
 * - Wraps Gateway RPC `callGateway({ method: "wake", params: { mode: "now", sessionKey, text } })`.
 * - Provides mockable Protocol `GatewayWakeSender` for unit and integration testing.
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

/**
 * Default Gateway Wake sender using dynamic import of OpenClaw dist callGateway.
 */
export const defaultGatewayWakeSender: GatewayWakeSender = async (params: GatewayWakeParams) => {
  try {
    const { c: callGateway } = (await import(
      "/usr/lib/nodejs22/lib/node_modules/openclaw/dist/call-BlqKbSL2.js" as string
    )) as {
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
