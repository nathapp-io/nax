/**
 * Review Runner
 *
 * Runs configurable quality checks after story implementation
 */

import { spawn } from "bun";
import type { ExecutionConfig } from "../config/schema";
import { getSafeLogger } from "../logger";
import type { ReviewCheckName, ReviewCheckResult, ReviewConfig, ReviewResult } from "./types";

/**
 * Injectable dependencies for runner internals — allows tests to intercept
 * Bun.file and spawn calls without mock.module().
 *
 * @internal
 */
export const _reviewRunnerDeps = { spawn, file: Bun.file };

/** Default commands for each check type */
const DEFAULT_COMMANDS: Record<ReviewCheckName, string> = {
  typecheck: "bun run typecheck",
  lint: "bun run lint",
  test: "bun test",
};

/**
 * Load package.json from workdir
 */
async function loadPackageJson(workdir: string): Promise<Record<string, unknown> | null> {
  try {
    const file = _reviewRunnerDeps.file(`${workdir}/package.json`);
    const content = await file.text();
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Check if package.json has a script
 */
function hasScript(packageJson: Record<string, unknown> | null, scriptName: string): boolean {
  if (!packageJson) return false;
  const scripts = packageJson.scripts;
  if (typeof scripts !== "object" || scripts === null) return false;
  return scriptName in scripts;
}

/**
 * Resolve command for a check
 * Resolution order:
 * 1. Explicit executionConfig field (lintCommand/typecheckCommand) - null = disabled
 * 2. package.json has script -> use 'bun run <script>'
 * 3. Not found -> return null (skip)
 */
async function resolveCommand(
  check: ReviewCheckName,
  config: ReviewConfig,
  executionConfig: ExecutionConfig | undefined,
  workdir: string,
): Promise<string | null> {
  // 1. Check explicit config.execution commands (v0.13 story)
  if (executionConfig) {
    if (check === "lint" && executionConfig.lintCommand !== undefined) {
      return executionConfig.lintCommand; // null = disabled
    }
    if (check === "typecheck" && executionConfig.typecheckCommand !== undefined) {
      return executionConfig.typecheckCommand; // null = disabled
    }
  }

  // 2. Check config.review.commands (legacy, backwards compat)
  if (config.commands[check]) {
    return config.commands[check] ?? null;
  }

  // 3. Check package.json
  const packageJson = await loadPackageJson(workdir);
  if (hasScript(packageJson, check)) {
    return `bun run ${check}`;
  }

  // 4. Not found - return null to skip
  return null;
}

/** Default timeout for review checks (lint, typecheck). BUG-039. */
const REVIEW_CHECK_TIMEOUT_MS = 120_000;

/** Grace period between SIGTERM and SIGKILL for review check cleanup. */
const SIGKILL_GRACE_PERIOD_MS = 5_000;

/**
 * Run a single review check with a hard timeout.
 *
 * BUG-039: Added SIGTERM + SIGKILL cleanup to prevent orphan lint/typecheck processes.
 */
async function runCheck(check: ReviewCheckName, command: string, workdir: string): Promise<ReviewCheckResult> {
  const startTime = Date.now();

  try {
    // Parse command into executable and args
    const parts = command.split(/\s+/);
    const executable = parts[0];
    const args = parts.slice(1);

    // Spawn the process
    const proc = _reviewRunnerDeps.spawn({
      cmd: [executable, ...args],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    // BUG-039: Hard timeout — kill the process if it hangs
    let timedOut = false;
    const timerId = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, SIGKILL_GRACE_PERIOD_MS);
    }, REVIEW_CHECK_TIMEOUT_MS);

    // Wait for completion
    const exitCode = await proc.exited;
    clearTimeout(timerId);

    if (timedOut) {
      return {
        check,
        command,
        success: false,
        exitCode: -1,
        output: `[nax] ${check} timed out after ${REVIEW_CHECK_TIMEOUT_MS / 1000}s`,
        durationMs: Date.now() - startTime,
      };
    }

    // Collect output
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = [stdout, stderr].filter(Boolean).join("\n");

    return {
      check,
      command,
      success: exitCode === 0,
      exitCode,
      output,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      check,
      command,
      success: false,
      exitCode: -1,
      output: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Get uncommitted tracked files via git diff --name-only HEAD.
 * Returns empty array if git command fails or working tree is clean.
 */
async function getUncommittedFilesImpl(workdir: string): Promise<string[]> {
  try {
    const proc = _reviewRunnerDeps.spawn({
      cmd: ["git", "diff", "--name-only", "HEAD"],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return [];
    }

    const output = await new Response(proc.stdout).text();
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * RQ-001: getUncommittedFiles enables mocking of the git dirty-tree check.
 */
export const _deps = {
  /** Returns tracked files with uncommitted changes (git diff --name-only HEAD). */
  getUncommittedFiles: getUncommittedFilesImpl,
};

/**
 * Run all configured review checks
 */
export async function runReview(
  config: ReviewConfig,
  workdir: string,
  executionConfig?: ExecutionConfig,
): Promise<ReviewResult> {
  const startTime = Date.now();
  const logger = getSafeLogger();
  const checks: ReviewCheckResult[] = [];
  let firstFailure: string | undefined;

  // RQ-001: Check for uncommitted tracked files before running checks
  const allUncommittedFiles = await _deps.getUncommittedFiles(workdir);
  // Exclude nax runtime files — written by nax itself during the run, not by the agent
  const NAX_RUNTIME_FILES = new Set(["nax/status.json", ".nax-verifier-verdict.json"]);
  const uncommittedFiles = allUncommittedFiles.filter(
    (f) => !NAX_RUNTIME_FILES.has(f) && !f.match(/^nax\/features\/.+\/prd\.json$/),
  );
  if (uncommittedFiles.length > 0) {
    const fileList = uncommittedFiles.join(", ");
    logger?.warn("review", `Uncommitted changes detected before review: ${fileList}`);
    return {
      success: false,
      checks: [],
      totalDurationMs: Date.now() - startTime,
      failureReason: `Working tree has uncommitted changes:\n${uncommittedFiles.map((f) => `  - ${f}`).join("\n")}\n\nStage and commit these files before running review.`,
    };
  }

  for (const checkName of config.checks) {
    // Resolve command using resolution strategy
    const command = await resolveCommand(checkName, config, executionConfig, workdir);

    // Skip if explicitly disabled or not found
    if (command === null) {
      getSafeLogger()?.warn("review", `Skipping ${checkName} check (command not configured or disabled)`);
      continue;
    }

    // Run the check
    const result = await runCheck(checkName, command, workdir);
    checks.push(result);

    // Track first failure
    if (!result.success && !firstFailure) {
      firstFailure = `${checkName} failed (exit code ${result.exitCode})`;
    }

    // Stop on first failure (fail-fast)
    if (!result.success) {
      break;
    }
  }

  const allPassed = checks.every((c) => c.success);

  return {
    success: allPassed,
    checks,
    totalDurationMs: Date.now() - startTime,
    failureReason: firstFailure,
  };
}
