/**
 * Poll deduplication and frame suppression logic.
 *
 * @behavior
 * - Detects repetitive, zero-delta tool results from `process(action="poll")`,
 *   `process(action="log")`, or shell commands (`(no new output)`, `Process still running`).
 * - Replaces bulky multi-line poll result blocks with compact single-line marker: `[poll: active pid=%d]`.
 * - Suppresses consecutive zero-delta poll messages in `before_message_write`.
 *
 * @invariants
 * - Pure logic: no direct I/O, no timers.
 */

export const ZERO_DELTA_POLL_PATTERNS = [
  /\(no new output\)/i,
  /Process still running/i,
  /in_progress None/i,
  /No new output for/i,
];

export interface PollExtraction {
  isZeroDeltaPoll: boolean;
  pid?: number;
  sessionId?: string;
}

/**
 * Checks if a tool result text represents a zero-delta poll output.
 */
export function isZeroDeltaPollText(text: string): boolean {
  return ZERO_DELTA_POLL_PATTERNS.some((pat) => pat.test(text));
}

/**
 * Extracts PID or session details from tool result or details.
 */
export function extractPollDetails(
  text: string,
  details?: Record<string, unknown>,
): { pid?: number; sessionId?: string } {
  let pid: number | undefined;
  let sessionId: string | undefined;

  if (details && typeof details === "object") {
    if (typeof details.pid === "number") {
      pid = details.pid;
    }
    if (typeof details.sessionId === "string") {
      sessionId = details.sessionId;
    }
  }

  if (!pid) {
    const pidMatch = text.match(/pid[:=\s]+(\d+)/i);
    if (pidMatch && pidMatch[1]) {
      pid = parseInt(pidMatch[1], 10);
    }
  }

  if (!sessionId) {
    const sessionMatch = text.match(/sessionId[:=\s]+([a-zA-Z0-9_-]+)/i);
    if (sessionMatch && sessionMatch[1]) {
      sessionId = sessionMatch[1];
    }
  }

  return { pid, sessionId };
}

/**
 * Compacts zero-delta poll text into a single-line marker.
 */
export function compactPollMarker(pid?: number, sessionId?: string): string {
  if (pid !== undefined) {
    return `[poll: active pid=${pid}]`;
  }
  if (sessionId) {
    return `[poll: active session=${sessionId}]`;
  }
  return `[poll: active]`;
}

/**
 * Evaluates whether a tool result message is a zero-delta poll and compacts it.
 */
export function compactZeroDeltaPollMessage(
  message: Record<string, unknown>,
  toolName?: string,
): { message: Record<string, unknown>; changed: boolean; isZeroDelta: boolean } {
  // Check tool name if available (process poll, process log, exec)
  const isTargetTool =
    !toolName ||
    toolName === "process" ||
    toolName === "exec" ||
    toolName === "task_status";

  if (!isTargetTool) {
    return { message, changed: false, isZeroDelta: false };
  }

  let textContent = "";
  if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        textContent += (item as { text: string }).text + "\n";
      }
    }
  } else if (typeof message.content === "string") {
    textContent = message.content;
  }

  if (!isZeroDeltaPollText(textContent)) {
    return { message, changed: false, isZeroDelta: false };
  }

  const details = (message.details && typeof message.details === "object")
    ? (message.details as Record<string, unknown>)
    : undefined;
  const { pid, sessionId } = extractPollDetails(textContent, details);
  const marker = compactPollMarker(pid, sessionId);

  const nextMessage = { ...message };
  if (Array.isArray(nextMessage.content)) {
    nextMessage.content = [{ type: "text", text: marker }];
  } else {
    nextMessage.content = marker;
  }

  return { message: nextMessage, changed: true, isZeroDelta: true };
}

/**
 * State tracking for consecutive poll frame suppression.
 */
export interface PollDeduplicationState {
  lastMessageIsZeroDeltaPoll: boolean;
  suppressedPollCount: number;
}

