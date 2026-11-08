export interface WorktreeInfo {
  path: string;
  // BUG-24 (D-17): detached-HEAD worktrees (rebase, bisect) emit no `branch`
  // line in `git worktree list --porcelain` — `branch` is therefore nullable.
  branch: string | null;
}
