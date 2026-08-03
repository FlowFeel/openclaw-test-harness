/**
 * Research Task Specs — declarative task format for research workflows.
 *
 * #23: Jan describes research tasks declaratively, not as free-form prompts.
 * Tasks have types, dependencies, output formats, and depth constraints.
 *
 * @behavior
 * Validates task specs, resolves dependency graphs, computes execution
 * order, and groups tasks by depth for the work queue dispatcher (#18).
 *
 * @invariants
 * - Pure: no I/O, no clock, no random
 * - Immutable: returns new values
 * - Cycle detection in dependency graph (throws on cycles)
 *
 * @dft
 * - All functions testable with inline data
 * - Deterministic: same input → same output
 */

// ── Types ─────────────────────────────────────────────────────

export type TaskType = "search" | "read" | "analyze" | "synthesize" | "cartograph";
export type OutputFormat = "summary" | "citations" | "full" | "mindmap";
export type Priority = "high" | "normal" | "low";

export interface ResearchTaskSpec {
  id: string;
  type: TaskType;
  query: string;
  depth: 1 | 2;
  priority?: Priority;
  dependsOn?: string[];
  outputFormat?: OutputFormat;
  maxTokens?: number;
}

export interface ValidatedTask {
  spec: ResearchTaskSpec;
  valid: boolean;
  errors: string[];
}

export interface ExecutionGroup {
  depth: number;
  taskIds: string[];
  canRunInParallel: boolean;
}

export interface ExecutionPlan {
  groups: ExecutionGroup[];
  totalTasks: number;
  estimatedDepth: number;
  hasCycles: boolean;
  cycleTaskIds?: string[];
}

// ── Pure logic ────────────────────────────────────────────────

/**
 * Validate a single task spec.
 */
export function validateTaskSpec(spec: ResearchTaskSpec): ValidatedTask {
  const errors: string[] = [];

  if (!spec.id || spec.id.trim().length === 0) {
    errors.push("id is required");
  }

  if (!spec.query || spec.query.trim().length === 0) {
    errors.push("query is required");
  }

  if (spec.depth < 1 || spec.depth > 2) {
    errors.push(`depth must be 1 or 2, got ${spec.depth}`);
  }

  const validTypes: TaskType[] = ["search", "read", "analyze", "synthesize", "cartograph"];
  if (!validTypes.includes(spec.type)) {
    errors.push(`type must be one of ${validTypes.join(", ")}, got ${spec.type}`);
  }

  const validFormats: OutputFormat[] = ["summary", "citations", "full", "mindmap"];
  if (spec.outputFormat && !validFormats.includes(spec.outputFormat)) {
    errors.push(`outputFormat must be one of ${validFormats.join(", ")}`);
  }

  if (spec.maxTokens !== undefined && spec.maxTokens < 100) {
    errors.push("maxTokens must be >= 100");
  }

  // Type-specific constraints
  if (spec.type === "synthesize" && spec.depth < 2) {
    errors.push("synthesize tasks should be depth 2 (requires analysis results)");
  }

  if (spec.type === "search" && spec.depth > 1) {
    errors.push("search tasks should be depth 1 (leaf-level retrieval)");
  }

  return {
    spec,
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a batch of task specs and check for dependency issues.
 */
export function validateTaskBatch(specs: ResearchTaskSpec[]): {
  valid: ValidatedTask[];
  hasMissingDeps: boolean;
  missingDepRefs: string[];
} {
  const valid = specs.map(validateTaskSpec);
  const ids = new Set(specs.map((s) => s.id));
  const missingDepRefs: string[] = [];

  for (const spec of specs) {
    for (const dep of spec.dependsOn ?? []) {
      if (!ids.has(dep)) {
        missingDepRefs.push(`${spec.id} → ${dep}`);
      }
    }
  }

  return {
    valid,
    hasMissingDeps: missingDepRefs.length > 0,
    missingDepRefs,
  };
}

/**
 * Detect cycles in the dependency graph using DFS.
 * Returns task IDs that are part of a cycle.
 */
export function detectCycles(specs: ResearchTaskSpec[]): string[] {
  const graph = new Map<string, string[]>();
  for (const spec of specs) {
    graph.set(spec.id, spec.dependsOn ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycleNodes: string[] = [];

  function dfs(node: string): boolean {
    if (inStack.has(node)) {
      cycleNodes.push(node);
      return true;
    }
    if (visited.has(node)) return false;

    visited.add(node);
    inStack.add(node);

    const deps = graph.get(node) ?? [];
    for (const dep of deps) {
      if (dfs(dep)) {
        if (!cycleNodes.includes(node)) cycleNodes.push(node);
      }
    }

    inStack.delete(node);
    return false;
  }

  for (const spec of specs) {
    if (!visited.has(spec.id)) {
      dfs(spec.id);
    }
  }

  return cycleNodes;
}

/**
 * Compute an execution plan from task specs.
 * Groups tasks by depth and dependency layers.
 */
export function computeExecutionPlan(specs: ResearchTaskSpec[]): ExecutionPlan {
  const cycleNodes = detectCycles(specs);

  if (cycleNodes.length > 0) {
    return {
      groups: [],
      totalTasks: specs.length,
      estimatedDepth: 0,
      hasCycles: true,
      cycleTaskIds: cycleNodes,
    };
  }

  // Topological sort with depth grouping
  const visited = new Set<string>();
  const groups: ExecutionGroup[] = [];

  // Layer 0: tasks with no dependencies
  // Layer N: tasks whose dependencies are all in layers 0..N-1
  let remaining = [...specs];

  while (remaining.length > 0) {
    const layer: string[] = [];

    for (const spec of remaining) {
      const deps = spec.dependsOn ?? [];
      if (deps.every((d) => visited.has(d))) {
        layer.push(spec.id);
      }
    }

    if (layer.length === 0) {
      // Shouldn't happen if no cycles, but guard against infinite loop
      break;
    }

    for (const id of layer) {
      visited.add(id);
    }

    // Find the max depth of tasks in this layer
    const layerSpecs = specs.filter((s) => layer.includes(s.id));
    const maxDepth = Math.max(...layerSpecs.map((s) => s.depth));

    groups.push({
      depth: groups.length === 0 ? 1 : maxDepth,
      taskIds: layer,
      canRunInParallel: true,
    });

    remaining = remaining.filter((s) => !layer.includes(s.id));
  }

  return {
    groups,
    totalTasks: specs.length,
    estimatedDepth: groups.length,
    hasCycles: false,
  };
}

/**
 * Convert research task specs into work queue task specs (#18).
 */
export function toWorkQueueTasks(specs: ResearchTaskSpec[]): Array<{
  id: string;
  prompt: string;
  priority: Priority;
  dependsOn: string[];
}> {
  return specs.map((spec) => ({
    id: spec.id,
    prompt: `[${spec.type}] ${spec.query} (depth: ${spec.depth}, output: ${spec.outputFormat ?? "summary"})`,
    priority: spec.priority ?? "normal",
    dependsOn: spec.dependsOn ?? [],
  }));
}
