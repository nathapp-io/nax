/**
 * Deterministic fix-scope classification (US-002, ADR-033 §1).
 *
 * The scope half of the scoped fix review: given the repo-root-relative paths a
 * fix changed, decide whether every non-test file among them is one the story
 * was already authorised to touch. No LLM call is made when this fails.
 *
 * The allowed set is the union of `storyFiles`, `getContextFiles(story)`,
 * `getExpectedFiles(story)`, `story.modifiedFiles[].path` (all repo-root-relative,
 * ADR-032) and each finding's `file` joined onto `packageDirRel`. A changed path
 * is exempt when `isTestFile` matches it or it lies under `.nax/`.
 *
 * STUB (US-002 RED state): `checkFixScope` returns a placeholder verdict so the
 * US-002 tests compile and fail on their assertions. The implementer supplies
 * the real classification.
 */

import type { Finding } from "@/findings";
import type { UserStory } from "@/prd";

export interface FixScopeInput {
  /** Repo-root-relative paths the fix changed. */
  readonly changedFiles: readonly string[];
  /** Repo-root-relative paths the story had changed before the fix; undefined when unknown. */
  readonly storyFiles: readonly string[] | undefined;
  readonly story: Pick<UserStory, "contextFiles" | "relevantFiles" | "expectedFiles" | "modifiedFiles">;
  /** Seeding findings; `file` is workdir-relative (src/findings/types.ts). */
  readonly findings: readonly Pick<Finding, "file">[];
  /** The story package dir relative to the repo root; "" at the root. */
  readonly packageDirRel: string;
  readonly isTestFile: (repoRelPath: string) => boolean;
}

export interface FixScopeResult {
  readonly inScope: boolean;
  readonly outOfScopeFiles: readonly string[];
  /** True when storyFiles was undefined and the check did not run. */
  readonly skipped: boolean;
}

export function checkFixScope(_input: FixScopeInput): FixScopeResult {
  return { inScope: false, outOfScopeFiles: ["stub-not-implemented"], skipped: false };
}
