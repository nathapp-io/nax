/**
 * Spec story structure — the ids, workdirs and dependencies a spec declares.
 *
 * A spec that lists 5 stories can be planned to 4: the planner folds one story
 * into another, and the folded story's `### Modifies` entry — the only channel
 * that authorises an implementer to update a test its change breaks — is dropped
 * as an orphan with a warn log. Nothing downstream reports the divergence, so
 * the run deadlocks against a red suite it may not touch.
 *
 * This module reads the spec's own declarations (pure, no I/O, no LLM) so the
 * plan write step can reject a PRD that diverges from them, and can backfill a
 * workdir the spec states that the planner omitted.
 *
 * Scope: `## Stories` only, fenced lines skipped. Attribution, the two Workdir
 * forms and the dependency phrasings are the grammar in the story context.
 *
 * STUB (US-002 RED state): every function below is a placeholder — the grammar
 * itself is the implementer's work. Bodies return empty results so the test
 * suite compiles and fails on assertions rather than on import errors.
 */

import type { PRD } from "./types";

/** One story the spec declares, as the spec declares it. */
export interface SpecStoryStructure {
  readonly id: string;
  /** undefined = the spec states no workdir; "." is never stored. */
  readonly workdir?: string;
  /** undefined = the spec states nothing; [] = "no dependencies". */
  readonly dependsOn?: readonly string[];
}

/** A field the grammar could not read unambiguously, so it is not enforced. */
export interface SpecStructureWarning {
  readonly storyId: string;
  readonly field: "workdir" | "dependsOn";
  readonly message: string;
}

/** Everything `## Stories` declares, in document order. */
export interface SpecStructure {
  readonly stories: readonly SpecStoryStructure[];
  readonly warnings: readonly SpecStructureWarning[];
}

/** One way a PRD diverges from the structure its spec declares. */
export type SpecStructureViolation =
  | { readonly kind: "missing-story"; readonly storyId: string }
  | { readonly kind: "extra-story"; readonly storyId: string }
  | { readonly kind: "workdir-mismatch"; readonly storyId: string; readonly expected: string; readonly actual: string }
  | {
      readonly kind: "dependencies-mismatch";
      readonly storyId: string;
      readonly expected: readonly string[];
      readonly actual: readonly string[];
    }
  | { readonly kind: "orphan-modifies"; readonly storyId: string | null; readonly path: string };

/** Story ids the spec declares in `## Stories` / `## Acceptance Criteria`. */
export function declaredStoryIds(_lines: readonly string[]): string[] {
  return [];
}

/** Read the ids, workdirs and dependencies `## Stories` declares. */
export function extractSpecStructure(_specContent: string): SpecStructure {
  return { stories: [], warnings: [] };
}

/** Fill each PRD story's missing workdir from the spec. Returns the filled ids. */
export function backfillSpecWorkdirs(prd: PRD, _structure: SpecStructure): { prd: PRD; backfilled: string[] } {
  return { prd, backfilled: [] };
}

/** Every way `prd` diverges from the structure `specContent` declares. */
export function findSpecStructureViolations(_prd: PRD, _specContent: string): SpecStructureViolation[] {
  return [];
}

/** One human-readable line naming a violation and what to do about it. */
export function formatSpecStructureViolation(_violation: SpecStructureViolation): string {
  return "";
}
