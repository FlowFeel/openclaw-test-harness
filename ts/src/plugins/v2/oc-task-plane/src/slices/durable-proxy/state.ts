/**
 * Durable Proxy State Slice — tracks durable sidecar request counts and last transport status.
 *
 * @invariants
 * - Isolated vertical slice state; zero coupling to task-dispatch or work-queue slices.
 *
 * @dft
 * - Tested via slices/durable-proxy/tests/logic.spec.ts.
 */

export interface DurableProxyConfig {
  sidecarBaseUrl: string;
  sidecarTimeoutMs: number;
}

export interface DurableProxyState {
  readonly totalRequests: number;
  readonly transportErrors: number;
}

export function createDurableProxyState(): DurableProxyState {
  return { totalRequests: 0, transportErrors: 0 };
}

