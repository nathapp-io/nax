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

/**
 * nax runtime files that are allowed to be dirty without blocking the precheck.
 * These are written during nax execution and should be gitignored by `nax init`.
 */
const NAX_RUNTIME_PATTERNS = [
  /^.{2} nax\.lock$/,
  /^.{2} nax\/metrics\.json$/,
  /^.{2} nax\/features\/[^/]+\/status\.json$/,
  /^.{2} nax\/features\/[^/]+\/prd\.json$/,
  /^.{2} nax\/features\/[^/]+\/runs\//,
  /^.{2} nax\/features\/[^/]+\/plan\//,
  /^.{2} nax\/features\/[^/]+\/acp-sessions\.json$/,
  /^.{2} nax\/features\/[^/]+\/interactions\//,
  /^.{2} nax\/features\/[^/]+\/progress\.txt$/,
  /^.{2} nax\/features\/[^/]+\/acceptance-refined\.json$/,
  /^.{2} \.nax-verifier-verdict\.json$/,
  /^.{2} \.nax-pids$/,
  /^.{2} \.nax-wt\//,
];

/** Check if working tree is clean. Uses: git status --porcelain */
export async function checkWorkingTreeClean(workdir: string): Promise<Check> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  // Split without trimming the full output — porcelain lines start with status chars
  // including leading spaces (e.g. " M file.ts"). trim() would corrupt the first line.
  const lines = output.trim() === "" ? [] : output.split("\n").filter(Boolean);
  const nonNaxDirtyFiles = lines.filter((line) => !NAX_RUNTIME_PATTERNS.some((pattern) => pattern.test(line)));
  const passed = exitCode === 0 && nonNaxDirtyFiles.length === 0;

  return {
    name: "working-tree-clean",
    tier: "blocker",
    passed,
    message: passed
      ? "Working tree is clean"
      : `Uncommitted changes detected: ${nonNaxDirtyFiles.map((l) => l.slice(3)).join(", ")}`,
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
