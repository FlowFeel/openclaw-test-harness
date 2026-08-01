import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { resolveChildAdmission } from "../../patches/child-admission.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Patch Validation Integration", () => {
  const patchesDir = path.resolve(__dirname, "../../patches");
  const patchFile = path.join(patchesDir, "child-admission.patch");
  const tsFile = path.join(patchesDir, "child-admission.ts");

  it("should ensure child-admission patch files exist", () => {
    expect(fs.existsSync(patchFile)).toBe(true);
    expect(fs.existsSync(tsFile)).toBe(true);
  });

  it("should ensure the patch diff file contains expected guards", () => {
    const patchContent = fs.readFileSync(patchFile, "utf-8");
    
    // Ensure the patch introduces our critical guards
    expect(patchContent).toContain("subagents.maxConcurrent");
    expect(patchContent).toContain("subagents.runTimeoutSeconds");
    expect(patchContent).toContain("globalActive");
    expect(patchContent).toContain("timedOutSubagents");
  });

  it("should verify child-admission logic performs as expected on test input", () => {
    // Verification of the compiled resolution logic (covers the integration layer of the pyramid)
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 2,
      activeChildren: 0,
      maxActiveChildren: 2,
      globalActive: 0,
      maxConcurrent: 2,
      timedOutSubagents: [],
      runTimeoutSeconds: 300,
      collect: false,
    });
    
    expect(result.ok).toBe(true);
  });

  it("should enforce the concurrent guard in the imported module", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 2,
      activeChildren: 0,
      maxActiveChildren: 2,
      globalActive: 2,
      maxConcurrent: 2,
      timedOutSubagents: [],
      runTimeoutSeconds: 300,
      collect: false,
    });
    
    expect(result.ok).toBe(false);
    expect((result as any).governingCap).toBe("subagents.maxConcurrent");
  });
});
