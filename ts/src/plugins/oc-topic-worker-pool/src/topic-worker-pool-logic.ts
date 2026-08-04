/**
 * OcTopicWorkerPool — pure semaphore, pool, and topic routing logic.
 *
 * @behavior
 * Implements:
 *   1. A counting semaphore for admission control (before_agent_run acquires,
 *      agent_end releases). The await IS the backpressure.
 *   2. Topic session key parsing and pool routing for Telegram forum topics.
 *   3. Dedup key construction and dispatch decisions for before_dispatch.
 *
 * This module is PURE: it operates on plain state objects and returns
 * new data + reports. No I/O, no timers, no Date.now(). The wiring layer
 * (index.ts) creates the state once and passes it to every hook invocation.
 *
 * @invariants
 * - Every function is pure: same input → same output, no side effects.
 * - No imports of I/O modules (node:fs, node:http, etc.).
 * - No Date.now() / Math.random() — time is injected via options.nowMs.
 * - Mutating functions return a report (CheckResult pattern).
 * - Semaphore state is plain data: { max, active, ...counters }.
 *
 * @dft
 * - Tested in topic-worker-pool-logic.spec.ts with inline data, zero fixtures.
 * - No filesystem, no clock — fully deterministic.
 */

// ════════════════════════════════════════════════════════════════════════
// Part 1: Semaphore (admission control)
// ════════════════════════════════════════════════════════════════════════

/** The semaphore state. Plain data — the wiring layer owns the instance. */
export interface SemaphoreState {
  /** Maximum concurrent slots. */
  readonly max: number;
  /** Currently held slots. */
  active: number;
  /** Total acquisitions ever (monotonic counter for waiter IDs). */
  totalAcquired: number;
  /** Total releases ever. */
  totalReleased: number;
  /** Total times an acquire had to wait (backpressure events). */
  totalWaited: number;
  /** Peak concurrent usage. */
  peakActive: number;
}

/** A report returned by mutating operations (CheckResult pattern). */
export interface SemaphoreReport {
  readonly action: "acquired" | "queued" | "released" | "rejected";
  readonly active: number;
  readonly max: number;
  readonly waiterId?: number;
  readonly reason?: string;
}

/** Create a new semaphore state with the given max concurrency. */
export function createSemaphore(max: number): SemaphoreState {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`Semaphore max must be a positive integer, got: ${max}`);
  }
  return {
    max,
    active: 0,
    totalAcquired: 0,
    totalReleased: 0,
    totalWaited: 0,
    peakActive: 0,
  };
}

/**
 * Attempt to acquire a slot. Returns:
 *   - { action: "acquired" } if a slot was immediately available.
 *   - { action: "queued", waiterId } if the pool is full (caller must await).
 *
 * This is PURE — it only updates the state counter. The wiring layer is
 * responsible for the actual Promise/resolve plumbing when queued.
 */
export function acquire(state: SemaphoreState): SemaphoreReport {
  if (state.active < state.max) {
    state.active += 1;
    state.totalAcquired += 1;
    if (state.active > state.peakActive) {
      state.peakActive = state.active;
    }
    return {
      action: "acquired",
      active: state.active,
      max: state.max,
    };
  }
  // Pool full — the caller must wait. We don't block here (this is pure);
  // the wiring layer creates a Promise and resolves it on the next release.
  state.totalWaited += 1;
  const waiterId = state.totalAcquired + 1;
  return {
    action: "queued",
    active: state.active,
    max: state.max,
    waiterId,
  };
}

/**
 * Release a slot. Returns:
 *   - { action: "released" } if a slot was freed.
 *   - { action: "rejected" } if active was already 0 (double-release guard).
 *
 * The wiring layer checks if there are waiters and resolves the next one.
 */
export function release(state: SemaphoreState): SemaphoreReport {
  if (state.active <= 0) {
    return {
      action: "rejected",
      active: state.active,
      max: state.max,
      reason: "release called with no active slots",
    };
  }
  state.active -= 1;
  state.totalReleased += 1;
  return {
    action: "released",
    active: state.active,
    max: state.max,
  };
}

/** Snapshot the current pool stats (for health/metrics). */
export function getStats(state: SemaphoreState): {
  active: number;
  max: number;
  available: number;
  utilization: number;
  totalAcquired: number;
  totalReleased: number;
  totalWaited: number;
  peakActive: number;
} {
  return {
    active: state.active,
    max: state.max,
    available: state.max - state.active,
    utilization: state.active / state.max,
    totalAcquired: state.totalAcquired,
    totalReleased: state.totalReleased,
    totalWaited: state.totalWaited,
    peakActive: state.peakActive,
  };
}

/** Check if the pool is at capacity (no slots available). */
export function isFull(state: SemaphoreState): boolean {
  return state.active >= state.max;
}

/** Check if the pool has available slots. */
export function hasCapacity(state: SemaphoreState): boolean {
  return state.active < state.max;
}

// ════════════════════════════════════════════════════════════════════════
// Part 2: Topic routing (session key parsing + pool assignment)
// ════════════════════════════════════════════════════════════════════════

/** A parsed Telegram topic session key. */
export interface ParsedTopicSession {
  /** The chat ID (group/supergroup, may be negative for supergroups). */
  chatId: string;
  /** The topic ID within the forum. */
  topicId: string;
  /** The canonical conversation ID: "{chatId}:topic:{topicId}". */
  conversationId: string;
}

/** Routing configuration for pool assignment. */
export interface TopicRoutingConfig {
  /** Pool ID for topics that don't match any priority rule. */
  defaultPool: string;
  /** Priority routing: topic IDs that go to a dedicated pool. */
  priorityTopics?: Array<{ topicId: string; pool: string }>;
  /** Per-chat pools: all topics in this chat go to a dedicated pool. */
  chatPools?: Array<{ chatId: string; pool: string }>;
}

