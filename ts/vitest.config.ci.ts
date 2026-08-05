import { defineConfig } from "vitest/config"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ocRoot = path.resolve(__dirname, "../oc-source/upstream")
function ocWorkspaceAliases() {
  const aliases: Array<{ find: RegExp; replacement: string }> = []
  const pkgsDir = path.join(ocRoot, "packages")
  if (!fs.existsSync(pkgsDir)) return aliases
  for (const pkg of fs.readdirSync(pkgsDir)) {
    const pkgJson = path.join(pkgsDir, pkg, "package.json")
    if (!fs.existsSync(pkgJson)) continue
    aliases.push({
      find: new RegExp(`^@openclaw/${pkg}(/.*)?$`),
      replacement: path.join(pkgsDir, pkg, "src", "$1"),
    })
  }
  return aliases
}

// CI config: excludes e2e and oc-source tests (they need Docker/submodule)
export default defineConfig({
  test: {
    include: [
      "tests/spec/**/*.spec.ts",
      "tests/foundry/**/*.spec.ts",
      "tests/plugins/**/*.spec.ts",
      "tests/integration/**/*.spec.ts",
    ],
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**", "tests/oc-source/**"],
  },
  resolve: {
    alias: [...ocWorkspaceAliases()],
  },
})
