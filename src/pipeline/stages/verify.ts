/**
 * Verify Stage
 *
 * Verifies the agent's work meets basic requirements by running tests.
 * This is a lightweight verification before the full review stage.
 *
 * @returns
 * - `continue`: Tests passed, OR TEST_FAILURE (ctx.verifyResult.success===false → rectifyStage handles it)
 * - `escalate`: TIMEOUT or RUNTIME_CRASH (structural — rectify can't fix these)
 */

import { basename, join } from "node:path";
import type { SmartTestRunnerConfig } from "../../config/types";
import { getLogger } from "../../logger";
import { logTestOutput } from "../../utils/log-test-output";
import { detectRuntimeCrash } from "../../verification/crash-detector";
import type { VerifyStatus } from "../../verification/orchestrator-types";
import { regression } from "../../verification/runners";
import { _smartRunnerDeps } from "../../verification/smart-runner";
import { isMonorepoOrchestratorCommand } from "../../verification/strategies/scoped";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

const DEFAULT_SMART_RUNNER_CONFIG: SmartTestRunnerConfig = {
  enabled: true,
  testFilePatterns: ["test/**/*.test.ts"],
  fallback: "import-grep",
};

/**
 * Coerces boolean or partial config into a full SmartTestRunnerConfig
 */
function coerceSmartTestRunner(val: boolean | SmartTestRunnerConfig | undefined): SmartTestRunnerConfig {
  if (val === undefined || val === true) return DEFAULT_SMART_RUNNER_CONFIG;
  if (val === false) return { ...DEFAULT_SMART_RUNNER_CONFIG, enabled: false };
  return val;
}

/**
 * Build the scoped test command from discovered test files.
 * Uses the testScoped template (with {{files}} placeholder) if configured,
 * otherwise falls back to buildSmartTestCommand heuristic.
 */
function buildScopedCommand(testFiles: string[], baseCommand: string, testScopedTemplate?: string): string {
  if (testScopedTemplate) {
    return testScopedTemplate.replace("{{files}}", testFiles.join(" "));
  }
  return _smartRunnerDeps.buildSmartTestCommand(testFiles, baseCommand);
}

/**
 * Read the npm package name from <dir>/package.json.
 * Returns null if not found or file has no name field.
 */
async function readPackageName(dir: string): Promise<string | null> {
  try {
    const content = await Bun.file(join(dir, "package.json")).json();
    return typeof content.name === "string" ? content.name : null;
  } catch {
    return null;
  }
}

/**
 * Substitute {{package}} placeholder in a testScoped template.
 *
 * Reads the npm package name from <packageDir>/package.json.
 * Returns null when package.json is absent or has no name field — callers
 * should skip the template entirely in that case (non-JS/non-Node projects
 * have no package identity to inject, so don't fall back to a dir name guess).
 *
 * @param template   - Template string (e.g. "bunx turbo test --filter={{package}}")
 * @param packageDir - Absolute path to the package directory
 * @returns Resolved template, or null if {{package}} cannot be resolved
 */
async function resolvePackageTemplate(template: string, packageDir: string): Promise<string | null> {
  if (!template.includes("{{package}}")) return template;
  const name = await _verifyDeps.readPackageName(packageDir);
  if (name === null) {
    // No package.json or no name field — skip template, can't resolve {{package}}
    return null;
  }
  return template.replaceAll("{{package}}", name);
}