/** A routing decision returned by routeTopic. */
export interface RoutingDecision {
  /** The pool ID this topic should use. */
  pool: string;
  /** The parsed session (null if unparseable). */
  topic: ParsedTopicSession | null;
  /** Whether this was a priority route. */
  isPriority: boolean;
  /** Whether this was a per-chat route. */
  isChatRoute: boolean;
  /** Whether the session key was unparseable (non-topic session). */
  isNonTopic: boolean;
}

/**
 * Parse a Telegram topic session key.
 *
 * Session keys for forum topics contain "{chatId}:topic:{topicId}".
 * chatId can be negative (supergroups), topicId is positive.
 *
 * Returns null if the session key doesn't contain a topic segment
 * (e.g., a DM session or non-Telegram channel).
 */
export function parseTopicSessionKey(sessionKey: string): ParsedTopicSession | null {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return null;
  }

  const match = sessionKey.match(/(-?\d+):topic:(\d+)/);
  if (!match || !match[1] || !match[2]) {
    return null;
  }

  const chatId = match[1];
  const topicId = match[2];
  const conversationId = `${chatId}:topic:${topicId}`;

  return { chatId, topicId, conversationId };
}

/**
 * Route a topic session to a pool based on the routing config.
 *
 * Priority order:
 *   1. Priority topic match (specific topic → dedicated pool)
 *   2. Per-chat match (all topics in a chat → dedicated pool)
 *   3. Default pool
 *
 * Non-topic sessions (null parse) go to the default pool with isNonTopic=true.
 */
export function routeTopic(
  topic: ParsedTopicSession | null,
  config: TopicRoutingConfig,
): RoutingDecision {
  if (!topic) {
    return {
      pool: config.defaultPool,
      topic: null,
      isPriority: false,
      isChatRoute: false,
      isNonTopic: true,
    };
  }

  // 1. Priority topic match
  if (config.priorityTopics) {
    const priorityMatch = config.priorityTopics.find(
      (rule) => rule.topicId === topic.topicId,
    );
    if (priorityMatch) {
      return {
        pool: priorityMatch.pool,
        topic,
        isPriority: true,
        isChatRoute: false,
        isNonTopic: false,
      };
    }
  }

  // 2. Per-chat match
  if (config.chatPools) {
    const chatMatch = config.chatPools.find(
      (rule) => rule.chatId === topic.chatId,
    );
    if (chatMatch) {
      return {
        pool: chatMatch.pool,
        topic,
        isPriority: false,
        isChatRoute: true,
        isNonTopic: false,
      };
    }
  }

  // 3. Default pool
  return {
    pool: config.defaultPool,
    topic,
    isPriority: false,
    isChatRoute: false,
    isNonTopic: false,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Part 3: Dedup + dispatch decisions (for before_dispatch)
// ════════════════════════════════════════════════════════════════════════

/** A dedup key for short-circuit decisions. */
export interface DedupKey {
  /** A stable key for dedup: "{chatId}:{topicId}:{contentHash}". */
  key: string;
  /** Whether the key could be constructed (false = non-topic session). */
  valid: boolean;
}

/** A before_dispatch routing report (CheckResult pattern). */
export interface DispatchRouteReport {
  readonly action: "route" | "short-circuit" | "skip";
  readonly pool: string;
  readonly topic: ParsedTopicSession | null;
  readonly reason?: string;
  readonly replyText?: string;
}

/**
 * Build a dedup key for a before_dispatch event.
 *
 * This enables short-circuiting duplicate messages (same topic + same content)
 * within a time window. The wiring layer maintains the dedup cache; this
 * function just produces the key.
 *
 * contentHash is injected (pure) — the wiring layer hashes the content.
 */
export function buildDedupKey(
  topic: ParsedTopicSession | null,
  contentHash: string,
): DedupKey {
  if (!topic) {
    return { key: "", valid: false };
  }
  return {
    key: `${topic.chatId}:${topic.topicId}:${contentHash}`,
    valid: true,
  };
}

/**
 * Decide whether to short-circuit a before_dispatch event.
 *
 * Returns a DispatchRouteReport:
 *   - { action: "short-circuit", replyText } — skip the agent, reply directly.
 *   - { action: "route", pool } — proceed to the agent with pool assignment.
 *   - { action: "skip", reason } — skip silently (e.g., empty message).
 *
 * Short-circuit conditions:
 *   - isDuplicate: the dedup key was seen recently (wiring layer checks cache).
 *   - isEmpty: the content is empty or whitespace-only.
 */
export function decideDispatch(params: {
  topic: ParsedTopicSession | null;
  content: string;
  isDuplicate: boolean;
  pool: string;
}): DispatchRouteReport {
  // Empty content — skip silently
  const trimmed = params.content?.trim() ?? "";
  if (trimmed.length === 0) {
    return {
      action: "skip",
      pool: params.pool,
      topic: params.topic,
      reason: "empty content",
    };
  }

  // Duplicate — short-circuit with no reply (the original will handle it)
  if (params.isDuplicate) {
    return {
      action: "short-circuit",
      pool: params.pool,
      topic: params.topic,
      reason: "duplicate message",
      replyText: "",
    };
  }

  // Normal routing
  return {
    action: "route",
    pool: params.pool,
    topic: params.topic,
  };
}

/**
 * Compute a simple hash of content for dedup.
 * This is a pure function — same content → same hash.
 * Not cryptographically secure, but sufficient for dedup.
 */
export function hashContent(content: string): string {
  if (typeof content !== "string" || content.length === 0) {
    return "empty";
  }
  // Simple DJB2 hash — pure, deterministic, no crypto needed.
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
