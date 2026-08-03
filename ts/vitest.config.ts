import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "tests/spec/**/*.spec.ts",
      "tests/integration/**/*.spec.ts",
      "tests/e2e/**/*.spec.ts",
      "tests/plugins/**/*.spec.ts",
    ],
    coverage: {
      provider: "v8",
      include: [
        "src/plugins/shared/**/*",
        "src/plugins/oc-sidecar/src/session-cleanup.ts",
        "src/plugins/oc-sidecar/src/telemetry-logic.ts",
        "src/plugins/oc-sidecar/src/sidecar-client.ts",
        "src/plugins/oc-session-guard/src/**/*",
        "src/plugins/oc-subagent-watchdog/src/**/*",
        "src/plugins/oc-event-loop-monitor/src/**/*",
      ],
      reporter: ["text", "json", "html"],
    },
  },
})
