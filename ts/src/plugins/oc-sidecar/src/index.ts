/**
 * OC Sidecar Plugin — entry point.
 *
 * @behavior
 * A thin OC plugin that starts a standalone sidecar process on gateway
 * startup. The sidecar handles:
 * - Worker thread pool for CPU-heavy operations (JSON.stringify, serialization)
 * - SQLite session registry (indexed, fast)
 * - Live process telemetry (event loop delay, heap, CPU)
 * - Session cleanup (strip bloat fields, purge stale subagents)
 *
 * The plugin itself is lightweight — it registers hooks and tools that proxy
 * to the sidecar via HTTP on localhost. No core OC files are touched.
 *
 * @invariants
 * - Plugin only does async I/O (HTTP to sidecar). Never CPU-heavy work.
 * - Sidecar crash is contained — plugin detects and restarts it.
 * - All hooks are observation/annotation only, never block agent runs.
 * - Tools are registered via `api.registerTool()` per the plugin SDK contract.
 * - Config is validated through the manifest's configSchema.
 *
 * @dft
 * - Pure logic (sidecar handlers, telemetry aggregation) is testable without
 *   the OC plugin runtime — see tests/plugins/oc-sidecar/.
 * - Sidecar process is a plain Node script, testable in isolation.
 * - Deterministic clocks and mock HTTP client in tests.
 */

import { definePluginEntry, Type, type PluginApi } from "./types.js";
import { startSidecar, stopSidecar, type SidecarHandle } from "./sidecar-manager.js";
import { registerSidecar, unregisterSidecar } from "../../shared/sidecar-registry.js";
import { createSidecarClient, type SidecarClient } from "./sidecar-client.js";

export interface SidecarPluginConfig {
  sidecar?: {
    port?: number;
    workerThreads?: number;
    startupTimeoutMs?: number;
  };
}

export default definePluginEntry({
  id: "oc-sidecar",
  name: "OC Sidecar",
  description:
    "Standalone sidecar process for session cleanup, worker pool offloading, and live telemetry.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    // Check if sidecar is already running (from a previous gateway_start
    // that survived a hot restart). If so, register it immediately.
    const hotRestartPort = (config as any)?.sidecar?.port ?? 18900;
    fetch(`http://127.0.0.1:${hotRestartPort}/health`)
      .then((r) => r.ok ? r.json() : null)
      .then(() => {
        // Sidecar is running — create client and register
        const client = createSidecarClient(`http://127.0.0.1:${hotRestartPort}`);
        let cachedStats = { active: 0, poolSize: 3, completed: 0, failed: 0 };
        registerSidecar({
          isAvailable: () => true,
          getStats: () => cachedStats,
          exec: async (operation: string, data: unknown) => {
            const resp = await client.post("/exec", { operation, data });
            try { const h = await client.get("/health") as any; if (h?.pool) cachedStats = h.pool; } catch {}
            return resp;
          },
        });
        api.logger?.info?.(`[oc-sidecar] Sidecar already running on port ${hotRestartPort} (registered in sidecar-registry via hot-restart check)`);
      })
      .catch(() => {
        // Sidecar not running — will be started by gateway_start hook
      });
    const cfg: SidecarPluginConfig = (config as SidecarPluginConfig) ?? {};
    const sidecarPort = cfg.sidecar?.port ?? 18900;
    const startupTimeoutMs = cfg.sidecar?.startupTimeoutMs ?? 10_000;

    let sidecar: SidecarHandle | null = null;
    let client: SidecarClient | null = null;

    // ── Gateway lifecycle: start/stop the sidecar ───────────────

    api.on("gateway_start", async () => {
      try {
        sidecar = await startSidecar({
          port: sidecarPort,
          workerThreads: cfg.sidecar?.workerThreads ?? 3,
          startupTimeoutMs,
        });
        client = createSidecarClient(`http://127.0.0.1:${hotRestartPort}`);
        // Register the client so other plugins can use it
        // Cache last known stats (updated periodically by sidecar_health tool)
        let cachedStats = { active: 0, poolSize: 3, completed: 0, failed: 0 };
        registerSidecar({
          isAvailable: () => true,
          getStats: () => cachedStats,
          exec: async (operation: string, data: unknown) => {
            const resp = await client!.post("/exec", { operation, data });
            // Update cache after each exec
            try { const h = await client!.get("/health") as any; if (h?.pool) cachedStats = h.pool; } catch {}
            return resp;
          },
        });
        api.logger?.info?.(`[oc-sidecar] Sidecar started on port ${hotRestartPort} (registered in sidecar-registry)`);
      } catch (err) {
        api.logger?.error?.(`[oc-sidecar] Failed to start sidecar: ${String(err)}`);
      }
    });

    api.on("gateway_stop", async () => {
      if (sidecar) {
        await stopSidecar(sidecar);
        sidecar = null;
        client = null;
        unregisterSidecar();
        api.logger?.info?.("[oc-sidecar] Sidecar stopped (unregistered from sidecar-registry)");
      }
    });

    // ── Tool: sidecar_health ─────────────────────────────────────

    api.registerTool({
      name: "sidecar_health",
      description:
        "Check the health of the OC sidecar process — worker pool stats, " +
        "session registry size, event loop delay, CPU, and heap usage.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        if (!client) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Sidecar is not running. Use `gateway restart` to start it.",
              },
            ],
          };
        }
        try {
          const health = await client.get("/health");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(health, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Sidecar health check failed: ${String(err)}`,
              },
            ],
          };
        }
      },
    });

    // ── Tool: sidecar_exec ──────────────────────────────────────

    api.registerTool({
      name: "sidecar_exec",
      description:
        "Execute a CPU-heavy operation in the sidecar worker pool " +
        "(off the main event loop). Operations: json.stringify, " +
        "json.parse, serialize.session, compact.context.",
      parameters: Type.Object({
        operation: Type.String({
          description:
            "Operation name: json.stringify, json.parse, serialize.session, compact.context",
        }),
        data: Type.Any({
          description: "Input data for the operation.",
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!client) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Sidecar is not running. Use `gateway restart` to start it.",
              },
            ],
          };
        }
        try {
          const result = await client.post("/exec", params);
          return {
            content: [
              {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Sidecar exec failed: ${String(err)}`,
              },
            ],
          };
        }
      },
    });
  },
});