export function createInitialPollDeduplicationState(): PollDeduplicationState {
  return {
    lastMessageIsZeroDeltaPoll: false,
    suppressedPollCount: 0,
  };
}

/**
 * Pure evaluation for before_message_write:
 * If the current message is a zero-delta poll result and the previous persisted message
 * was also a zero-delta poll result, suppress this message (block=true) and increment count.
 */
export function evaluateMessageWriteSuppression(
  message: Record<string, unknown>,
  state: PollDeduplicationState,
  toolName?: string,
): { block: boolean; nextState: PollDeduplicationState; message?: Record<string, unknown> } {
  const compacted = compactZeroDeltaPollMessage(message, toolName);

  if (!compacted.isZeroDelta) {
    // Non-poll or non-zero-delta message resets poll suppression state
    return {
      block: false,
      nextState: {
        lastMessageIsZeroDeltaPoll: false,
        suppressedPollCount: 0,
      },
    };
  }

  if (state.lastMessageIsZeroDeltaPoll) {
    // Consecutive zero-delta poll: block writing to transcript
    return {
      block: true,
      nextState: {
        lastMessageIsZeroDeltaPoll: true,
        suppressedPollCount: state.suppressedPollCount + 1,
      },
    };
  }

  // First zero-delta poll in sequence: allow it (with compacted text)
  return {
    block: false,
    message: compacted.message,
    nextState: {
      lastMessageIsZeroDeltaPoll: true,
      suppressedPollCount: 0,
    },
  };
}

// ── T-585: Turn-Level Polling Budget ─────────────────────────────

export interface TurnPollState {
  cumulativePollMs: number;
  pollCount: number;
}

export interface PollBudgetConfig {
  turnPollBudgetMs?: number;
  enableTurnPollBudget?: boolean;
}

export const DEFAULT_POLL_BUDGET_MS = 90000;

export interface PollBudgetVerdict {
  allowed: boolean;
  cumulativePollMs: number;
  requestedTimeoutMs: number;
  budgetMs: number;
  nextState: TurnPollState;
  error?: {
    error: "POLL_BUDGET_EXHAUSTED";
    message: string;
  };
}

export function createInitialTurnPollState(): TurnPollState {
  return {
    cumulativePollMs: 0,
    pollCount: 0,
  };
}

export function evaluateTurnPollBudget(
  state: TurnPollState,
  requestedTimeoutMs: number,
  config?: PollBudgetConfig,
): PollBudgetVerdict {
  const enabled = config?.enableTurnPollBudget ?? true;
  const budgetMs = config?.turnPollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
  const timeout = Math.max(0, requestedTimeoutMs);

  if (!enabled) {
    return {
      allowed: true,
      cumulativePollMs: state.cumulativePollMs + timeout,
      requestedTimeoutMs: timeout,
      budgetMs,
      nextState: {
        cumulativePollMs: state.cumulativePollMs + timeout,
        pollCount: state.pollCount + 1,
      },
    };
  }

  if (state.cumulativePollMs + timeout > budgetMs) {
    return {
      allowed: false,
      cumulativePollMs: state.cumulativePollMs,
      requestedTimeoutMs: timeout,
      budgetMs,
      nextState: state,
      error: {
        error: "POLL_BUDGET_EXHAUSTED",
        message: `Cumulative synchronous polling in this turn has reached ${Math.round(budgetMs / 1000)}s (requested: ${Math.round(timeout / 1000)}s, accumulated: ${Math.round(state.cumulativePollMs / 1000)}s). Further synchronous wait is blocked to protect the 600s lane cap. Release turn now and check status via background task, cron wake, or next conversational turn.`,
      },
    };
  }

  const nextCumulative = state.cumulativePollMs + timeout;
  return {
    allowed: true,
    cumulativePollMs: nextCumulative,
    requestedTimeoutMs: timeout,
    budgetMs,
    nextState: {
      cumulativePollMs: nextCumulative,
      pollCount: state.pollCount + 1,
    },
  };
}
