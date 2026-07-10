/**
 * Checkpoint Store — public types.
 *
 * The checkpoint store records every green phase per story in an append-only
 * JSONL file at `<featureDir>/checkpoint.jsonl`. The writer emits a record
 * for each phase that completes green; the reader reloads those records after
 * a crash or abort and groups them into `StoryCheckpoint` values for the
 * orchestrator to seed its in-memory skip state.
 */

import type { PhaseKind } from "@/execution";

/** Captured state of the working tree at the moment a phase went green. */
export interface TreeState {
  headSha: string;
  dirtyDigest: string;
}

/** Aggregated per-story checkpoint state recovered from the JSONL log. */
export interface StoryCheckpoint {
  storyId: string;
  /** Phases recorded green, ordered by canonical phase index. */
  greenPhases: PhaseKind[];
  /** Tree state captured at the last green record for this story. */
  tree: TreeState;
}

/**
 * Wire shape persisted in checkpoint.jsonl. Each line is one such object.
 */
export interface CheckpointRecord {
  storyId: string;
  phase: PhaseKind;
  headSha: string;
  dirtyDigest: string;
  runId: string;
  ts: number;
}

/** Injectable deps for `CheckpointWriter`. */
export interface CheckpointWriterDeps {
  append: (filePath: string, line: string) => Promise<void>;
}

/** Injectable deps for `loadCheckpoints`. */
export interface CheckpointReaderDeps {
  read: (filePath: string) => Promise<string>;
}
