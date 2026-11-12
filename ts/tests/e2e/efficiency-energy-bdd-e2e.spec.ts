import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_DIR = path.resolve(__dirname, "../../src/plugins/oc-session-guard");

describe("E2E BDD: Plugins v2 Efficiency & Energy Budgeting in Real Container", () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    const builder = process.env.OC_TEST_IMAGE
      ? new GenericContainer(process.env.OC_TEST_IMAGE)
      : await GenericContainer.fromDockerfile(
          path.resolve(__dirname, "../../.."),
          "docker/Dockerfile",
        ).withCache(true).build();

    container = await builder
      .withWorkingDir("/app")
      .withBindMounts([
        { source: path.resolve(__dirname, "../.."), target: "/app/ts" },
      ])
      .withCommand(["tail", "-f", "/dev/null"])
      .start();
  }, 120000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  it("Scenario: Turn energy pool initial allocation and parsimonious execution in container runtime", async () => {
    const result = await container.exec([
      "node", "--experimental-strip-types", "-e",
      `import { initTurnEnergy, applyEnergyAction, formatEnergyEnvelopeHeader } from '/app/ts/src/plugins/shared/efficiency-energy-logic.ts';
       let state = initTurnEnergy('sovereign');
       if (state.initialEnergy !== 1200 || state.remainingEnergy !== 1200) {
         throw new Error('Initial energy mismatch');
       }
       state = applyEnergyAction(state, { toolName: 'read', durationMs: 2000 });
       const header = formatEnergyEnvelopeHeader(state);
       console.log(JSON.stringify({ remaining: state.remainingEnergy, header }));`,
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output.trim().split("\n").pop()!);
    expect(parsed.remaining).toBe(1183);
    expect(parsed.header).toContain("⚡ Energy: 1183/1200 (99%) | Tier: SOVEREIGN");
  });

  it("Scenario: Exhausted turn energy budget enforces soft-landing gating in container runtime", async () => {
    const result = await container.exec([
      "node", "--experimental-strip-types", "-e",
      `import { initTurnEnergy, applyEnergyAction } from '/app/ts/src/plugins/shared/efficiency-energy-logic.ts';
       let state = initTurnEnergy('constrained'); // 600E
       state = applyEnergyAction(state, { toolName: 'exec', durationMs: 300000 }); // burns 600E
       const isGatedBefore = state.isGated;
       const afterAttempt = applyEnergyAction(state, { toolName: 'read', durationMs: 100 });
       console.log(JSON.stringify({ isGated: isGatedBefore, actionCount: afterAttempt.actionsCount }));`,
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output.trim().split("\n").pop()!);
    expect(parsed.isGated).toBe(true);
    expect(parsed.actionCount).toBe(1); // Gated attempt did not increment actionsCount
  });

  it("Scenario: Bundled oc-session-guard plugin boots and registers session_health with habit telemetry card", async () => {
    // Run an execution script inside container against the bundled dist/index.js
    const result = await container.exec([
      "node", "-e",
      `const plugin = require('/app/ts/src/plugins/oc-session-guard/dist/index.js');
       const tools = [];
       const hooks = [];
       const mockApi = {
         on: (evt, h) => hooks.push(evt),
         registerTool: (t) => tools.push(t),
         logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
       };
       plugin.default.register(mockApi, {});
       console.log(JSON.stringify({
         id: plugin.default.id,
         hooks: hooks,
         tools: tools.map(t => t.name),
       }));`,
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output.trim().split("\n").pop()!);
    expect(parsed.id).toBe("oc-session-guard");
    expect(parsed.hooks).toContain("before_tool_call");
    expect(parsed.hooks).toContain("tool_result_persist");
    expect(parsed.hooks).toContain("agent_end");
    expect(parsed.tools).toContain("session_health");
  });
});
