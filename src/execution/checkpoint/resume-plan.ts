/**
 * Resume Planner — pure planner that decides which phases can be skipped
 * and which cheap gates must always re-run when resuming a story.
 *
 * The function is intentionally pure: it takes a `StoryCheckpoint` (or `null`)
 * and the current `TreeState`, and returns a `ResumePlan` with no I/O, no
 * clock, no globals. The orchestrator can seed its in-memory skip state from
 * the returned `skipPhases`, and always re-runs the phases in `revalidateGates`
 * regardless of whether they were marked green previously.
 *
 * Cheap gates (`verify-scoped`, `lint-check`, `typecheck-check`) are NEVER
 * placed in `skipPhases`: they are deterministic, fast, and re-validate the
 * code state, so a stale green from a previous tree is meaningless.
 */

import type { PhaseKind } from "../story-orchestrator";
import type { StoryCheckpoint, TreeState } from "./types";

export interface ResumePlan {
  /** Green AGENT phases to elide (never cheap gates). */
  skipPhases: PhaseKind[];
  /** Cheap gates that must always re-run. */
  revalidateGates: PhaseKind[];
  reason: "resume" | "tree-moved" | "no-checkpoint";
}

const CHEAP_GATES: readonly PhaseKind[] = ["verify-scoped", "lint-check", "typecheck-check"];

export function buildResumePlan(cp: StoryCheckpoint | null, current: TreeState): ResumePlan {
  if (!cp) {
    return { skipPhases: [], revalidateGates: [...CHEAP_GATES], reason: "no-checkpoint" };
  }
  if (cp.tree.headSha !== current.headSha || cp.tree.dirtyDigest !== current.dirtyDigest) {
    return { skipPhases: [], revalidateGates: [...CHEAP_GATES], reason: "tree-moved" };
  }
  return {
    skipPhases: cp.greenPhases.filter((p) => !CHEAP_GATES.includes(p)),
    revalidateGates: [...CHEAP_GATES],
    reason: "resume",
  };
}
