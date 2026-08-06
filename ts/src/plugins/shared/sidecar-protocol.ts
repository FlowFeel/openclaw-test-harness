/**
 * Sidecar Protocol — interface for offloading CPU work to the sidecar.
 *
 * @dft
 * - A3 (manifest-conformance): declared in types, implemented in wiring
 * - A5 (mock-doubles): real implementation uses fetch, mock uses in-process
 *
 * @invariants
 * - All methods return the same type as the inline operation
 * - Network errors fall back to inline (caller doesn't need to handle)
 */

export interface SidecarProtocol {
  /** Check if the sidecar is available and pool has capacity */
  isAvailable(): boolean;
  /** Get current pool stats */
  getStats(): { active: number; poolSize: number; completed: number; failed: number };
  /** Offload a CPU-heavy operation */
  exec(operation: string, data: unknown): Promise<unknown>;
}

/**
 * NullSidecar — fallback when no sidecar is running.
 * All operations return false (caller does inline work).
 */
export class NullSidecar implements SidecarProtocol {
  isAvailable(): boolean { return false; }
  getStats() { return { active: 0, poolSize: 0, completed: 0, failed: 0 }; }
  async exec(): Promise<unknown> {
    throw new Error("NullSidecar: no sidecar available");
  }
}
