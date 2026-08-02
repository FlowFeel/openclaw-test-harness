/**
 * OC Subagent Watchdog — plugin entry.
 *
 * @behavior
 * Hooks into subagent_spawned and subagent_ended to track lifecycle.
 * Registers a subagent_health tool that reports active count, stale
 * detection, and spawn availability.
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import {
  trackSpawn,
  trackEnd,
  detectStale,
  getActiveCount,
  canSpawn,
  type SubagentMap,
  type SubagentRecord,
} from "./subagent-tracker.js";

export interface WatchdogConfig {
  maxConcurrent?: number;
  runTimeoutSeconds?: number;
  staleCheckIntervalMs?: number;
}

export default definePluginEntry({
  id: "oc-subagent-watchdog",
  name: "OC Subagent Watchdog",
  description: "Tracks subagent lifecycle — spawn/ended events, stale detection.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: WatchdogConfig = (config as WatchdogConfig) ?? {};
    const maxConcurrent = cfg.maxConcurrent ?? 6;
    const runTimeoutSeconds = cfg.runTimeoutSeconds ?? 300;

    let subagents: SubagentMap = new Map();

    // ── Hook: subagent_spawned ───────────────────────────────
    api.registerHook("subagent_spawned", async (event: {
      sessionKey?: string;
      resolvedModel?: string;
      resolvedProvider?: string;
    }) => {
      if (!event.sessionKey) return;
      subagents = trackSpawn(subagents, {
        sessionKey: event.sessionKey,
        model: event.resolvedModel,
        provider: event.resolvedProvider,
        startedAtMs: Date.now(),
      }, Date.now());
      api.logger?.info?.(
        `[oc-watchdog] Tracked spawn: ${event.sessionKey} ` +
        `(active: ${getActiveCount(subagents)}/${maxConcurrent})`
      );
    });

    // ── Hook: subagent_ended ─────────────────────────────────
    api.registerHook("subagent_ended", async (event: { sessionKey?: string }) => {
      if (!event.sessionKey) return;
      subagents = trackEnd(subagents, event.sessionKey, Date.now());
      api.logger?.info?.(
        `[oc-watchdog] Tracked end: ${event.sessionKey} ` +
        `(active: ${getActiveCount(subagents)}/${maxConcurrent})`
      );
    });

    // ── Tool: subagent_health ───────────────────────────────
    api.registerTool({
      name: "subagent_health",
      description:
        "Check subagent health — active count, stale detection, " +
        "spawn availability. Run before spawning subagents to check capacity.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const { stale, result } = detectStale(subagents, runTimeoutSeconds, Date.now());
        const canSpawnNow = canSpawn(subagents, maxConcurrent);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              activeCount: result.activeCount,
              totalSpawned: result.totalSpawned,
              totalEnded: result.totalEnded,
              staleCount: result.staleKeys.length,
              staleKeys: result.staleKeys,
              maxConcurrent,
              canSpawn: canSpawnNow,
              runTimeoutSeconds,
            }, null, 2),
          }],
        };
      },
    });
  },
});
