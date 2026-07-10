/**
 * Checkpoint Store — durable per-green-phase checkpoint log.
 *
 * Public surface for the feature-level `checkpoint.jsonl` log used to seed
 * orchestrator skip-state after a crash or abort. See:
 *   - `types.ts`  — CheckpointRecord, StoryCheckpoint, TreeState
 *   - `writer.ts` — CheckpointWriter.recordGreen (durable append)
 *   - `reader.ts` — loadCheckpoints (longest-valid-prefix + latest-runId filter)
 */

export { CheckpointWriter } from "./writer";
export type { CheckpointWriterOptions } from "./writer";
export { loadCheckpoints } from "./reader";
export { buildResumePlan } from "./resume-plan";
export type { ResumePlan } from "./resume-plan";
export type {
  CheckpointRecord,
  CheckpointReaderDeps,
  CheckpointWriterDeps,
  StoryCheckpoint,
  TreeState,
} from "./types";
