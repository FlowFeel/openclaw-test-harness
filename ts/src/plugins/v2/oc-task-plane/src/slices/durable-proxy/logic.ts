/**
 * Durable Proxy Pure Transition Algebra — request building and transport outcome accounting.
 *
 * @invariants
 * - Pure logic: zero HTTP I/O, returns immutable DurableProxyState snapshots (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/durable-proxy/tests/logic.spec.ts.
 */

import {
  interpret,
  interpretTransportFailure,
  type SidecarResponse,
} from "../../durable-sidecar-logic.js";
import type { DurableProxyState } from "./state.js";

export function recordDurableOutcome(
  state: DurableProxyState,
  response?: SidecarResponse,
  error?: unknown,
): { nextState: DurableProxyState; text: string } {
  if (error !== undefined) {
    const outcome = interpretTransportFailure(error);
    return {
      nextState: {
        totalRequests: state.totalRequests + 1,
        transportErrors: state.transportErrors + 1,
      },
      text: `${outcome.verdict}: ${outcome.summary}`,
    };
  }
  const outcome = interpret(response!);
  return {
    nextState: { ...state, totalRequests: state.totalRequests + 1 },
    text: `${outcome.verdict}: ${outcome.summary}`,
  };
}

