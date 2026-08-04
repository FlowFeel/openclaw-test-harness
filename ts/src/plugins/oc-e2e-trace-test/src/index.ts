/**
 * OcE2eTraceTest — plugin entry point (wiring layer).
 *
 * @behavior
 * Wires hooks and tools to the pure logic seam via the I/O Protocol.
 * Delegates all decisions to e2e-trace-test-logic.ts; all I/O to the Protocol wrapper.
 *
 * @invariants
 * - No logic here — only wiring (read → pure call → write).
 * - No direct node:fs imports — I/O goes through the Protocol wrapper.
 * - Hooks catch errors and log (never block agent runs).
 *
 * @dft
 * - Tested via integration tests with in-memory Protocol doubles.
 * - Pure logic tested separately in e2e-trace-test-logic.spec.ts.
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";



export interface OcE2eTraceTestConfig {
  // TODO: add config fields
}

export default definePluginEntry({
  id: "oc-e2e-trace-test",
  name: "OcE2eTraceTest",
  description: "Throws in gateway_start to prove swallowed-error visibility",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as OcE2eTraceTestConfig) ?? {};

    // ── Hook: gateway_start ──────────────────────────────────────────
    api.registerHook("gateway_start", async (event) => {
      try {
        // TODO: read state via reader, call pure logic, write via writer.
        api.logger?.info?.("[oc-e2e-trace-test] gateway start hook fired");
      } catch (err) {
        api.logger?.error?.("[oc-e2e-trace-test] gateway_start failed: " + String(err));
      }
    }, { name: "oc-e2e-trace-test-gateway_start" });

  },
});
