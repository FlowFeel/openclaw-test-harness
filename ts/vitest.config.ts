import { defineConfig } from "vitest/config"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// OC source workspace packages — mapped to their .ts source so we can import
// the patched OC hook runner directly in tests without a full pnpm+tsdown build.
// Inert for all existing harness tests (nothing else imports @openclaw/*).
const ocRoot = path.resolve(__dirname, "../oc-source/upstream")

// Auto-discover all workspace packages under packages/ and alias them to source.
// npm-published @openclaw/* packages (fs-safe, proxyline, etc.) resolve from
// node_modules via the symlink at oc-source/upstream/node_modules → ts/node_modules.
function ocWorkspaceAliases() {
  const aliases: Array<{ find: RegExp; replacement: string }> = []
  const pkgsDir = path.join(ocRoot, "packages")
  if (!fs.existsSync(pkgsDir)) return aliases
  for (const pkg of fs.readdirSync(pkgsDir)) {
    const pkgJsonPath = path.join(pkgsDir, pkg, "package.json")
    if (!fs.existsSync(pkgJsonPath)) continue
    const srcDir = path.join(pkgsDir, pkg, "src")
    if (!fs.existsSync(srcDir)) continue
    // Bare import: @openclaw/<pkg> → packages/<pkg>/src/index.ts
    aliases.push({
      find: new RegExp("^@openclaw/" + pkg + "$"),
      replacement: path.join(srcDir, "index.ts"),
    })
    // Sub-path import: @openclaw/<pkg>/<sub> → packages/<pkg>/src/<sub>.ts
    aliases.push({
      find: new RegExp("^@openclaw/" + pkg + "/(.+)$"),
      replacement: path.join(srcDir, "$1.ts"),
    })
  }
  return aliases
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "tests/spec/**/*.spec.ts",
      "tests/integration/**/*.spec.ts",
      "tests/plugins/**/*.spec.ts",
      "tests/e2e/**/*.spec.ts",
      "tests/oc-source/**/*.spec.ts",
      "tests/foundry/**/*.spec.ts",
      "src/plugins/*/tests/**/*.spec.ts",
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
  resolve: {
    alias: [...ocWorkspaceAliases()],
  },
})
