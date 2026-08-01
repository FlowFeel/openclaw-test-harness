import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startPatchedOpenClaw, StartedOpenClawContainer } from "../support/openclaw-container.js";

describe("OpenClaw Container Integration (Testcontainers)", () => {
  let env: StartedOpenClawContainer;

  beforeAll(async () => {
    // Spin up the container dynamically
    env = await startPatchedOpenClaw();
  }, 120000); // 120s timeout to allow container download/start

  afterAll(async () => {
    if (env && env.container) {
      await env.container.stop();
    }
  });

  it("should compile and admit spawn when metrics are healthy in container", async () => {
    const result = await env.executeAdmissionCheck({
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

  it("should reject spawn when at concurrent limit in container", async () => {
    const result = await env.executeAdmissionCheck({
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
    expect(result.governingCap).toBe("subagents.maxConcurrent");
    expect(result.error).toContain("global max concurrent");
  });

  it("should reject spawn when timed-out subagents exist in container", async () => {
    const result = await env.executeAdmissionCheck({
      callerDepth: 0,
      maxSpawnDepth: 2,
      activeChildren: 0,
      maxActiveChildren: 2,
      globalActive: 1,
      maxConcurrent: 2,
      timedOutSubagents: ["agent:main:subagent:1"],
      runTimeoutSeconds: 300,
      collect: false,
    });
    
    expect(result.ok).toBe(false);
    expect(result.governingCap).toBe("subagents.runTimeoutSeconds");
    expect(result.error).toContain("must be cleaned up");
  });
});
