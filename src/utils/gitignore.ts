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
  "**/.nax/features/*/",
];
