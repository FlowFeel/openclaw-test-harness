/**
 * Repro: tool schemas must be valid JSON Schema — no literal `"any"` types.
 *
 * @why
 * OpenRouter validates every request's tool definitions against the OpenAPI
 * metaschema BEFORE calling the model. One invalid schema rejects the ENTIRE
 * LLM request:
 *   "Tool 15 function has invalid 'parameters' schema: 'any' is not valid
 *    under any of the given schemas"
 * Type.Any() used to emit { type: "any" } — `"any"` is not one of the JSON
 * Schema simple types, so any request carrying those tools failed at the
 * provider, before inference. This spec pins: every tool schema from every
 * plugin must contain only simple-type values, and no compiled bundle may
 * carry a literal type:"any".
 *
 * @dft Pure schema validation against the compiled plugin sources — no
 * container, no network, no provider call.
 */

import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

const PLUGINS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../src/plugins")

// JSON Schema simple types — anything else as a `type` value is
// reject-at-provider.
const VALID_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
])

/** Recursively collect invalid `type` values in a schema node. */
function findInvalidTypes(node: unknown, pathSoFar: string, out: string[]): void {
  if (node === null || typeof node !== "object") return
  if (Array.isArray(node)) {
    node.forEach((child, i) => findInvalidTypes(child, `${pathSoFar}[${i}]`, out))
    return
  }
  const rec = node as Record<string, unknown>
  if (typeof rec.type === "string" && !VALID_TYPES.has(rec.type)) {
    out.push(`${pathSoFar}.type = "${rec.type}"`)
  }
  for (const key of ["properties", "items", "additionalProperties", "anyOf", "oneOf", "allOf", "$defs", "definitions"]) {
    if (key in rec) findInvalidTypes(rec[key], `${pathSoFar}.${key}`, out)
  }
}

describe("plugin tool schemas are valid JSON Schema", () => {
  it("Type.Any() emits an empty schema, never type:'any'", async () => {
    const { Type } = await import("../../src/plugins/shared/types.js")
    const schema = Type.Any({ description: "anything" }) as Record<string, unknown>
    expect(schema).not.toHaveProperty("type")
  })

  it("no compiled plugin bundle contains a literal type:'any'", () => {
    const plugins = fs.readdirSync(PLUGINS_DIR).filter((d) =>
      fs.existsSync(path.join(PLUGINS_DIR, d, "dist", "index.js")),
    )
    expect(plugins.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const plugin of plugins) {
      const src = fs.readFileSync(path.join(PLUGINS_DIR, plugin, "dist", "index.js"), "utf8")
      if (/type:\s*["']any["']/.test(src) || /"type"\s*:\s*"any"/.test(src)) {
        offenders.push(plugin)
      }
    }
    expect(offenders).toEqual([])
  })

  it("every registered tool's parameters walk clean (simple types only)", async () => {
    const plugins = fs.readdirSync(PLUGINS_DIR).filter((d) =>
      fs.existsSync(path.join(PLUGINS_DIR, d, "dist", "index.js")),
    )
    const failures: string[] = []

    for (const plugin of plugins) {
      const mod = (await import(`../../src/plugins/${plugin}/dist/index.js`)) as {
        register?: (api: Record<string, unknown>) => Promise<unknown>
      }
      if (typeof mod.register !== "function") continue

      const tools: Array<{ name: string; parameters: unknown }> = []
      const api = {
        registerTool: (def: { name: string; parameters?: unknown }) => {
          tools.push({ name: def.name, parameters: def.parameters ?? {} })
        },
        on: () => {},
        registerCommand: () => {},
        log: () => {},
        pluginConfig: {},
      }
      try {
        await mod.register(api)
      } catch {
        continue // plugin needs a fuller API surface; bundle scan (above) covers it
      }

      for (const tool of tools) {
        const invalid: string[] = []
        findInvalidTypes(tool.parameters, tool.name, invalid)
        if (invalid.length > 0) {
          failures.push(`${plugin}/${tool.name}: ${invalid.join(", ")}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})