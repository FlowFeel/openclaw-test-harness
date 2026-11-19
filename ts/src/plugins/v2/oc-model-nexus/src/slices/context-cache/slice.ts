/**
 * Context Cache Slice Adapter — passive read-only context_cache_stats tool and usage observer.
 *
 * @invariants
 * - Never modifies prompts, never interferes with provider caching, never bloats token count.
 *
 * @dft
 * - Tested via oc-model-nexus integration & manifest specs.
 */

import { Type, type PluginApi, type HookEvent } from "../../../../../shared/types.js";
import { createContextCacheState } from "./state.js";
import { observeProviderCacheUsage, getCacheStats } from "./logic.js";

export interface ContextCacheSliceHandle {
  observeCallEnded: (event: HookEvent) => void;
}

export function bindContextCacheSlice(
  api: PluginApi,
  opts: { ttlMs: number; maxEntries: number },
  clock: () => number = () => Date.now(),
): ContextCacheSliceHandle {
  let state = createContextCacheState(opts.ttlMs, opts.maxEntries);

  api.registerTool({
    name: "context_cache_stats",
    description:
      "Report passive context cache and upstream provider cache hit/miss telemetry without interfering with provider caching.",
    parameters: Type.Object({}),
    async execute() {
      const stats = getCacheStats(state, clock());
      return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
    },
  });

  return {
    observeCallEnded(event: HookEvent) {
      state = observeProviderCacheUsage(state, event).nextState;
    },
  };
}

