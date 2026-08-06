/**
 * Shared nax gitignore entries — runtime files that must never be committed.
 *
 * Used by:
 *  - `nax init` → appends to project .gitignore
 *  - `WorktreeManager.ensureGitExcludes()` → writes to .git/info/exclude (no commit, all worktrees)
 */
export const NAX_GITIGNORE_ENTRIES = [
  ".nax-verifier-verdict.json",
  "nax.lock",
  ".nax/**/runs/",
  ".nax/metrics.json",
  ".nax/features/*/status.json",
  ".nax/features/*/plan/",
  ".nax/features/*/acp-sessions.json",
  ".nax/features/*/interactions/",
  ".nax/features/*/progress.txt",
  ".nax/features/*/acceptance-refined.json",
  ".nax-pids",
  ".nax-wt/",
  "**/.nax-acceptance*",
  "**/_nax_acceptance_test.py",
  "**/_nax_suggested_test.py",
  "**/.nax/features/*/",
  ".nax/prompt-audit/",
  // Only reached when a run has no outputDir — nax-finish normally writes its
  // audit under `~/.nax/<project>/finish-audit/`. It still must be ignored:
  // the flow's `commit_*` nodes run `git add -A`, so an un-ignored artifact
  // here lands in the feature branch's history.
  ".nax/finish-audit/",
  // In-flight mutation-spot-check journal. Same reasoning as finish-audit
  // above, and more urgent: the journal exists precisely in the window where a
  // run died mid-mutation, so a later `git add -A` is exactly what would sweep
  // it into the feature branch. Kept in sync with `journalDir()` in
  // src/verification/mutation/journal.ts.
  ".nax/mutation-journal/",
];
