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

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { startSidecar, stopSidecar, type SidecarHandle } from "./sidecar-manager.js";
import { createSidecarClient, type SidecarClient } from "./sidecar-client.js";

export interface SidecarPluginConfig {
  sidecar?: {
    port?: number;
    workerThreads?: number;
    startupTimeoutMs?: number;
  };
  sessionCleanup?: {
    maxAgeHours?: number;
    stripBloatFields?: boolean;
    bloatFields?: string[];
  };
  telemetry?: {
    enabled?: boolean;
    collectIntervalMs?: number;
  };
}

export default definePluginEntry({
  id: "oc-sidecar",
  name: "OC Sidecar",
  description:
    "Standalone sidecar process for session cleanup, worker pool offloading, and live telemetry.",
  register(api, config) {
    const cfg: SidecarPluginConfig = config ?? {};
    const sidecarPort = cfg.sidecar?.port ?? 18900;
    const startupTimeoutMs = cfg.sidecar?.startupTimeoutMs ?? 10_000;

    let sidecar: SidecarHandle | null = null;
    let client: SidecarClient | null = null;

    // ── Gateway lifecycle: start/stop the sidecar ───────────────

    api.registerHook("gateway_start", async () => {
      try {
        sidecar = await startSidecar({
          port: sidecarPort,
          workerThreads: cfg.sidecar?.workerThreads ?? 3,
          startupTimeoutMs,
        });
        client = createSidecarClient(`http://127.0.0.1:${sidecarPort}`);
        api.logger?.info?.(`[oc-sidecar] Sidecar started on port ${sidecarPort}`);
      } catch (err) {
        api.logger?.error?.(`[oc-sidecar] Failed to start sidecar: ${String(err)}`);
        // Non-fatal — plugin hooks degrade gracefully (sidecar_exec returns error)
      }
    });

    api.registerHook("gateway_stop", async () => {
      if (sidecar) {
        await stopSidecar(sidecar);
        sidecar = null;
        client = null;
        api.logger?.info?.("[oc-sidecar] Sidecar stopped");
      }
    });

    // ── Session cleanup hooks ────────────────────────────────────

    const bloatFields = cfg.sessionCleanup?.bloatFields ?? [
      "compactionCheckpoints",
      "systemPromptReport",
      "skillsSnapshot",
      "contextBudgetStatus",
      "usageFamilySessionIds",
      "lastHeartbeatText",
    ];

    api.registerHook("after_compaction", async (event) => {
      if (!client) return;
      try {
        await client.post("/session/cleanup", {
          sessionKey: event.sessionKey,
          stripBloatFields: cfg.sessionCleanup?.stripBloatFields ?? true,
          bloatFields,
        });
      } catch {
        // Sidecar unavailable — non-fatal
      }
    });

    api.registerHook("session_end", async (event) => {
      if (!client) return;
      try {
        await client.post("/session/purge-stale", {
          maxAgeHours: cfg.sessionCleanup?.maxAgeHours ?? 15,
          bloatFields,
        });
      } catch {
        // Sidecar unavailable — non-fatal
      }
    });

    // ── Subagent tracking ────────────────────────────────────────

    api.registerHook("subagent_spawned", async (event) => {
      if (!client) return;
      try {
        await client.post("/subagent/track", {
          sessionKey: event.sessionKey,
          model: event.resolvedModel,
          provider: event.resolvedProvider,
          spawnedBy: event.context?.sessionKey,
        });
      } catch {
        // Non-fatal
      }
    });

    api.registerHook("subagent_ended", async (event) => {
      if (!client) return;
      try {
        await client.post("/subagent/end", {
          sessionKey: event.sessionKey,
        });
      } catch {
        // Non-fatal
      }
    });

    // ── Telemetry collection ────────────────────────────────────

    if (cfg.telemetry?.enabled !== false) {
      api.registerHook("model_call_started", async (event) => {
        if (!client) return;
        try {
          await client.post("/telemetry/collect", {
            runId: event.runId,
            provider: event.provider,
            model: event.model,
          });
        } catch {
          // Non-fatal
        }
      });

      api.registerHook("model_call_ended", async (event) => {
        if (!client) return;
        try {
          await client.post("/telemetry/record", {
            runId: event.runId,
            durationMs: event.durationMs,
            outcome: event.outcome,
          });
        } catch {
          // Non-fatal
        }
      });
    }

    // ── Tool: sidecar_health ─────────────────────────────────────

    api.registerTool({
      name: "sidecar_health",
      description:
        "Check the health of the OC sidecar process — worker pool stats, " +
        "session registry size, event loop delay, CPU, and heap usage.",
      parameters: Type.Object({}),
      async execute(_id, _params) {
        if (!client) {
          return {
            content: [
              {
                type: "text",
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
                type: "text",
                text: JSON.stringify(health, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
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
      async execute(_id, params) {
        if (!client) {
          return {
            content: [
              {
                type: "text",
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
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Sidecar exec failed: ${String(err)}`,
              },
            ],
          };
        }
      },
    });
  },
});
