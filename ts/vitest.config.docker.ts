import { defineConfig } from "vitest/config"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    include: [
      "tests/spec/**/*.spec.ts",
      "tests/foundry/**/*.spec.ts",
      "tests/plugins/**/*.spec.ts",
      "tests/integration/**/*.spec.ts",
    ],
    exclude: [
      "node_modules/**",
      "dist/**",
      "tests/oc-source/**",
      "tests/e2e/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
