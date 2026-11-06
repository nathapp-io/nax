/**
 * Checkpoint module — workflow resume seam plus the checkpoint record types.
 *
 * The durable `checkpoint.jsonl` log's reader and writer are gone: nothing
 * writes a checkpoint any more, and a `checkpoint.jsonl` left on disk by an
 * older run stays where it is with nothing reading it. What remains here is
 * the resume-mode seam the workflow stage reads (`_workflowResumeDeps`), the
 * record types those files used, and the resume-plan / resume-hydrate helpers
 * the orchestrator still calls:
 *   - `types.ts` — CheckpointRecord, StoryCheckpoint, TreeState
 *   - `resume-plan.ts` — buildResumePlan
 *   - `resume-hydrate.ts` — captureTreeState / hydrateFromResumePlan /
 *     buildCheckpointLogData (US-003 resume-integration helpers)
 */

export { _workflowResumeDeps, type ResumeMode } from "./resume-cli";
export type { CaptureTreeStateDeps, CaptureTreeStateOptions } from "./resume-hydrate";
export {
  buildCheckpointLogData,
  captureTreeState,
  hydrateFromResumePlan,
} from "./resume-hydrate";
export type { ResumePlan } from "./resume-plan";
export { buildResumePlan } from "./resume-plan";
export type {
  CheckpointReaderDeps,
  CheckpointRecord,
  CheckpointWriterDeps,
  StoryCheckpoint,
  TreeState,
} from "./types";