export const verifyStage: PipelineStage = {
  name: "verify",
  enabled: (ctx: PipelineContext) => !ctx.fullSuiteGatePassed,
  skipReason: () => "not needed (full-suite gate already passed)",

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Skip verification if tests are not required
    if (!ctx.config.quality.requireTests) {
      logger.debug("verify", "Skipping verification (quality.requireTests = false)", { storyId: ctx.story.id });
      return { action: "continue" };
    }

    // Skip verification if no test command is configured
    const testCommand = ctx.config.review?.commands?.test ?? ctx.config.quality.commands.test;
    const testScopedTemplate = ctx.config.quality.commands.testScoped;
    if (!testCommand) {
      logger.debug("verify", "Skipping verification (no test command configured)", { storyId: ctx.story.id });
      return { action: "continue" };
    }

    logger.info("verify", "Running verification", { storyId: ctx.story.id });

    // MW-006: workdir is already resolved to the package directory at context creation

    // Determine effective test command (smart runner or full suite)
    let effectiveCommand = testCommand;
    let isFullSuite = true;
    const smartRunnerConfig = coerceSmartTestRunner(ctx.config.execution.smartTestRunner);
    const regressionMode = ctx.config.execution.regressionGate?.mode ?? "deferred";

    // Resolve {{package}} in testScoped template for monorepo stories.
    // Returns null if package.json is absent (non-JS project) — falls through to smart-runner.
    let resolvedTestScopedTemplate: string | undefined = testScopedTemplate;
    if (testScopedTemplate && ctx.story.workdir) {
      const resolved = await resolvePackageTemplate(testScopedTemplate, ctx.workdir);
      resolvedTestScopedTemplate = resolved ?? undefined; // null → skip template
    }

    // Monorepo orchestrators (turbo, nx) handle change-aware scoping natively via their own
    // filter syntax. Skip nax's smart runner — appending file paths would produce invalid syntax.
    // Instead, use the testScoped template (with {{package}} resolved) to scope per-story.
    const isMonorepoOrchestrator = isMonorepoOrchestratorCommand(testCommand);

    if (isMonorepoOrchestrator) {
      if (resolvedTestScopedTemplate && ctx.story.workdir) {
        // Use the resolved scoped template (e.g. "bunx turbo test --filter=@koda/cli")
        effectiveCommand = resolvedTestScopedTemplate;
        isFullSuite = false;
        logger.info("verify", "Monorepo orchestrator — using testScoped template", {
          storyId: ctx.story.id,
          command: effectiveCommand,
        });
      } else {
        logger.info("verify", "Monorepo orchestrator — running full suite (no package context)", {
          storyId: ctx.story.id,
          command: effectiveCommand,
        });
      }
    } else if (smartRunnerConfig.enabled) {
      // MW-006: pass packagePrefix so git diff is scoped to the package in monorepos
      const sourceFiles = await _smartRunnerDeps.getChangedSourceFiles(ctx.workdir, ctx.storyGitRef, ctx.story.workdir);

      // Pass 1: path convention mapping
      const pass1Files = await _smartRunnerDeps.mapSourceToTests(sourceFiles, ctx.workdir);
      if (pass1Files.length > 0) {
        logger.info("verify", `[smart-runner] Pass 1: path convention matched ${pass1Files.length} test files`, {
          storyId: ctx.story.id,
        });
        effectiveCommand = buildScopedCommand(pass1Files, testCommand, resolvedTestScopedTemplate);
        isFullSuite = false;
      } else if (smartRunnerConfig.fallback === "import-grep") {
        // Pass 2: import-grep fallback
        const pass2Files = await _smartRunnerDeps.importGrepFallback(
          sourceFiles,
          ctx.workdir,
          smartRunnerConfig.testFilePatterns,
        );
        if (pass2Files.length > 0) {
          logger.info("verify", `[smart-runner] Pass 2: import-grep matched ${pass2Files.length} test files`, {
            storyId: ctx.story.id,
          });
          effectiveCommand = buildScopedCommand(pass2Files, testCommand, resolvedTestScopedTemplate);
          isFullSuite = false;
        }
      }
    }

    // US-003: If we are falling back to the full suite AND mode is deferred, skip this stage
    // because the deferred regression gate will handle the full suite at run-end.
    if (isFullSuite && regressionMode === "deferred") {
      logger.info("verify", "[smart-runner] No mapped tests — deferring full suite to run-end (mode: deferred)", {
        storyId: ctx.story.id,
      });
      return { action: "continue" };
    }

    if (isFullSuite) {
      logger.info("verify", "[smart-runner] No mapped tests — falling back to full suite", {
        storyId: ctx.story.id,
      });
    }

    // BUG-044: Log the effective command for observability
    logger.info("verify", isFullSuite ? "Running full suite" : "Running scoped tests", {
      storyId: ctx.story.id,
      command: effectiveCommand,
    });

    // Use unified regression gate (includes 2s wait for agent process cleanup)
    const result = await _verifyDeps.regression({
      workdir: ctx.workdir,
      command: effectiveCommand,
      timeoutSeconds: ctx.config.execution.verificationTimeoutSeconds,
      acceptOnTimeout: ctx.config.execution.regressionGate?.acceptOnTimeout ?? true,
    });

    // Store result on context for rectify stage
    ctx.verifyResult = {
      success: result.success,
      status: (result.status === "TIMEOUT"
        ? "TIMEOUT"
        : result.success
          ? "PASS"
          : detectRuntimeCrash(result.output)
            ? "RUNTIME_CRASH"
            : "TEST_FAILURE") as VerifyStatus,
      storyId: ctx.story.id,
      strategy: "scoped",
      passCount: result.passCount ?? 0,
      failCount: result.failCount ?? 0,
      totalCount: (result.passCount ?? 0) + (result.failCount ?? 0),
      failures: [],
      rawOutput: result.output,
      durationMs: 0,
      countsTowardEscalation: result.countsTowardEscalation,
    };

    // HARD FAILURE: Tests must pass for story to be marked complete
    if (!result.success) {
      // BUG-019: Distinguish timeout from actual test failures
      if (result.status === "TIMEOUT") {
        const timeout = ctx.config.execution.verificationTimeoutSeconds;
        logger.error(
          "verify",
          `Test suite exceeded timeout (${timeout}s). This is NOT a test failure — consider increasing execution.verificationTimeoutSeconds or scoping tests.`,
          {
            exitCode: result.status,
            storyId: ctx.story.id,
            timeoutSeconds: timeout,
          },
        );
      } else {
        logger.error("verify", "Tests failed", {
          exitCode: result.status,
          storyId: ctx.story.id,
        });
      }

      // Log tail of output at debug level for context (ENH-001)
      // BUG-037: Use .slice(-20) to show failures, not prechecks
      if (result.status !== "TIMEOUT") {
        logTestOutput(logger, "verify", result.output, { storyId: ctx.story.id });
      }

      // RUNTIME_CRASH and TIMEOUT are structural — escalate immediately (rectify can't fix them)
      if (result.status === "TIMEOUT" || detectRuntimeCrash(result.output)) {
        return {
          action: "escalate",
          reason:
            result.status === "TIMEOUT"
              ? `Test suite TIMEOUT after ${ctx.config.execution.verificationTimeoutSeconds}s (not a code failure)`
              : `Tests failed with runtime crash (exit code ${result.status ?? "non-zero"})`,
        };
      }

      // TEST_FAILURE: ctx.verifyResult is set with success:false — rectifyStage handles it next
      return { action: "continue" };
    }

    logger.info("verify", "Tests passed", { storyId: ctx.story.id });
    return { action: "continue" };
  },
};

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _verifyDeps = {
  regression,
  readPackageName,
};
