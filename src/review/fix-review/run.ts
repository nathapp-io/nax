/**
 * Scoped fix-review runner (US-003, ADR-033 §1).
 *
 * `runFixReview` evaluates in a fixed order and stops at the first stage that
 * decides:
 *
 *   1. `review.fixReview.enabled === false` → pass, not reviewed.
 *   2. Snapshot the working tree after the fix and list the paths changed
 *      between the pre-fix tree and it. No changed path → pass, not reviewed.
 *   3. Scope check over the changed paths → on violation, fail with cause
 *      `scope`. No LLM call.
 *   4. LLM verdict over the fix diff → pass, or fail with cause
 *      `contradiction`.
 *
 * A git failure in stage 2 or 3, a dispatch error, or an unparseable response
 * in stage 4 ends evaluation with kind `error` — there is no parse-retry.
 *
 * The story's own files are `changedPathsBetween(workdir, storyGitRef,
 * preFixTree)` when `storyGitRef` is set, else `undefined` (which makes the
 * scope check skip rather than guess). The embedded diff is
 * `truncateDiff(diffBetween(workdir, preFixTree, postTree))`. After the LLM
 * stage, parsed or not, the op output is emitted once through
 * `emitReviewDecision(ctx, "fix-review", output)`.
 *
 * RED STUB (US-003 test-writer session): the body returns a fixed placeholder
 * verdict so AC10-AC20 fail on their assertions rather than on a throw or an
 * import. The implementer supplies the real ordered runner.
 */

import { type CallContext, callOp } from "@/operations";
import { resolveTestFilePatterns } from "@/test-runners";
import { changedPathsBetween, diffBetween, snapshotWorkingTree } from "./tree-snapshot";
import type { FixReviewRequest, FixReviewVerdict } from "./types";

/**
 * Injectable seam — the same `_deps` pattern as `_nonBlockingFixDeps`. Each
 * member is overridable through `runFixReview`'s `deps` argument, so a unit
 * test can pin every stage without `mock.module()` and without touching git.
 */
export interface FixReviewDeps {
  callOp: typeof callOp;
  snapshotWorkingTree: typeof snapshotWorkingTree;
  changedPathsBetween: typeof changedPathsBetween;
  diffBetween: typeof diffBetween;
  /**
   * The dispatch-events audit seam. The real implementation lives in
   * `src/execution/story-orchestrator/review-decision.ts`, which `src/review`
   * cannot reach: `noRestrictedImports` bans the `../../` form and
   * `check:alias-internals` bans the `@/execution/story-orchestrator/...` leaf.
   * The wiring layer that dispatches this runner (US-004/US-005) injects it —
   * it already imports the emitter. The default below is a no-op ONLY so the
   * module stays importable; a production caller must pass the real one.
   */
  emitReviewDecision: (ctx: CallContext, opName: string, output: unknown) => void;
  resolveTestFilePatterns: typeof resolveTestFilePatterns;
}

const DEFAULT_DEPS: FixReviewDeps = {
  callOp,
  snapshotWorkingTree,
  changedPathsBetween,
  diffBetween,
  emitReviewDecision: () => {},
  resolveTestFilePatterns,
};

/** Placeholder reason so an unimplemented stage surfaces as an assertion failure. */
const NOT_IMPLEMENTED_REASON = "fix-review runner not implemented (US-003)";

export async function runFixReview(
  _ctx: CallContext,
  _req: FixReviewRequest,
  _deps: Partial<FixReviewDeps> = {},
): Promise<FixReviewVerdict> {
  // The real body merges `{ ...DEFAULT_DEPS, ..._deps }` and runs the four
  // stages above; the placeholder below fails every AC10-AC20 assertion without
  // throwing, so the RED state still reaches each test's expectations.
  void DEFAULT_DEPS;
  return { kind: "fail", cause: "contradiction", reason: NOT_IMPLEMENTED_REASON };
}
