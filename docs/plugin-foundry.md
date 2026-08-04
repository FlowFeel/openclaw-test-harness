# Plugin Foundry

The foundry (`ts/src/foundry/`) is a tool for producing and testing DFT-compliant OC plugins. It codifies the six phosphene DFT axioms into templates (scaffolding) and a validator, so that **every generated plugin passes validation by construction**.

---

## Architecture

```
ts/src/foundry/
├── cli.ts            ← I/O wiring: foundry new | validate | test
├── scaffold.ts       ← PURE: ScaffoldParams → GeneratedFiles (file map)
├── validate-logic.ts ← PURE: PluginTree → Violation[] (six axiom checks)
└── types.ts          ← plain data types (PluginTree, Violation, ScaffoldParams)
```

### Pure seams, thin I/O

The foundry follows the same DFT discipline it enforces:

- **`scaffold.ts`** is pure: `ScaffoldParams` in → `GeneratedFiles` (Map of path → content) out. No filesystem, no I/O.
- **`validate-logic.ts`** is pure: `PluginTree` (in-memory file map + manifest) in → `Violation[]` out. No filesystem, no I/O.
- **`cli.ts`** is thin I/O wiring: parses argv, reads/writes files, delegates all logic to the pure seams.

The pure seams are tested in 0ms with inline data — zero fixtures.

---

## The six DFT axioms

| # | Axiom | Severity | What it checks |
|---|-------|----------|----------------|
| 1 | `pure-io-separation` | error | Logic files (`*-logic.ts`) import no I/O modules; `index.ts` doesn't import `node:fs` directly |
| 2 | `determinism` | error | Logic files have no `Date.now()`, `Math.random()`, or `new Date()` — time is injected |
| 3 | `manifest-conformance` | error | Declared tools/hooks in `openclaw.plugin.json` match registered tools/hooks in `index.ts` |
| 4 | `dft-docs` | error | Every source `.ts` file has `@dft` or `@invariants` docblock |
| 5 | `mock-doubles` | warn | Integration tests don't use `vi.fn()` as Protocol stand-ins |
| 6 | `check-result` | warn | Mutating logic functions return a report (CheckResult pattern), not void |

Axioms 1-4 fail CI (error severity); 5-6 are advisory (warn).

---

## Usage

### `foundry new` — scaffold a plugin

```bash
cd ts
npx tsx src/foundry/cli.ts new oc-my-plugin \
  --hooks before_agent_reply,agent_end,session_end \
  --tools my_health,my_cleanup \
  --desc "My awesome plugin"
```

Creates `src/plugins/oc-my-plugin/` with 7-8 files:

```
oc-my-plugin/
├── openclaw.plugin.json          ← manifest with declared hooks/tools
├── package.json                  ← ESM, type: module
├── src/
│   ├── my-plugin-logic.ts       ← pure logic seam (sample function + report type)
│   ├── index.ts                  ← wiring layer (registers hooks/tools)
│   └── my-plugin-io.ts          ← I/O seam (only if --tools specified)
└── tests/
    ├── manifest.spec.ts          ← manifest validation
    ├── my-plugin-logic.spec.ts   ← pure logic unit tests
    └── integration.spec.ts       ← wiring + Protocol double integration tests
```

### `foundry validate` — check DFT axioms

```bash
npx tsx src/foundry/cli.ts validate src/plugins/oc-my-plugin
```

Checks the plugin against all six axioms. Output:
```
✓ oc-my-plugin: all six DFT axioms pass.
```

Or on failure:
```
✗ [pure-io-separation] src/my-plugin-logic.ts: imports node:fs (I/O module)
✗ [determinism] src/my-plugin-logic.ts: uses Date.now() (non-deterministic)
2 error(s), 0 warning(s)
```

### `foundry test` — run the test pyramid

```bash
npx tsx src/foundry/cli.ts test src/plugins/oc-my-plugin
```

Runs vitest for the plugin's test files.

---

## Round-trip proof

The foundry's key guarantee: **templates cannot produce a non-compliant plugin.**

The scaffold spec (`ts/tests/foundry/scaffold.spec.ts`, 15 specs) includes a round-trip test:

```typescript
it("generated files pass validatePlugin (round-trip)", () => {
  const files = scaffoldPlugin({ name: "oc-test-plugin", hooks: ["agent_end"], tools: [] });
  const tree = treeFromFiles("oc-test-plugin", files);
  const violations = validatePlugin(tree);
  expect(hasErrors(violations)).toBe(false);
});
```

`scaffoldPlugin → validatePlugin → zero errors`. Every template change is automatically verified to still produce compliant output.

---

## The validator internals

Each axiom is a separate pure function that takes a `PluginTree` and returns `Violation[]`:

```typescript
function checkPureIoSeparation(tree: PluginTree): Violation[]   // axiom 1
function checkDeterminism(tree: PluginTree): Violation[]         // axiom 2
function checkManifestConformance(tree: PluginTree): Violation[] // axiom 3
function checkDftDocs(tree: PluginTree): Violation[]             // axiom 4
function checkMockDoubles(tree: PluginTree): Violation[]         // axiom 5
function checkCheckResult(tree: PluginTree): Violation[]         // axiom 6

export function validatePlugin(tree: PluginTree): Violation[] {
  return [
    ...checkPureIoSeparation(tree),
    ...checkDeterminism(tree),
    ...checkManifestConformance(tree),
    ...checkDftDocs(tree),
    ...checkMockDoubles(tree),
    ...checkCheckResult(tree),
  ];
}
```

### `stripComments` in the determinism check

The `@invariants` docblock says "no Date.now()" which would falsely trigger the `Date.now()` regex pattern. The determinism check strips block and line comments before pattern matching:

```typescript
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")  // block comments
    .replace(/^\s*\/\/.*$/gm, "");      // line comments
}
```

---

## Test coverage

| Test file | Specs | What |
|-----------|-------|------|
| `ts/tests/foundry/validate-logic.spec.ts` | 31 | Green (compliant) and red (violating) cases for all six axioms |
| `ts/tests/foundry/scaffold.spec.ts` | 15 | Template generation, round-trip proof, naming helpers |
| **Total** | **46** | Full foundry test suite |
