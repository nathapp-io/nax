import { join } from "node:path";
import type { NaxConfig } from "../config";
import { _argvExecDeps, runArgv } from "../utils/argv-exec";
import { parseCommandToArgv } from "../utils/command-argv";
import type { PrepareWorktreeDependenciesOptions, WorktreeDependencyContext } from "./types";
import { WorktreeDependencyPreparationError } from "./types";

/**
 * Delegates to `_argvExecDeps` so both names address the same seam. Kept as
 * its own export because `test/unit/worktree/dependencies.test.ts` injects
 * through it.
 */
export const _worktreeDependencyDeps = _argvExecDeps;

/**
 * Resolve the cwd a story executes from inside its worktree, installing
 * dependencies first when the repo needs its own install.
 *
 * `off` (the default) installs nothing, and for Node/Bun repos that is not a
 * gap: worktrees live at `<projectRoot>/.nax-wt/<storyId>/`, inside the project
 * root, so module resolution walks up to the root `node_modules` on its own.
 * Ecosystems without that upward walk — a Python venv, bundler, composer —
 * need `provision` with an explicit `setupCommand`.
 */
export async function prepareWorktreeDependencies(
  options: PrepareWorktreeDependenciesOptions,
): Promise<WorktreeDependencyContext> {
  const mode = options.config.execution.worktreeDependencies.mode;
  const resolvedCwd = resolveDependencyCwd(options);

  switch (mode) {
    case "off":
      return { cwd: resolvedCwd };
    case "provision":
      return provisionDependencies(options.config, options.worktreeRoot, resolvedCwd);
  }
}

function resolveDependencyCwd(options: PrepareWorktreeDependenciesOptions): string {
  return options.storyWorkdir ? join(options.worktreeRoot, options.storyWorkdir) : options.worktreeRoot;
}

async function provisionDependencies(
  config: NaxConfig,
  worktreeRoot: string,
  resolvedCwd: string,
): Promise<WorktreeDependencyContext> {
  const setupCommand = config.execution.worktreeDependencies.setupCommand;
  if (!setupCommand) {
    throw new WorktreeDependencyPreparationError(
      "[worktree-deps] provision mode requires execution.worktreeDependencies.setupCommand.",
      "provision",
    );
  }

  const argv = parseCommandToArgv(setupCommand);
  if (argv.length === 0) {
    throw new WorktreeDependencyPreparationError("[worktree-deps] setupCommand cannot be empty.", "provision");
  }

  const timeoutMs = config.execution.worktreeDependencies.timeoutSeconds * 1000;

  const result = await runArgv({
    argv,
    // Provisioning must run from the worktree root so workspace/monorepo install
    // commands (bun/pnpm/yarn workspaces) operate on the repo-level manifest.
    // Story execution still happens from the returned resolvedCwd.
    cwd: worktreeRoot,
    timeoutMs,
  });

  if (result.timedOut) {
    throw new WorktreeDependencyPreparationError(
      `[worktree-deps] provision timed out after ${config.execution.worktreeDependencies.timeoutSeconds}s in ${resolvedCwd}`,
      "provision",
    );
  }
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new WorktreeDependencyPreparationError(
      `[worktree-deps] provision failed in ${resolvedCwd}: ${output || "unknown error"}`,
      "provision",
    );
  }
  return { cwd: resolvedCwd };
}

export { WorktreeDependencyPreparationError };
