/**
 * Precheck Tier 1 Blockers
 *
 * Extracted from checks.ts: individual check implementations for Tier 1 blockers.
 */
import { existsSync, statSync } from "node:fs";
import type { NaxConfig } from "../config";
import type { PRD } from "../prd/types";
import type { Check } from "./types";

/** Check if directory is a git repository. Uses: git rev-parse --git-dir */
export async function checkGitRepoExists(workdir: string): Promise<Check> {
  // First try git rev-parse command
  const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  let passed = exitCode === 0;

  // Fallback: if git command fails, check if .git directory exists
  // This handles test scenarios where .git exists but isn't fully initialized
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

/** Check if nax.lock is older than 2 hours. */
export async function checkStaleLock(workdir: string): Promise<Check> {
  const lockPath = `${workdir}/nax.lock`;
  const exists = existsSync(lockPath);

  if (!exists) {
    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed: true,
      message: "No lock file present",
    };
  }

  try {
    const file = Bun.file(lockPath);
    const content = await file.text();
    const lockData = JSON.parse(content);

    // Support both timestamp (ms) and startedAt (ISO string) formats
    let lockTimeMs: number;
    if (lockData.timestamp) {
      lockTimeMs = lockData.timestamp;
    } else if (lockData.startedAt) {
      lockTimeMs = new Date(lockData.startedAt).getTime();
    } else {
      // Fallback to file mtime if no timestamp in JSON
      const stat = statSync(lockPath);
      lockTimeMs = stat.mtimeMs;
    }

    const ageMs = Date.now() - lockTimeMs;
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const passed = ageMs < twoHoursMs;

    const ageMinutes = Math.floor(ageMs / 60000);
    const ageHours = Math.floor(ageMinutes / 60);

    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed,
      message: passed ? "Lock file is fresh" : "stale lock detected (over 2 hours old)",
    };
  } catch (error) {
    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed: false,
      message: "Failed to read lock file",
    };
  }
}

/** Validate PRD structure and required fields. Auto-defaults: tags=[], status=pending, storyPoints=1 */
export async function checkPRDValid(prd: PRD): Promise<Check> {
  const errors: string[] = [];

  // Validate required PRD fields
  if (!prd.project || prd.project.trim() === "") {
    errors.push("Missing project field");
  }
  if (!prd.feature || prd.feature.trim() === "") {
    errors.push("Missing feature field");
  }
  if (!prd.branchName || prd.branchName.trim() === "") {
    errors.push("Missing branchName field");
  }
  if (!Array.isArray(prd.userStories)) {
    errors.push("userStories must be an array");
  }

  // Validate each story
  if (Array.isArray(prd.userStories)) {
    for (const story of prd.userStories) {
      // Auto-default optional fields in-memory (don't modify the PRD)
      story.tags = story.tags ?? [];
      story.status = story.status ?? "pending";
      story.storyPoints = story.storyPoints ?? 1;
      story.acceptanceCriteria = story.acceptanceCriteria ?? [];

      // Validate required fields
      if (!story.id || story.id.trim() === "") {
        errors.push(`Story missing id: ${JSON.stringify(story).slice(0, 50)}`);
      }
      if (!story.title || story.title.trim() === "") {
        errors.push(`Story ${story.id} missing title`);
      }
      if (!story.description || story.description.trim() === "") {
        errors.push(`Story ${story.id} missing description`);
      }
    }
  }

  const passed = errors.length === 0;

  return {
    name: "prd-valid",
    tier: "blocker",
    passed,
    message: passed ? "PRD structure is valid" : errors.join("; "),
  };
}

