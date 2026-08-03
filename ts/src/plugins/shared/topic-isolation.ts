/**
 * Topic Isolation — per-topic budget allocation and slot borrowing for
 * subagent concurrency control across different conversation topics.
 *
 * @behavior
 * Each topic gets a share of the global `maxConcurrent` subagent slots.
 * Topics can borrow unused slots from other topics to handle spikes.
 * Borrowed slots are returned when no longer needed.
 *
 * @invariants
 * - All functions are pure (input → output, no mutation)
 * - No Date.now() — no clock dependency
 * - No I/O — no network, no filesystem
 * - Deterministic: given the same inputs, always the same outputs
 * - Immutable: returns new values, never mutates inputs
 *
 * @dft
 * - All functions testable with inline data
 * - Deterministic: no random, no clock
 * - Immutable: returns new objects, never mutates
 */

// ── Types ─────────────────────────────────────────────────────

export interface TopicBudget {
  topic: string;
  maxConcurrent: number;
  activeCount: number;
  borrowed: number;
}

export interface TopicStats {
  topic: string;
  active: number;
  available: number;
  borrowed: number;
}

// ── Pure Helpers ──────────────────────────────────────────────

/**
 * Deep clone a TopicBudget (immutable helper).
 */
function cloneBudget(b: TopicBudget): TopicBudget {
  return { ...b };
}

/**
 * Deep clone a Map<string, TopicBudget>.
 */
function cloneBudgetMap(
  map: Map<string, TopicBudget>
): Map<string, TopicBudget> {
  const clone = new Map<string, TopicBudget>();
  for (const [key, value] of map) {
    clone.set(key, cloneBudget(value));
  }
  return clone;
}

// ── Budget Allocation ─────────────────────────────────────────

/**
 * Allocate `maxConcurrent` slots evenly across the given topics.
 *
 * Slots are divided evenly: each topic gets at least `floor(maxConcurrent / N)`.
 * Remaining slots are distributed one-per-topic to the first N topics.
 * If `maxConcurrent` is 0, all topics get 0.
 * All topics start with `activeCount = 0` and `borrowed = 0`.
 *
 * @returns A new Map from topic name to TopicBudget (never mutates inputs).
 */
export function allocateBudget(
  topics: string[],
  maxConcurrent: number
): Map<string, TopicBudget> {
  const n = topics.length;
  const budget = new Map<string, TopicBudget>();

  if (n === 0 || maxConcurrent <= 0) {
    for (const topic of topics) {
      budget.set(topic, {
        topic,
        maxConcurrent: 0,
        activeCount: 0,
        borrowed: 0,
      });
    }
    return budget;
  }

  const base = Math.floor(maxConcurrent / n);
  const remainder = maxConcurrent % n;

  for (let i = 0; i < n; i++) {
    const allocation = base + (i < remainder ? 1 : 0);
    budget.set(topics[i], {
      topic: topics[i],
      maxConcurrent: allocation,
      activeCount: 0,
      borrowed: 0,
    });
  }

  return budget;
}

// ── Spawn Capacity ────────────────────────────────────────────

/**
 * Check whether a topic has capacity to spawn another subagent.
 *
 * A topic has capacity when `activeCount < maxConcurrent + borrowed`.
 * Borrowed slots increase the topic's effective capacity.
 *
 * @returns `true` if there is at least one available slot.
 */
export function canSpawnForTopic(budget: TopicBudget): boolean {
  return budget.activeCount < budget.maxConcurrent + budget.borrowed;
}

// ── Slot Borrowing ────────────────────────────────────────────

/**
 * Borrow one unused slot from `from` and add it to `to`.
 *
 * A slot can only be borrowed from a topic that has available capacity:
 * `from.activeCount < from.maxConcurrent`.
 *
 * @throws {Error} if `from` has no available slots to lend.
 * @returns New `{ from, to }` objects (original budgets are not mutated).
 */
export function borrowSlot(
  from: TopicBudget,
  to: TopicBudget
): { from: TopicBudget; to: TopicBudget } {
  if (from.activeCount >= from.maxConcurrent) {
    throw new Error(
      `cannot borrow from "${from.topic}": no available slots ` +
        `(active=${from.activeCount}, max=${from.maxConcurrent})`
    );
  }

  return {
    from: {
      ...from,
    },
    to: {
      ...to,
      borrowed: to.borrowed + 1,
    },
  };
}

/**
 * Return one borrowed slot, decrementing the borrowed counter.
 *
 * The borrowed count is floored at 0.
 *
 * @returns A new TopicBudget with the borrowed count decremented.
 */
export function returnBorrowedSlot(budget: TopicBudget): TopicBudget {
  return {
    ...budget,
    borrowed: Math.max(0, budget.borrowed - 1),
  };
}

// ── Stats Computation ─────────────────────────────────────────

/**
 * Compute per-topic statistics from the current budgets.
 *
 * `available` = `(maxConcurrent + borrowed) - activeCount`
 *
 * A negative `available` value means the topic is over its effective capacity.
 */
export function computeTopicStats(
  budgets: Map<string, TopicBudget>
): TopicStats[] {
  const stats: TopicStats[] = [];

  // Iterate in insertion order (Map preserves insertion order)
  for (const budget of budgets.values()) {
    const available =
      budget.maxConcurrent + budget.borrowed - budget.activeCount;
    stats.push({
      topic: budget.topic,
      active: budget.activeCount,
      available,
      borrowed: budget.borrowed,
    });
  }

  return stats;
}

// ── Bottleneck Detection ─────────────────────────────────────

/**
 * Find the topic causing the most scheduling pressure (the bottleneck).
 *
 * The bottleneck is the topic with the smallest (most negative) `available`
 * value. If multiple topics tie for the same `available`, the first one
 * encountered is returned.
 *
 * @returns The topic name with the most pressure, or `null` if:
 *   - All topics have identical `available` values (tie), OR
 *   - All topics have `available >= 0` and there is no clear bottleneck.
 *
 *   In other words: returns the topic name only when one topic strictly
 *   has the lowest (most negative) available value.
 */
export function getBottleneckTopic(
  stats: TopicStats[]
): string | null {
  if (stats.length === 0) {
    return null;
  }

  // Find the minimum available value and the topic(s) with that value
  let minAvailable = stats[0].available;
  let minTopic = stats[0].topic;
  let isTie = false;

  for (let i = 1; i < stats.length; i++) {
    const s = stats[i];
    if (s.available < minAvailable) {
      minAvailable = s.available;
      minTopic = s.topic;
      isTie = false;
    } else if (s.available === minAvailable) {
      // Only mark tie if values are truly the same
      isTie = true;
    }
  }

  // If there was a tie for the minimum, no clear bottleneck
  if (isTie) {
    return null;
  }

  // If the minimum is >= 0, there's no bottleneck (all topics have capacity)
  if (minAvailable >= 0) {
    return null;
  }

  return minTopic;
}