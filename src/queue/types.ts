/**
 * Queue Types
 *
 * Priority queue for scheduling user stories across agents.
 * Enables future parallel agent execution.
 */

/** Queue item status */
export type QueueItemStatus = "pending" | "in-progress" | "completed" | "failed" | "skipped";

/** Queue item representing a user story to be executed */
export interface QueueItem {
  /** Unique story ID */
  storyId: string;
  /** Display title */
  title: string;
  /** Priority score (higher = more urgent) */
  priority: number;
  /** Current status */
  status: QueueItemStatus;
  /** Assigned agent (if any) */
  assignedAgent?: string;
  /** Number of retry attempts */
  attempts: number;
  /** Timestamp when added to queue */
  addedAt: Date;
  /** Timestamp when started (if in-progress) */
  startedAt?: Date;
  /** Timestamp when completed/failed */
  completedAt?: Date;
  /** Error message (if failed) */
  error?: string;
}

/** Queue statistics */
export interface QueueStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
}

/** Queue command for mid-run control */
export type QueueCommand = "PAUSE" | "ABORT" | { type: "SKIP"; storyId: string };

/** Result of parsing a queue file */
export interface QueueFileResult {
  /** Parsed commands from the queue file */
  commands: QueueCommand[];
  /** Non-command lines (existing guidance behavior) */
  guidance: string[];
}