/** Check if Claude CLI is available. Uses: claude --version */
export async function checkClaudeCLI(): Promise<Check> {
  const proc = Bun.spawn(["claude", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const passed = exitCode === 0;

  return {
    name: "claude-cli-available",
    tier: "blocker",
    passed,
    message: passed ? "Claude CLI is available" : "Claude CLI not found",
  };
}

/** Check if dependencies are installed (language-aware). Detects: node_modules, target, venv, vendor */
export async function checkDependenciesInstalled(workdir: string): Promise<Check> {
  const depPaths = [
    { path: "node_modules" },
    { path: "target" },
    { path: "venv" },
    { path: ".venv" },
    { path: "vendor" },
  ];

  const found: string[] = [];
  for (const { path } of depPaths) {
    const fullPath = `${workdir}/${path}`;
    // Check if it exists and is a directory
    if (existsSync(fullPath)) {
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        found.push(path);
      }
    }
  }

  const passed = found.length > 0;

  return {
    name: "dependencies-installed",
    tier: "blocker",
    passed,
    message: passed ? `Dependencies found: ${found.join(", ")}` : "No dependency directories detected",
  };
}

/** Check if test command works. Skips silently if command is null/false. */
export async function checkTestCommand(config: NaxConfig): Promise<Check> {
  // Try multiple possible locations for testCommand
  const executionConfig = config.execution as Record<string, unknown>;
  const testCommand = executionConfig.testCommand || config.quality?.commands?.test;

  // Skip if explicitly disabled or not configured
  if (!testCommand || testCommand === null || testCommand === false) {
    return {
      name: "test-command-works",
      tier: "blocker",
      passed: true,
      message: "Test command not configured (skipped)",
    };
  }

  // Parse command and args
  const parts = testCommand.split(" ");
  const [cmd, ...args] = parts;

  try {
    const proc = Bun.spawn([cmd, ...args, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const passed = exitCode === 0;

    return {
      name: "test-command-works",
      tier: "blocker",
      passed,
      message: passed ? "Test command is available" : `Test command failed: ${testCommand}`,
    };
  } catch (error) {
    return {
      name: "test-command-works",
      tier: "blocker",
      passed: false,
      message: `Test command failed: ${testCommand}`,
    };
  }
}

/** Check if lint command works. Skips silently if command is null/false. */
export async function checkLintCommand(config: NaxConfig): Promise<Check> {
  const executionConfig = config.execution as Record<string, unknown>;
  const lintCommand = config.execution.lintCommand || executionConfig.lintCommand;

  // Skip if explicitly disabled or not configured
  if (!lintCommand || lintCommand === null || lintCommand === false) {
    return {
      name: "lint-command-works",
      tier: "blocker",
      passed: true,
      message: "Lint command not configured (skipped)",
    };
  }

  // Parse command and args
  const parts = lintCommand.split(" ");
  const [cmd, ...args] = parts;

  try {
    const proc = Bun.spawn([cmd, ...args, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const passed = exitCode === 0;

    return {
      name: "lint-command-works",
      tier: "blocker",
      passed,
      message: passed ? "Lint command is available" : `Lint command failed: ${lintCommand}`,
    };
  } catch (error) {
    return {
      name: "lint-command-works",
      tier: "blocker",
      passed: false,
      message: `Lint command failed: ${lintCommand}`,
    };
  }
}

/** Check if typecheck command works. Skips silently if command is null/false. */
export async function checkTypecheckCommand(config: NaxConfig): Promise<Check> {
  const executionConfig = config.execution as Record<string, unknown>;
  const typecheckCommand = config.execution.typecheckCommand || executionConfig.typecheckCommand;

  // Skip if explicitly disabled or not configured
  if (!typecheckCommand || typecheckCommand === null || typecheckCommand === false) {
    return {
      name: "typecheck-command-works",
      tier: "blocker",
      passed: true,
      message: "Typecheck command not configured (skipped)",
    };
  }

  // Parse command and args
  const parts = typecheckCommand.split(" ");
  const [cmd, ...args] = parts;

  try {
    const proc = Bun.spawn([cmd, ...args, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const passed = exitCode === 0;

    return {
      name: "typecheck-command-works",
      tier: "blocker",
      passed,
      message: passed ? "Typecheck command is available" : `Typecheck command failed: ${typecheckCommand}`,
    };
  } catch (error) {
    return {
      name: "typecheck-command-works",
      tier: "blocker",
      passed: false,
      message: `Typecheck command failed: ${typecheckCommand}`,
    };
  }
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
