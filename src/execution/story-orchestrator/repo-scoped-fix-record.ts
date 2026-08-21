/**
 * Visibility for repo-scoped repairs (#1658).
 *
 * `repo-scoped-test-fix` (#1654) dispatches with the story-scope constraint
 * lifted, so its edits can land anywhere in the repository — and they land in
 * the STORY's commit. Nothing previously recorded that: a reviewer seeing an
 * unrelated file in the diff had no explanation for it, and post-run analysis of
 * "what did this story change" silently absorbed work the story did not
 * originate.
 *
 * Derived purely from the cycle's own iteration records, so nothing new has to
 * be threaded through `runFixCycle`.
 *
 * scope: repo-scoped (pure; no I/O, no config)
 */

import type { Finding, Iteration } from "@/findings";
import type { PersistedRepoScopedFix, UserStory } from "@/prd";

/** Strategy name from `makeRepoScopedTestFixStrategy`. */
export const REPO_SCOPED_STRATEGY_NAME = "repo-scoped-test-fix";

export interface RepoScopedFixRecord {
  /** Failing tests that triggered the dispatch, as `file::testName`. */
  readonly triggeringTests: readonly string[];
  /**
   * Files the dispatch changed. Sourced from git rather than the agent's own
   * report — see `_repoScopedFixDeps` in src/operations/full-suite-rectify.ts.
   * Empty when the dispatch changed nothing, or when git could not be read.
   */
  readonly filesChanged: readonly string[];
  /** Why the story-scoped rectifier declined, when it said. */
  readonly declinedReason?: string;
  /**
   * Were the findings gone after this dispatch?
   *
   * Deliberately NOT named `resolved`: this cannot distinguish "the dispatch
   * fixed the test" from "the verifier-SSOT carve-out
   * (`shouldSkipPhaseForRectification`) dropped the gate finding because the
   * verifier passed". Both clear the cycle's findings, and the cycle has no way
   * to tell them apart.
   *
   * `filesChanged` is the field that does discriminate: a dispatch that changed
   * no files fixed nothing, whatever happened to the findings. An empty
   * `filesChanged` on a story that PASSED is the case the issue calls out —
   * a session was spent, nothing was repaired, and the story passed on the
   * carve-out.
   */
  readonly findingsCleared: boolean;
}

function testIdentity(finding: Finding): string {
  return `${finding.file ?? "unknown"}::${finding.rule ?? ""}`;
}

/**
 * Extract one record per repo-scoped dispatch found in `iterations`.
 *
 * `declinedReason` is taken from the NEAREST preceding give-up rather than the
 * first: a cycle can accumulate several refusals, and the one that actually
 * routed the findings here is the last one before the dispatch.
 */
export function deriveRepoScopedFixes(iterations: readonly Iteration<Finding>[]): RepoScopedFixRecord[] {
  const records: RepoScopedFixRecord[] = [];
  let lastDeclineReason: string | undefined;

  for (const iteration of iterations) {
    // `fixesApplied` is required by the type but absent in practice on
    // plugin-supplied and stubbed cycle results (the same legacy shape
    // `validate` guards against). Reporting must never throw inside the exit
    // path of a story that otherwise succeeded.
    const applied = iteration.fixesApplied ?? [];
    const repoScoped = applied.filter((fa) => fa.strategyName === REPO_SCOPED_STRATEGY_NAME);

    if (repoScoped.length === 0) {
      // Only non-dispatch iterations update the standing decline reason, so a
      // give-up emitted BY the repo-scoped strategy never overwrites the
      // story-scoped refusal that sent the findings to it.
      const declined = applied.find((fa) => fa.unresolved !== undefined);
      if (declined?.unresolved) lastDeclineReason = declined.unresolved;
      continue;
    }

    for (const fa of repoScoped) {
      records.push({
        triggeringTests: (iteration.findingsBefore ?? []).filter((f) => f.category === "failed-test").map(testIdentity),
        filesChanged: [...(fa.targetFiles ?? [])],
        ...(lastDeclineReason !== undefined ? { declinedReason: lastDeclineReason } : {}),
        findingsCleared: (iteration.findingsAfter ?? []).length === 0,
      });
    }
  }

  return records;
}

/**
 * Record this story's repo-scoped dispatches onto the live story so the next
 * `savePRD` carries them to disk (US-002).
 *
 * Mutates `story.repoScopedFixes` in place — sequential and parallel worktree
 * pipelines rely on `buildWorktreePipelineContext` deep-cloning `prd` via
 * `structuredClone` while passing `story` by reference, so a write here
 * reaches the durable save on the writing worker without racing against
 * others. `declinedReason` is intentionally dropped — it lives in the JSONL
 * run log only (see `deriveRepoScopedFixes`).
 *
 * A no-op when `records` is absent or empty: an empty array is never written
 * onto a story that didn't have one, and an existing array is left as-is.
 * Synchronous — the existing save paths carry the write to disk.
 */
export function recordRepoScopedFixes(story: UserStory, records: readonly RepoScopedFixRecord[] | undefined): void {
  if (!records || records.length === 0) return;

  const mapped: PersistedRepoScopedFix[] = records.map((r) => ({
    triggeringTests: [...r.triggeringTests],
    filesChanged: [...r.filesChanged],
    findingsCleared: r.findingsCleared,
  }));

  story.repoScopedFixes = story.repoScopedFixes ? [...story.repoScopedFixes, ...mapped] : mapped;
}
