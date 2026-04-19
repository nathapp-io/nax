import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import { spawn } from "../utils/bun-deps";
import { parseCommandToArgv } from "../utils/command-argv";
import type { PrepareWorktreeDependenciesOptions, WorktreeDependencyContext } from "./types";
import { WorktreeDependencyPreparationError } from "./types";

const PHASE_ONE_INHERIT_UNSUPPORTED_FILES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
] as const;

export const _worktreeDependencyDeps = {
  existsSync,
  spawn,
};

export async function prepareWorktreeDependencies(
  options: PrepareWorktreeDependenciesOptions,
): Promise<WorktreeDependencyContext> {
  const mode = options.config.execution.worktreeDependencies.mode;
  const resolvedCwd = resolveDependencyCwd(options);

  switch (mode) {
    case "off":
      return { cwd: resolvedCwd };
    case "inherit":
      return resolveInheritedDependencies(options, resolvedCwd);
    case "provision":
      return provisionDependencies(options.config, resolvedCwd);
  }
}

function resolveDependencyCwd(options: PrepareWorktreeDependenciesOptions): string {
  return options.storyWorkdir ? join(options.worktreeRoot, options.storyWorkdir) : options.worktreeRoot;
}

function resolveInheritedDependencies(
  options: PrepareWorktreeDependenciesOptions,
  resolvedCwd: string,
): WorktreeDependencyContext {
  if (hasDependencyManifests(options.worktreeRoot, resolvedCwd)) {
    throw new WorktreeDependencyPreparationError(
      `[worktree-deps] inherit mode is unsupported for dependency-managed worktrees in phase 1. Use mode "provision" with execution.worktreeDependencies.setupCommand, or switch to "off".`,
      "inherit",
    );
  }
  return { cwd: resolvedCwd };
}

function hasDependencyManifests(worktreeRoot: string, resolvedCwd: string): boolean {
  const directories = resolvedCwd === worktreeRoot ? [worktreeRoot] : [worktreeRoot, resolvedCwd];
  return directories.some((directory) =>
    PHASE_ONE_INHERIT_UNSUPPORTED_FILES.some((filename) =>
      _worktreeDependencyDeps.existsSync(join(directory, filename)),
    ),
  );
}

async function provisionDependencies(config: NaxConfig, resolvedCwd: string): Promise<WorktreeDependencyContext> {
  const setupCommand = config.execution.worktreeDependencies.setupCommand;
  if (!setupCommand) {
    throw new WorktreeDependencyPreparationError(
      "[worktree-deps] provision mode requires execution.worktreeDependencies.setupCommand in phase 1.",
      "provision",
    );
  }

  const argv = parseCommandToArgv(setupCommand);
  if (argv.length === 0) {
    throw new WorktreeDependencyPreparationError("[worktree-deps] setupCommand cannot be empty.", "provision");
  }

  const proc = _worktreeDependencyDeps.spawn(argv, {
    cwd: resolvedCwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    throw new WorktreeDependencyPreparationError(
      `[worktree-deps] provision failed in ${resolvedCwd}: ${output || "unknown error"}`,
      "provision",
    );
  }

  return { cwd: resolvedCwd };
}

export { WorktreeDependencyPreparationError };
