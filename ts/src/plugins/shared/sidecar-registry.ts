/**
 * Sidecar Registry — singleton for cross-plugin sidecar sharing.
 *
 * @dft
 * - A5 (mock-doubles): testable by calling reset() between tests
 * - Injectable: plugins register, consumers read
 *
 * @invariants
 * - Singleton state (module-level variable)
 * - oc-sidecar registers on gateway_start, unregisters on gateway_stop
 * - oc-compaction-helper reads at hook time (lazy, not at register time)
 * - If not registered, consumers get NullSidecar
 *
 * @why
 * OC's plugin config system passes plain JSON — it can't inject a
 * SidecarProtocol instance. This module-level registry is the bridge:
 * oc-sidecar has the client, other plugins need it.
 */

import type { SidecarProtocol } from "./sidecar-protocol.js";
import { NullSidecar } from "./sidecar-protocol.js";

// Use globalThis so the singleton survives across esbuild bundles.
// Each plugin bundles its own copy of sidecar-registry.ts, but they
// share the same globalThis — so the singleton is truly shared.
const GLOBAL_KEY = "__OC_SIDECAR_REGISTRY__" as const;

interface GlobalWithSidecarRegistry {
  [GLOBAL_KEY]?: SidecarProtocol;
}

export interface SidecarRegistryResult {
  registered: boolean;
  previouslyRegistered: boolean;
}

function getRegistryHost(): GlobalWithSidecarRegistry {
  return globalThis as unknown as GlobalWithSidecarRegistry;
}

function getGlobal(): SidecarProtocol {
  return getRegistryHost()[GLOBAL_KEY] ?? new NullSidecar();
}

export function registerSidecar(sidecar: SidecarProtocol): SidecarRegistryResult {
  const host = getRegistryHost();
  const previouslyRegistered = host[GLOBAL_KEY] !== undefined;
  host[GLOBAL_KEY] = sidecar;
  return { registered: true, previouslyRegistered };
}

export function unregisterSidecar(): SidecarRegistryResult {
  const host = getRegistryHost();
  const previouslyRegistered = host[GLOBAL_KEY] !== undefined;
  delete host[GLOBAL_KEY];
  return { registered: false, previouslyRegistered };
}

export function getSidecar(): SidecarProtocol {
  return getGlobal();
}

/** Reset to NullSidecar — for tests only */
export function resetSidecarRegistry(): SidecarRegistryResult {
  const host = getRegistryHost();
  const previouslyRegistered = host[GLOBAL_KEY] !== undefined;
  delete host[GLOBAL_KEY];
  return { registered: false, previouslyRegistered };
}
