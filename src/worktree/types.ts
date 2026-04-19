export interface WorktreeInfo {
  path: string;
  branch: string;
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
    readonly mode: "inherit" | "provision" | "off",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorktreeDependencyPreparationError";
  }
}
