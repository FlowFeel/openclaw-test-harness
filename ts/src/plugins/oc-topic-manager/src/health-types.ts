/**
 * Types for topic health telemetry and zombie detector (T-584).
 *
 * @dft
 * - Pure type definitions only.
 */

export type TopicHealthIssue =
  | "CRITICAL_CONTEXT_CEILING"
  | "DEAD_TOPIC"
  | "ZOMBIE_RUNNING"
  | "UNCOMPACTED_BLOAT";

export type TopicRemedy = "sanitize_transcript" | "materialize_successor";

export interface TopicHealthEvaluation {
  topicId: number;
  sessionKey: string;
  verdicts: TopicHealthIssue[];
  remedy?: TopicRemedy;
  metrics: {
    contextTokens?: number;
    status?: string;
    abortedLastRun?: boolean;
    updatedAt?: number;
    transcriptSizeBytes?: number;
  };
}

export interface TopicHealthSummary {
  totalScanned: number;
  flaggedCount: number;
  byIssue: Record<TopicHealthIssue, number>;
  evaluations: TopicHealthEvaluation[];
}
