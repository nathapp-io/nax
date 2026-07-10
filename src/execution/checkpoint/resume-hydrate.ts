/**
 * Resume Hydrate Helpers — STUB.
 *
 * Per the test-writer role, this file contains ONLY type/constant stubs so
 * the resume-hydrate test suite compiles. The implementation lands in the
 * next session (test-writer → implementer handover). Tests intentionally
 * reference these exports today to confirm they FAIL with assertion errors
 * (not import errors or compile errors).
 *
 * Real responsibilities of this module (for the implementer):
 *   - `captureTreeState(workdir, { _deps })` → derives a `TreeState` from
 *     `captureGitRef(workdir)` (HEAD sha) + a dirty digest derived from
 *     `git status --porcelain`. Uses `_deps.spawn` (matches `_gitDeps`).
 *   - `hydrateFromResumePlan(plan, phaseOutputs)` → seeds
 *     `phaseOutputs[phase] = { success: true }` for every entry in
 *     `plan.skipPhases`. Cheap gates from `plan.revalidateGates` are NOT
 *     seeded — they always re-execute.
 *   - `buildCheckpointLogData(meta)` → returns a Record whose FIRST key
 *     is `storyId` (regardless of object-literal key order in callers),
 *     so JSONL/console readers can grep `storyId` in known column 1.
 */

import type { ResumePlan } from "./resume-plan";
import type { TreeState } from "./types";

export interface CaptureTreeStateDeps {
  // Matches `_gitDeps` shape — tests pass `_gitDeps` directly.
  spawn: (cmd: string[], opts: unknown) => unknown;
}

export interface CaptureTreeStateOptions {
  _deps: CaptureTreeStateDeps;
}

/**
 * Capture a `TreeState` for the working tree. STUB — returns defaults so
 * tests can compile and prove the surface. Real implementation must:
 *   1. Call `captureGitRef(workdir)` (or equivalent via `_deps.spawn`) to
 *      obtain HEAD sha.
 *   2. Run `git status --porcelain` and hash the output into a `dirtyDigest`.
 *   3. Honor the same timing/timeout rules as `_gitDeps.spawn` consumers.
 */
export async function captureTreeState(_workdir: string, _options: CaptureTreeStateOptions): Promise<TreeState> {
  return { headSha: "", dirtyDigest: "" };
}

/**
 * Seed `phaseOutputs` with `{ success: true }` for every phase listed in
 * `plan.skipPhases`. STUB — replaces with a real seeding loop. Notably
 * this MUST NOT seed entries from `plan.revalidateGates` (those always
 * re-execute).
 */
export function hydrateFromResumePlan(_plan: ResumePlan, _phaseOutputs: Record<string, unknown>): void {
  // Intentionally empty — implementer writes the loop.
}

/**
 * Build a structured data object for checkpoint-style logger calls.
 * STUB — returns the meta object verbatim. Real implementation must
 * guarantee `storyId` is the FIRST key in the returned object regardless
 * of how the input was constructed (insertion order, not declared type).
 */
export function buildCheckpointLogData(meta: Record<string, unknown>): Record<string, unknown> {
  return { ...meta };
}
