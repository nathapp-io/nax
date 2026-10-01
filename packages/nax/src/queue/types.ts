/**
 * Queue Types
 *
 * Mid-run control commands parsed from the queue file.
 */

/** Queue command for mid-run control */
export type QueueCommand =
  | { type: "PAUSE" }
  | { type: "ABORT" }
  | { type: "SKIP"; storyId: string }
  | { type: "RETRY"; storyId: string }
  | { type: "PRIORITY"; storyId: string; value: number }
  | { type: "INJECT"; storyFile: string };

/** Result of parsing a queue file */
export interface QueueFileResult {
  /** Parsed commands from the queue file */
  commands: QueueCommand[];
  /** Non-command lines (existing guidance behavior) */
  guidance: string[];
}
