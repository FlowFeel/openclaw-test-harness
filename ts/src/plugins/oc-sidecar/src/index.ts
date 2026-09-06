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
import { registerSidecar, unregisterSidecar, getSidecar } from "../../shared/sidecar-registry.js";
import { createSidecarClient, type SidecarClient } from "./sidecar-client.js";

export interface SidecarPluginConfig {
  sidecar?: {
    port?: number;
    workerThreads?: number;
    startupTimeoutMs?: number;
  };
}

/** Default sidecar port. */
const DEFAULT_SIDECAR_PORT = 18900;

/** Default worker threads. */
const DEFAULT_WORKER_THREADS = 3;

/** Default startup timeout. */
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

/** Hot-restart probe timeout — short to avoid blocking gateway startup. */
const HOT_RESTART_PROBE_MS = 200;

/**
 * Hot-restart check: is a sidecar already running on the given port?
 *
 * During a hot restart, a previous gateway_start's sidecar process may still
 * be alive. Instead of spawning a new one (port conflict), we adopt the
 * existing one. Uses a short timeout — on a closed port the OS returns
 * ECONNREFUSED in a few ms, but a hanging connection must not block gateway
 * startup.
 *
 * @returns A SidecarClient if the sidecar is alive, null otherwise.
 */
export async function tryAdoptRunningSidecar(
  port: number
): Promise<SidecarClient | null> {
  const probe = createSidecarClient(`http://127.0.0.1:${port}`, {
    timeoutMs: HOT_RESTART_PROBE_MS,
  });
  try {
    await probe.get("/health");
    return probe;
  } catch {
    return null;
  }
}

export default definePluginEntry({
  id: "oc-sidecar",
  name: "OC Sidecar",
  description:
    "Standalone sidecar process for session cleanup, worker pool offloading, and live telemetry.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: SidecarPluginConfig = (config as SidecarPluginConfig) ?? {};
    const sidecarPort = cfg.sidecar?.port ?? DEFAULT_SIDECAR_PORT;
    const startupTimeoutMs =
      cfg.sidecar?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const workerThreads =
      cfg.sidecar?.workerThreads ?? DEFAULT_WORKER_THREADS;

    let sidecar: SidecarHandle | null = null;
    let client: SidecarClient | null = null;

    // Helper: register a sidecar client in the cross-plugin registry.
    // Used by both the hot-restart (adopt) path and the fresh-start path.
    const registerClient = (c: SidecarClient) => {
      let cachedStats = { active: 0, poolSize: 3, completed: 0, failed: 0 };
      registerSidecar({
        isAvailable: () => true,
        getStats: () => cachedStats,
        exec: async (operation: string, data: unknown) => {
          const resp = await c.post("/exec", { operation, data });
          // Update stats cache after each exec (best-effort)
          try {
            const h = (await c.get("/health")) as { pool?: typeof cachedStats };
            if (h?.pool) cachedStats = h.pool;
          } catch { /* stats update is best-effort */ }
          return resp;
        },
      });
    };

    // ── Gateway lifecycle: start/stop the sidecar ───────────────

    api.on("gateway_start", async () => {
      try {
        // Hot-restart check: is a sidecar already running on this port from
        // a previous gateway_start that survived a hot restart? If so, adopt
        // it instead of spawning a new process (avoids port conflicts and
        // double registrations). Short timeout — don't block gateway startup.
        const adopted = await tryAdoptRunningSidecar(sidecarPort);
        if (adopted) {
          client = adopted;
          registerClient(client);
          api.logger?.info?.(
            `[oc-sidecar] Adopted already-running sidecar on port ${sidecarPort} (registered in sidecar-registry)`
          );
          return;
        }

        // No sidecar running — start a fresh one
        sidecar = await startSidecar({
          port: sidecarPort,
          workerThreads,
          startupTimeoutMs,
        });
        client = createSidecarClient(`http://127.0.0.1:${sidecarPort}`);
        registerClient(client);
        api.logger?.info?.(
          `[oc-sidecar] Sidecar started on port ${sidecarPort} (registered in sidecar-registry)`
        );
      } catch (err) {
        api.logger?.error?.(`[oc-sidecar] Failed to start sidecar: ${String(err)}`);
      }
    });

    api.on("gateway_stop", async () => {
      // Only stop the process if we started it (not if we adopted it).
      // Always unregister from the registry — we registered the client.
      if (sidecar) {
        await stopSidecar(sidecar);
        sidecar = null;
      }
      client = null;
      unregisterSidecar();
      api.logger?.info?.(
        "[oc-sidecar] Sidecar stopped (unregistered from sidecar-registry)"
      );
    });

    // ── Tool: sidecar_health ─────────────────────────────────────

    api.registerTool({
      name: "sidecar_health",
      description:
        "Check the health of the OC sidecar process — worker pool stats, " +
        "session registry size, event loop delay, CPU, and heap usage.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        // Try local client first, then fall back to globalThis registry.
        // This handles the case where a duplicate plugin load re-registered
        // the tool with a null client, but the first load's sidecar is still
        // registered in the globalThis singleton.
        const activeClient = client ?? (() => {
          const s = getSidecar();
          return s.isAvailable() ? s : null;
        })();
        if (!activeClient) {
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
          // SidecarProtocol doesn't have get(), so use exec to fetch health
          const health = activeClient === client
            ? await client.get("/health")
            : await (async () => {
                // For registry-based sidecar, use exec to get health info
                // via a sidecar health request
                const c = createSidecarClient(`http://127.0.0.1:${sidecarPort}`);
                return await c.get("/health");
              })();
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
        const activeClient = client ?? (() => {
          const s = getSidecar();
          return s.isAvailable() ? s : null;
        })();
        if (!activeClient) {
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
          const result = activeClient === client
            ? await client.post("/exec", params)
            : await activeClient.exec(params.operation as string, params.data);
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
