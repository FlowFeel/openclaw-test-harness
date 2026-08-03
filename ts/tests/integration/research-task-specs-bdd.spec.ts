/**
 * BDD tests for #23: Research Task Specifications.
 */

import { describe, it, expect } from "vitest";
import {
  validateTaskSpec,
  validateTaskBatch,
  detectCycles,
  computeExecutionPlan,
  toWorkQueueTasks,
  type ResearchTaskSpec,
} from "../../src/plugins/shared/research-task-specs.js";

// ═══════════════════════════════════════════════════════════════

describe("Feature: Task Spec Validation", () => {
  it("Scenario: Valid search task passes", () => {
    const spec: ResearchTaskSpec = {
      id: "search-1",
      type: "search",
      query: "find papers on Australopithecus",
      depth: 1,
    };
    const result = validateTaskSpec(spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("Scenario: Missing id fails", () => {
    const result = validateTaskSpec({
      id: "",
      type: "search",
      query: "test",
      depth: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("Scenario: Missing query fails", () => {
    const result = validateTaskSpec({
      id: "t1",
      type: "search",
      query: "",
      depth: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("query"))).toBe(true);
  });

  it("Scenario: Depth 3 fails (max is 2)", () => {
    const result = validateTaskSpec({
      id: "t1",
      type: "analyze",
      query: "test",
      depth: 3 as 2,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("depth"))).toBe(true);
  });

  it("Scenario: Synthesize at depth 1 warns (should be depth 2)", () => {
    const result = validateTaskSpec({
      id: "t1",
      type: "synthesize",
      query: "synthesize findings",
      depth: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("synthesize") && e.includes("depth 2"))).toBe(true);
  });

  it("Scenario: Search at depth 2 warns (should be depth 1)", () => {
    const result = validateTaskSpec({
      id: "t1",
      type: "search",
      query: "test",
      depth: 2,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("search") && e.includes("depth 1"))).toBe(true);
  });

  it("Scenario: Invalid output format fails", () => {
    const result = validateTaskSpec({
      id: "t1",
      type: "search",
      query: "test",
      depth: 1,
      outputFormat: "invalid" as any,
    });
    expect(result.valid).toBe(false);
  });

  it("Scenario: maxTokens below 100 fails", () => {
    const result = validateTaskSpec({
      id: "t1",
      type: "search",
      query: "test",
      depth: 1,
      maxTokens: 50,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maxTokens"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Batch Validation & Missing Dependencies", () => {
  it("Scenario: All valid specs with satisfied deps pass", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "search-1", type: "search", query: "A", depth: 1 },
      { id: "analyze-1", type: "analyze", query: "B", depth: 2, dependsOn: ["search-1"] },
    ];
    const result = validateTaskBatch(specs);
    expect(result.hasMissingDeps).toBe(false);
    expect(result.missingDepRefs).toHaveLength(0);
  });

  it("Scenario: Missing dependency reference is flagged", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "analyze-1", type: "analyze", query: "B", depth: 2, dependsOn: ["nonexistent"] },
    ];
    const result = validateTaskBatch(specs);
    expect(result.hasMissingDeps).toBe(true);
    expect(result.missingDepRefs).toContain("analyze-1 → nonexistent");
  });

  it("Scenario: Multiple missing deps all flagged", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "a", type: "analyze", query: "x", depth: 2, dependsOn: ["missing1", "missing2"] },
      { id: "b", type: "synthesize", query: "y", depth: 2, dependsOn: ["missing3"] },
    ];
    const result = validateTaskBatch(specs);
    expect(result.missingDepRefs).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Cycle Detection", () => {
  it("Scenario: No cycles in linear dependency chain", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "a", type: "search", query: "x", depth: 1 },
      { id: "b", type: "analyze", query: "y", depth: 2, dependsOn: ["a"] },
      { id: "c", type: "synthesize", query: "z", depth: 2, dependsOn: ["b"] },
    ];
    expect(detectCycles(specs)).toHaveLength(0);
  });

  it("Scenario: Direct cycle A → B → A detected", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "a", type: "analyze", query: "x", depth: 2, dependsOn: ["b"] },
      { id: "b", type: "analyze", query: "y", depth: 2, dependsOn: ["a"] },
    ];
    const cycles = detectCycles(specs);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("Scenario: Self-dependency detected", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "a", type: "analyze", query: "x", depth: 2, dependsOn: ["a"] },
    ];
    const cycles = detectCycles(specs);
    expect(cycles).toContain("a");
  });

  it("Scenario: Diamond dependency (no cycle)", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "a", type: "search", query: "x", depth: 1 },
      { id: "b", type: "search", query: "y", depth: 1 },
      { id: "c", type: "analyze", query: "z", depth: 2, dependsOn: ["a", "b"] },
      { id: "d", type: "synthesize", query: "w", depth: 2, dependsOn: ["a", "b"] },
    ];
    expect(detectCycles(specs)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Execution Plan Computation", () => {
  it("Scenario: Linear chain produces 3 sequential layers", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "search", type: "search", query: "x", depth: 1 },
      { id: "analyze", type: "analyze", query: "y", depth: 2, dependsOn: ["search"] },
      { id: "synthesize", type: "synthesize", query: "z", depth: 2, dependsOn: ["analyze"] },
    ];
    const plan = computeExecutionPlan(specs);
    expect(plan.hasCycles).toBe(false);
    expect(plan.groups).toHaveLength(3);
    expect(plan.groups[0].taskIds).toContain("search");
    expect(plan.groups[1].taskIds).toContain("analyze");
    expect(plan.groups[2].taskIds).toContain("synthesize");
  });

  it("Scenario: Independent tasks all in one layer (parallel)", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "a", type: "search", query: "x", depth: 1 },
      { id: "b", type: "search", query: "y", depth: 1 },
      { id: "c", type: "search", query: "z", depth: 1 },
    ];
    const plan = computeExecutionPlan(specs);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].taskIds).toHaveLength(3);
    expect(plan.groups[0].canRunInParallel).toBe(true);
  });

  it("Scenario: Diamond produces 3 layers", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "a", type: "search", query: "x", depth: 1 },
      { id: "b", type: "search", query: "y", depth: 1 },
      { id: "c", type: "analyze", query: "z", depth: 2, dependsOn: ["a", "b"] },
      { id: "d", type: "synthesize", query: "w", depth: 2, dependsOn: ["c"] },
    ];
    const plan = computeExecutionPlan(specs);
    expect(plan.hasCycles).toBe(false);
    expect(plan.estimatedDepth).toBe(3);
  });

  it("Scenario: Cyclic graph produces empty plan with cycle flag", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "a", type: "analyze", query: "x", depth: 2, dependsOn: ["b"] },
      { id: "b", type: "analyze", query: "y", depth: 2, dependsOn: ["a"] },
    ];
    const plan = computeExecutionPlan(specs);
    expect(plan.hasCycles).toBe(true);
    expect(plan.groups).toHaveLength(0);
    expect(plan.cycleTaskIds).toBeDefined();
    expect(plan.cycleTaskIds!.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Work Queue Integration", () => {
  it("Scenario: Research specs convert to work queue tasks", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "s1", type: "search", query: "papers on Homo erectus", depth: 1, priority: "high" },
      { id: "a1", type: "analyze", query: "analyze morphology", depth: 2, dependsOn: ["s1"] },
    ];
    const tasks = toWorkQueueTasks(specs);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("s1");
    expect(tasks[0].priority).toBe("high");
    expect(tasks[0].prompt).toContain("[search]");
    expect(tasks[1].dependsOn).toContain("s1");
  });

  it("Scenario: Default priority is normal", () => {
    const specs: ResearchTaskSpec[] = [
      { id: "s1", type: "search", query: "test", depth: 1 },
    ];
    const tasks = toWorkQueueTasks(specs);
    expect(tasks[0].priority).toBe("normal");
  });

  it("Scenario: Prompt includes type, query, depth, and output format", () => {
    const specs: ResearchTaskSpec[] = [
      {
        id: "s1",
        type: "synthesize",
        query: "merge findings",
        depth: 2,
        outputFormat: "mindmap",
      },
    ];
    const tasks = toWorkQueueTasks(specs);
    expect(tasks[0].prompt).toContain("[synthesize]");
    expect(tasks[0].prompt).toContain("merge findings");
    expect(tasks[0].prompt).toContain("depth: 2");
    expect(tasks[0].prompt).toContain("mindmap");
  });
});
