import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { createRequire } from "node:module"
import { compileFunction } from "node:vm"

/**
 * Load a CommonJS source file as CJS, regardless of the nearest package.json
 * "type" field.
 *
 * The openclaw-test-harness repo is ESM ("type": "module"), so native
 * require() of a .js patch fails with "require is not defined in ES module
 * scope". This helper evaluates the file in a CJS module wrapper with a real
 * require (builtins resolve normally), returning module.exports.
 *
 * Used to load the CJS production patches (e.g. patches/worker-pool.js) inside
 * ESM Vitest specs without renaming the patch or copying it to a .cjs temp file.
 */
export function loadCjsModule(filePath: string): unknown {
  const src = readFileSync(filePath, "utf8")
  const moduleObj = { exports: {} as Record<string, unknown> }
  const fn = compileFunction(
    src,
    ["exports", "require", "module", "__filename", "__dirname"],
    { filename: filePath },
  )
  fn(moduleObj.exports, createRequire(filePath), moduleObj, filePath, dirname(filePath))
  return moduleObj.exports
}
