/**
 * Checkpoint module — the workflow resume seam, and nothing else.
 *
 * The durable `checkpoint.jsonl` log's reader and writer are gone, and so are the
 * record types, the resume-plan builder and the resume-hydrate helpers that used
 * to live here: the story orchestrator core they served is deleted, so nothing
 * writes or reads a checkpoint any more. A `checkpoint.jsonl` left on disk by an
 * older run stays where it is with nothing reading it.
 *
 * What remains is the one seam the workflow stage reads:
 *   - `_workflowResumeDeps` / `ResumeMode` (`resume-cli.ts`)
 */

export { _workflowResumeDeps, type ResumeMode } from "./resume-cli";
