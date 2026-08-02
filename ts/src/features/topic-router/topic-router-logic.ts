/**
 * Topic router pure logic — the testable seam of #16 (per-topic actor isolation).
 *
 * The routing, attribution, and crash-containment DECISIONS live here as pure
 * functions over immutable `ActorHandle` snapshots. The `TopicRouter` class (the
 * I/O wiring) calls these on snapshots of its actor map. Purity is the seam:
 * the decisions are testable without workers, without threads, without time —
 * the phosphene "pure logic as the seam" convention, same as #14's scheduler.
 *
 * Three decisions:
 *   - selectActorForTopic: route a request to the topic's actor, or null (spawn).
 *   - aggregateTopicStats: per-topic attribution (state / retryCount / active).
 *   - crashContainment: after a topic crashes, which topics are still serving?
 *     This makes the #16 isolation guarantee explicit and pure-testable: a crash
 *     of one topic affects ONLY that topic; siblings with live actors serve on.
 */

import type { ActorHandle } from "../supervision/supervisor.schema.js"
import type { SubagentState } from "../subagent-admission/subagent-admission.schema.js"
import { TerminalStates } from "../subagent-admission/subagent-admission.schema.js"

/** Per-topic attribution snapshot. `active` = the actor is live (not terminal). */
export interface TopicStat {
  readonly topic: string
  readonly state: SubagentState
  readonly retryCount: number
  readonly active: boolean
}

/** The result of a crash-containment decision. */
export interface CrashContainment {
  /** The topic that crashed. */
  readonly crashed: string
  /** Topics with LIVE actors still serving (excludes the crashed topic). */
  readonly serving: string[]
}

/**
 * Select the actor for a topic, or null if none exists (caller must spawn).
 * Pure routing decision: the router calls this to decide route-vs-spawn.
 */
export function selectActorForTopic(
  topic: string,
  actors: readonly ActorHandle[],
): ActorHandle | null {
  // The routing decision: the topic's actor is the one whose sessionKey
  // equals the topic. In #16, sessionKey IS the topic (one actor per topic).
  // null = no actor → the caller spawns (lazy: a topic gets an actor on first
  // dispatch). A terminal actor is still "found" — the caller composes this
  // with TerminalStates to decide route-vs-restart.
  return actors.find((a) => a.sessionKey === topic) ?? null
}

/**
 * Aggregate per-topic stats from actor handles. Pure attribution: the router
 * calls this for `topicStats()` (acceptance #2 — per-topic heap/CPU is
 * attributable via the supervisor's per-actor stats).
 */
export function aggregateTopicStats(actors: readonly ActorHandle[]): TopicStat[] {
  // Per-topic attribution: one stat per actor, in actor-map iteration order.
  // `active` = !TerminalStates.has(state) — the admission layer reads active
  // per topic to decide route-vs-restart, and reads the aggregate to report
  // per-topic health (acceptance #2).
  return actors.map((a) => ({
    topic: a.sessionKey,
    state: a.state,
    retryCount: a.retryCount,
    active: !TerminalStates.has(a.state),
  }))
}

/**
 * Crash-containment decision: after `crashedTopic` crashes, which topics are
 * still serving? Pure: `serving` = topics with LIVE (non-terminal) actors,
 * excluding the crashed topic. This makes the #16 isolation guarantee explicit
 * — a crash of one topic affects ONLY that topic; siblings with live actors
 * continue serving (acceptance #1, pure part).
 */
export function crashContainment(
  crashedTopic: string,
  actors: readonly ActorHandle[],
): CrashContainment {
  // The #16 isolation guarantee, made pure: a crash of one topic affects ONLY
  // that topic. `serving` = topics with LIVE (non-terminal) actors, excluding
  // the crashed topic. Siblings on separate workers continue serving — the
  // crash does not propagate. (The integration test proves this with real
  // workers; this pure function proves the decision is structural.)
  const serving = actors
    .filter((a) => a.sessionKey !== crashedTopic && !TerminalStates.has(a.state))
    .map((a) => a.sessionKey)
  return { crashed: crashedTopic, serving }
}
