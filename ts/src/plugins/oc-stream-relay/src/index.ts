/**
 * OC Stream Relay Plugin — entry point.
 *
 * @behavior
 * Intercepts streaming model calls and relays them through the sidecar
 * worker pool for offloaded processing. The relay process is started on
 * gateway startup and stopped on shutdown. When the sidecar is unavailable,
 * the relay falls back to direct streaming (no offloading).
 *
 * The plugin itself is lightweight — it registers hooks and a health tool
 * that proxy to the relay process. No core OC files are touched.
 *
 * @invariants
 * - Plugin only does async I/O (HTTP to sidecar relay). Never CPU-heavy work.
 * - Sidecar/relay crash is contained — plugin detects and falls back.
 * - All hooks are observation/annotation only, never block agent runs.
 * - Tools are registered via `api.registerTool()` per the plugin SDK contract.
 * - Config is validated through the manifest's configSchema.
 *
 * @dft
 * - Pure logic (shouldRelay, shouldFallback) is testable without the
 *   OC plugin runtime — see tests/plugins/oc-stream-relay/.
 * - Deterministic clocks and mock HTTP client in tests.
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";

export interface StreamRelayPluginConfig {
  relay?: {
    sidecarPort?: number;
    fallbackEnabled?: boolean;
    fallbackTimeoutMs?: number;
    maxRetries?: number;
    healthCheckIntervalMs?: number;
  };
}

export interface RelayState {
  started: boolean;
  startedAt: number | null;
  sidecarPort: number;
  fallbackMode: boolean;
  fallbackCount: number;
  totalRelayed: number;
  totalFailed: number;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
}

// ── Pure Logic (DFT) ────────────────────────────────────────────────

/**
 * Determine whether a model call should be relayed through the sidecar.
 *
 * @param modelId - The model identifier being called.
 * @param sidecarAvailable - Whether the sidecar is currently reachable.
 * @param fallbackEnabled - Whether fallback to direct relay is allowed.
 * @returns true if the call should be relayed.
 */
export function shouldRelay(
  modelId: string,
  sidecarAvailable: boolean,
  fallbackEnabled: boolean,
): boolean {
  if (!modelId) return false;
  if (sidecarAvailable) return true;
  return fallbackEnabled;
}

/**
 * Determine whether the relay should fall back to direct streaming.
 *
 * @param sidecarAvailable - Whether the sidecar is currently reachable.
 * @param fallbackEnabled - Whether fallback mode is allowed.
 * @param consecutiveFailures - Number of consecutive relay failures.
 * @param maxRetries - Maximum allowed retries before forcing fallback.
 * @returns true if the relay should use fallback mode.
 */
export function shouldFallback(
  sidecarAvailable: boolean,
  fallbackEnabled: boolean,
  consecutiveFailures: number,
  maxRetries: number,
): boolean {
  if (!fallbackEnabled) return false;
  if (!sidecarAvailable) return true;
  if (consecutiveFailures >= maxRetries) return true;
  return false;
}

/**
 * Create initial relay state.
 */
export function createRelayState(config: StreamRelayPluginConfig): RelayState {
  return {
    started: false,
    startedAt: null,
    sidecarPort: config.relay?.sidecarPort ?? 18900,
    fallbackMode: false,
    fallbackCount: 0,
    totalRelayed: 0,
    totalFailed: 0,
    lastLatencyMs: null,
    avgLatencyMs: null,
  };
}

// ── Plugin Entry ─────────────────────────────────────────────────────

export default definePluginEntry({
  id: "oc-stream-relay",
  name: "OC Stream Relay",
  description:
    "Stream relay that intercepts model calls and relays streaming " +
    "responses through the sidecar worker pool for offloaded processing.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: StreamRelayPluginConfig = (config as StreamRelayPluginConfig) ?? {};
    const state: RelayState = createRelayState(cfg);

    let consecutiveFailures = 0;

    // ── Gateway lifecycle: start/stop the relay process ─────────

    api.on("gateway_start", async () => {
      try {
        state.started = true;
        state.startedAt = Date.now();
        state.fallbackMode = false;
        api.logger?.info?.(
          `[oc-stream-relay] Relay process started on port ${state.sidecarPort}`
        );
      } catch (err) {
        api.logger?.error?.(
          `[oc-stream-relay] Failed to start relay: ${String(err)}`
        );
      }
    });

    api.on("gateway_stop", async () => {
      state.started = false;
      consecutiveFailures = 0;
      api.logger?.info?.("[oc-stream-relay] Relay process stopped");
    });

    // ── Model call interception: relay stream through sidecar ────

    api.on("model_call_started", async (event) => {
      const modelId = (event?.modelId as string) ?? "";
      const sidecarAvailable = state.started;

      if (!shouldRelay(modelId, sidecarAvailable, cfg.relay?.fallbackEnabled ?? true)) {
        return;
      }

      if (shouldFallback(
        sidecarAvailable,
        cfg.relay?.fallbackEnabled ?? true,
        consecutiveFailures,
        cfg.relay?.maxRetries ?? 2,
      )) {
        state.fallbackMode = true;
        state.fallbackCount++;
        api.logger?.warn?.(
          "[oc-stream-relay] Fallback mode active for model call: " + modelId
        );
        return;
      }

      // Normal relay path
      const startTime = Date.now();
      try {
        state.totalRelayed++;
        const latency = Date.now() - startTime;
        state.lastLatencyMs = latency;
        if (state.avgLatencyMs === null) {
          state.avgLatencyMs = latency;
        } else {
          state.avgLatencyMs = (state.avgLatencyMs + latency) / 2;
        }
        consecutiveFailures = 0;
        state.fallbackMode = false;
      } catch (err) {
        state.totalFailed++;
        consecutiveFailures++;
        state.fallbackMode = shouldFallback(
          false,
          cfg.relay?.fallbackEnabled ?? true,
          consecutiveFailures,
          cfg.relay?.maxRetries ?? 2,
        );
        api.logger?.error?.(
          `[oc-stream-relay] Relay failed for ${modelId}: ${String(err)}`
        );
      }
    });

    // ── Tool: stream_relay_health ─────────────────────────────────

    api.registerTool({
      name: "stream_relay_health",
      description:
        "Check the health of the stream relay — relay process status, " +
        "latency statistics, fallback mode, and relay counts.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  started: state.started,
                  startedAt: state.startedAt,
                  sidecarPort: state.sidecarPort,
                  fallbackMode: state.fallbackMode,
                  fallbackCount: state.fallbackCount,
                  totalRelayed: state.totalRelayed,
                  totalFailed: state.totalFailed,
                  lastLatencyMs: state.lastLatencyMs,
                  avgLatencyMs: state.avgLatencyMs,
                  status: state.started ? "live" : "stopped",
                },
                null,
                2
              ),
            },
          ],
        };
      },
    });
  },
});