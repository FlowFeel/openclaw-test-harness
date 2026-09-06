/**
 * oc-topic-manager — shared types.
 *
 * @dft
 * - Pure data contracts only. No behavior, no I/O.
 */

/** A Telegram forum topic, normalized from Bot API payloads. */
export interface TopicMeta {
  /** Forum topic id (message_thread_id). */
  id: number;
  title: string;
  messageCount: number;
  /** ISO-8601 timestamp of last known activity, if any. */
  lastActiveAt: string;
  pinned: boolean;
}

/** A topic → session registration as recorded in OC's registry. */
export interface SessionRegistration {
  topicId: number;
  sessionKey: string;
}

/** Result of comparing forum topics against the session registry. */
export interface OrphanReport {
  /** Topics that exist on Telegram but have no session registration. */
  orphaned: TopicMeta[];
  /** Registrations whose topic no longer exists in the forum. */
  unregistered: SessionRegistration[];
}

/** Full topic_audit output: registry mismatches plus per-topic archival decisions. */
export interface TopicAuditReport extends OrphanReport {
  /** Archival policy decision for every topic in the forum payload. */
  archivalDecisions: ArchivalDecision[];
}

/** Thresholds governing the archival policy. */
export interface ArchivalThresholds {
  maxIdleDays: number;
  maxMessages: number;
}

/** What the policy says should happen to a topic. */
export interface ArchivalDecision {
  topicId: number;
  action: "archive" | "compact" | "leave";
  reason: string;
}

/** A concrete plan to re-register an orphaned topic. */
export interface RecoveryPlan {
  topicId: number;
  chatId: string;
  agentId: string;
  sessionKey: string;
  action: "register";
}

/** A6 report for an applied (or refused) recovery plan. */
export interface RecoveryApplication {
  topicId: number;
  sessionKey: string;
  /** True when the registry now contains the sessionKey (or already did). */
  applied: boolean;
  /** False when the key was already registered — idempotent no-op. */
  created: boolean;
  before: "absent" | "present";
  after: "registered";
  /** Set when applied is false. */
  reason?: string;
}