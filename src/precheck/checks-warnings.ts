/**
 * Precheck Tier 2 Warnings
 *
 * Extracted from checks.ts: individual check implementations for Tier 2 warnings.
 * These checks produce warnings but do not block execution.
 */

import { existsSync } from "node:fs";
import type { NaxConfig } from "../config";
import type { PRD } from "../prd/types";
import type { Check } from "./types";

/**
 * Check if CLAUDE.md exists.
 */
export async function checkClaudeMdExists(workdir: string): Promise<Check> {
  const claudeMdPath = `${workdir}/CLAUDE.md`;
  const passed = existsSync(claudeMdPath);

  return {
    name: "claude-md-exists",
    tier: "warning",
    passed,
    message: passed ? "CLAUDE.md found" : "CLAUDE.md not found (recommended for project context)",
  };
}

/**
 * Check if disk space is above 1GB.
 */
export async function checkDiskSpace(): Promise<Check> {
  const proc = Bun.spawn(["df", "-k", "."], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return {
      name: "disk-space-sufficient",
      tier: "warning",
      passed: false,
      message: "Unable to check disk space",
    };
  }

  // Parse df output (second line, fourth column is available space in KB)
  const lines = output.trim().split("\n");
  if (lines.length < 2) {
    return {
      name: "disk-space-sufficient",
      tier: "warning",
      passed: false,
      message: "Unable to parse disk space output",
    };
  }

  const parts = lines[1].split(/\s+/);
  const availableKB = Number.parseInt(parts[3], 10);
  const availableGB = availableKB / 1024 / 1024;
  const passed = availableGB >= 1;

  return {
    name: "disk-space-sufficient",
    tier: "warning",
    passed,
    message: passed
      ? `Disk space: ${availableGB.toFixed(2)}GB available`
      : `Low disk space: ${availableGB.toFixed(2)}GB available`,
  };
}

/**
 * Check if PRD has pending stories.
 */
export async function checkPendingStories(prd: PRD): Promise<Check> {
  const pendingStories = prd.userStories.filter((s) => s.status === "pending");
  const passed = pendingStories.length > 0;

  return {
    name: "has-pending-stories",
    tier: "warning",
    passed,
    message: passed ? `${pendingStories.length} pending stories found` : "no pending stories to execute",
  };
}

/**
 * Check if optional commands are configured.
 */
export async function checkOptionalCommands(config: NaxConfig): Promise<Check> {
  const missing: string[] = [];

  if (!config.execution.lintCommand) {
    missing.push("lint");
  }
  if (!config.execution.typecheckCommand) {
    missing.push("typecheck");
  }

  const passed = missing.length === 0;

  return {
    name: "optional-commands-configured",
    tier: "warning",
    passed,
    message: passed ? "All optional commands configured" : `Optional commands not configured: ${missing.join(", ")}`,
  };
}

/**
 * Check if .gitignore covers nax runtime files.
 * Patterns: nax.lock, runs/, test/tmp/
 */
export async function checkGitignoreCoversNax(workdir: string): Promise<Check> {
  const gitignorePath = `${workdir}/.gitignore`;
  const exists = existsSync(gitignorePath);

  if (!exists) {
    return {
      name: "gitignore-covers-nax",
      tier: "warning",
      passed: false,
      message: ".gitignore not found",
    };
  }

  const file = Bun.file(gitignorePath);
  const content = await file.text();
  const patterns = ["nax.lock", "runs/", "test/tmp/"];
  const missing = patterns.filter((pattern) => !content.includes(pattern));
  const passed = missing.length === 0;

  return {
    name: "gitignore-covers-nax",
    tier: "warning",
    passed,
    message: passed ? ".gitignore covers nax runtime files" : `.gitignore missing patterns: ${missing.join(", ")}`,
  };
}
