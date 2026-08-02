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
      include: ["src/**/*", "patches/**/*"],
      reporter: ["text", "json"],
    },
  },
})
