/**
 * Run-start main-checkout gitignore reconcile.
 *
 * `NAX_GITIGNORE_ENTRIES` (src/utils/gitignore.ts) gains a new entry whenever
 * nax grows a new runtime-artifact kind. `nax init` writes the full list into
 * a repo's tracked `.gitignore` exactly once (src/cli/init.ts:125) and nothing
 * reconciles it afterwards — an already-initialised MAIN checkout never
 * receives an entry added after its `nax init` ran. A run can then `git add`
 * a now-unignored artifact, which `scripts/check-nax-artifacts-untracked.ts`
 * rejects at the gate.
 *
 * `WorktreeManager.ensureGitExcludes()` already solves exactly this for
 * worktrees: it reconciles into `.git/info/exclude` (local-only, never
 * committed) rather than the tracked `.gitignore` — patching a tracked file
 * would show up as a repo diff that nax's own auto-commit machinery could
 * sweep into the feature branch as run noise. This module reuses that same
 * method — no re-spelled line-aware matching — against the MAIN checkout at
 * the start of every run, closing the gap for the common case where
 * `execution.storyIsolation` never creates a worktree at all.
 *
 * Gated on dryRun for the same reason the adjacent scratchpad wipe is
 * (scratchpad-wipe.ts): a preview must not mutate the tree, even a
 * local-only, uncommitted file like `.git/info/exclude`. Failure is already
 * tolerated inside `ensureGitExcludes()` itself (logged at warn, non-fatal);
 * this wrapper adds nothing beyond the dryRun gate and the injectable seam.
 */

import { WorktreeManager } from "@/worktree";

/** Injectable deps for the reconcile (see docs/architecture/conventions.md §2). */
export const _gitignoreReconcileDeps = {
  worktreeManager: new WorktreeManager(),
};

/** Options for {@link reconcileMainGitignore}. */
export interface ReconcileMainGitignoreOptions {
  /** When true, skip disk work entirely — a dry run must not touch the tree. */
  dryRun?: boolean;
}

/**
 * Reconcile the main checkout's `.git/info/exclude` against
 * `NAX_GITIGNORE_ENTRIES`, adding whatever entries are missing.
 *
 * Resolves for every outcome: `ensureGitExcludes()` is itself non-fatal on
 * error (logs a warning and continues), so this never blocks run setup.
 */
export async function reconcileMainGitignore(workdir: string, opts: ReconcileMainGitignoreOptions = {}): Promise<void> {
  if (opts.dryRun) return;
  await _gitignoreReconcileDeps.worktreeManager.ensureGitExcludes(workdir);
}
