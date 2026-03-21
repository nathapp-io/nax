/**
 * Precheck Tier 2 Warnings
 *
 * Extracted from checks.ts: individual check implementations for Tier 2 warnings.
 * These checks produce warnings but do not block execution.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
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
export async function checkOptionalCommands(config: NaxConfig, workdir: string): Promise<Check> {
  const missing: string[] = [];

  // Check quality.commands first, then execution config, then package.json fallback
  const hasLint =
    config.quality?.commands?.lint || config.execution?.lintCommand || (await hasPackageScript(workdir, "lint"));
  const hasTypecheck =
    config.quality?.commands?.typecheck ||
    config.execution?.typecheckCommand ||
    (await hasPackageScript(workdir, "typecheck"));

  if (!hasLint) missing.push("lint");
  if (!hasTypecheck) missing.push("typecheck");

  const passed = missing.length === 0;

  return {
    name: "optional-commands-configured",
    tier: "warning",
    passed,
    message: passed ? "All optional commands configured" : `Optional commands not configured: ${missing.join(", ")}`,
  };
}

/** Check if package.json has a script by name */
async function hasPackageScript(workdir: string, name: string): Promise<boolean> {
  try {
    const pkg = await Bun.file(`${workdir}/package.json`).json();
    return Boolean(pkg?.scripts?.[name]);
  } catch {
    return false;
  }
}

/**
 * Check if .gitignore covers nax runtime files.
 * Patterns: nax.lock, runs/, status.json, .nax-pids, .nax-wt/
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
  const patterns = [
    "nax.lock",
    ".nax/**/runs/",
    ".nax/metrics.json",
    ".nax/features/*/status.json",
    ".nax-pids",
    ".nax-wt/",
  ];
  const missing = patterns.filter((pattern) => !content.includes(pattern));
  const passed = missing.length === 0;

  return {
    name: "gitignore-covers-nax",
    tier: "warning",
    passed,
    message: passed ? ".gitignore covers nax runtime files" : `.gitignore missing patterns: ${missing.join(", ")}`,
  };
}

/**
 * Check if configured prompt override files exist.
 *
 * For each role in config.prompts.overrides, verify the file exists.
 * Emits one warning per missing file (non-blocking).
 * Returns empty array if config.prompts is absent or overrides is empty.
 *
 * @param config - nax configuration
 * @param workdir - working directory for resolving relative paths
 * @returns Array of warning checks (one per missing file)
 */
export async function checkPromptOverrideFiles(config: NaxConfig, workdir: string): Promise<Check[]> {
  // Skip if prompts config is absent or overrides is empty
  if (!config.prompts?.overrides || Object.keys(config.prompts.overrides).length === 0) {
    return [];
  }

  const checks: Check[] = [];

  // Check each override file
  for (const [role, relativePath] of Object.entries(config.prompts.overrides)) {
    const resolvedPath = `${workdir}/${relativePath}`;
    const exists = existsSync(resolvedPath);

    if (!exists) {
      checks.push({
        name: `prompt-override-${role}`,
        tier: "warning",
        passed: false,
        message: `Prompt override file not found for role ${role}: ${resolvedPath}`,
      });
    }
  }

  return checks;
}

/**
 * Check if HOME env is set and is an absolute path.
 * An unexpanded "~" in HOME causes agent spawns to create a literal ~/
 * directory inside the repo cwd instead of resolving to the user home dir.
 */
export async function checkHomeEnvValid(): Promise<Check> {
  const home = process.env.HOME ?? "";
  const passed = home !== "" && isAbsolute(home);
  return {
    name: "home-env-valid",
    tier: "warning",
    passed,
    message: passed
      ? `HOME env is valid: ${home}`
      : home === ""
        ? "HOME env is not set — agent may write files to unexpected locations"
        : `HOME env is not an absolute path ("${home}") — may cause literal "~" directories in repo`,
  };
}
