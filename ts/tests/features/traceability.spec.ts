/**
 * Feature-file traceability validator — the executable counterpart of
 * docs/README.md's rule "a load-bearing doc that doesn't match reality is a
 * bug". Every Rule:/Scenario: declared in tests/features/*.feature must have
 * a matching test named exactly `Scenario: <title>` (describe blocks may
 * carry the Rule, the `it` must carry the scenario title).
 *
 * This runs in the unit layer (vitest.config.ci.ts) — it is itself a test,
 * subject to CI, not a standalone script.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import * as path from "node:path"

const FEATURES_DIR = path.resolve(__dirname, "../features")
const TESTS_ROOT = path.resolve(__dirname, "..")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith(".spec.ts")) out.push(full)
  }
  return out
}

const featureFiles = readdirSync(FEATURES_DIR).filter((f) => f.endsWith(".feature"))
const specFiles = walk(TESTS_ROOT)

const specBodies = specFiles.map((f) => ({
  file: path.relative(TESTS_ROOT, f),
  body: readFileSync(f, "utf8"),
}))

function extractScenarios(featurePath: string): Array<{ title: string; line: number }> {
  const text = readFileSync(featurePath, "utf8")
  return text
    .split("\n")
    .map((line, i) => ({ text: line.trim(), line: i + 1 }))
    .filter(({ text }) => /^Scenario:\s*.+/.test(text))
    .map(({ text, line }) => ({ title: text.replace(/^Scenario:\s*/, ""), line }))
}

describe("Feature-file traceability — every Scenario has a matching test", () => {
  for (const featureFile of readdirSync(FEATURES_DIR).filter((f) => f.endsWith(".feature"))) {
    const featurePath = path.join(FEATURES_DIR, featureFile)
    const scenarios = extractScenarios(featurePath)

    it(`feature file ${featureFile} declares at least one scenario`, () => {
      expect(scenarios.length).toBeGreaterThan(0)
    })

    for (const scenario of scenarios) {
      it(`Scenario "${scenario.title}" (${featureFile}:${scenario.line}) has a matching it("Scenario: ...")`, () => {
        const needle = `Scenario: ${scenario.title}`
        const found = specBodies.some(({ body }) => body.includes(`it("Scenario: ${scenario.title}`) || body.includes("it(`Scenario: " + scenario.title))
        expect(
          found,
          `Scenario "${scenario.title}" in ${featureFile}:${scenario.line} has no matching ` +
            `it("Scenario: ${scenario.title}") in any spec. Either write the test or ` +
            `remove the scenario — Gherkin here is the executable spec's index, not prose.`,
        ).toBe(true)
      })
    }
  }

  it("feature files exist (the directory is not empty)", () => {
    expect(featureFiles.length).toBeGreaterThan(0)
  })
})
