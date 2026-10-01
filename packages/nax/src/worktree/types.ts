export interface WorktreeInfo {
  path: string;
  // BUG-24 (D-17): detached-HEAD worktrees (rebase, bisect) emit no `branch`
  // line in `git worktree list --porcelain` — `branch` is therefore nullable.
  branch: string | null;
}

export interface WorktreeDependencyContext {
  cwd: string;
  env?: Record<string, string>;
}

export interface PrepareWorktreeDependenciesOptions {
  projectRoot: string;
  worktreeRoot: string;
  storyId: string;
  storyWorkdir?: string;
  config: import("../config").NaxConfig;
}

export class WorktreeDependencyPreparationError extends Error {
  readonly failureCategory = "dependency-prep" as const;

  constructor(
    message: string,
    /** Only `provision` prepares anything, so only `provision` can fail. */
    readonly mode: "provision",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorktreeDependencyPreparationError";
  }
}
