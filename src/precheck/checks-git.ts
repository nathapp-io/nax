/**
 * Git-related precheck implementations
 */

import { existsSync, statSync } from "node:fs";
import type { Check } from "./types";

/** Check if directory is a git repository. Uses: git rev-parse --git-dir */
export async function checkGitRepoExists(workdir: string): Promise<Check> {
  const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  let passed = exitCode === 0;

  if (!passed) {
    const gitDir = `${workdir}/.git`;
    if (existsSync(gitDir)) {
      const stats = statSync(gitDir);
      passed = stats.isDirectory();
    }
  }

  return {
    name: "git-repo-exists",
    tier: "blocker",
    passed,
    message: passed ? "git repository detected" : "not a git repository",
  };
}

/** Check if working tree is clean. Uses: git status --porcelain */
export async function checkWorkingTreeClean(workdir: string): Promise<Check> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const passed = exitCode === 0 && output.trim() === "";

  return {
    name: "working-tree-clean",
    tier: "blocker",
    passed,
    message: passed ? "Working tree is clean" : "Uncommitted changes detected",
  };
}

/** Check if git user is configured. */
export async function checkGitUserConfigured(workdir?: string): Promise<Check> {
  const spawnOptions = {
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    ...(workdir && { cwd: workdir }),
  };

  const nameProc = Bun.spawn(["git", "config", "user.name"], spawnOptions);
  const emailProc = Bun.spawn(["git", "config", "user.email"], spawnOptions);

  const nameOutput = await new Response(nameProc.stdout).text();
  const emailOutput = await new Response(emailProc.stdout).text();
  const nameExitCode = await nameProc.exited;
  const emailExitCode = await emailProc.exited;

  const hasName = nameExitCode === 0 && nameOutput.trim() !== "";
  const hasEmail = emailExitCode === 0 && emailOutput.trim() !== "";
  const passed = hasName && hasEmail;

  return {
    name: "git-user-configured",
    tier: "blocker",
    passed,
    message: passed
      ? "Git user is configured"
      : !hasName && !hasEmail
        ? "Git user.name and user.email not configured"
        : !hasName
          ? "Git user.name not configured"
          : "Git user.email not configured",
  };
}
