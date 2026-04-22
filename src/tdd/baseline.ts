/**
 * Pre-story baseline failure capture.
 *
 * Runs the full test suite before any story sessions begin and records which
 * test files were already failing. runFullSuiteGate subtracts these so
 * pre-existing failures never trigger false rectification (BUG-TC-001).
 */

import type { NaxConfig } from "../config";
import type { getLogger } from "../logger";
import { resolveQualityTestCommands } from "../quality/command-resolver";
import { executeWithTimeout as _executeWithTimeout, parseTestOutput as _parseTestOutput } from "../verification";

export const _baselineDeps = {
  executeWithTimeout: _executeWithTimeout,
  parseTestOutput: _parseTestOutput,
  resolveTestCommands: resolveQualityTestCommands,
};

/**
 * Run the full test suite before story implementation begins and return the set
 * of test files that were already failing. These pre-existing failures are
 * subtracted by runFullSuiteGate so only newly-introduced regressions trigger
 * rectification.
 *
 * Returns an empty set when rectification is disabled or the suite is clean.
 */
export async function captureBaselineFailingFiles(
  config: NaxConfig,
  workdir: string,
  storyWorkdir: string | undefined,
  logger: ReturnType<typeof getLogger>,
  storyId: string,
): Promise<ReadonlySet<string>> {
  if (!(config.execution.rectification?.enabled ?? false)) return new Set();

  const { testCommand: resolvedTestCmd } = await _baselineDeps.resolveTestCommands(config, workdir, storyWorkdir);
  const effectiveTestCmd = resolvedTestCmd ?? "bun test";
  const timeout = config.execution.rectification.fullSuiteTimeoutSeconds;

  logger.info("tdd", "Capturing pre-story baseline (will suppress pre-existing failures from rectification)", {
    storyId,
    timeout,
  });

  const result = await _baselineDeps.executeWithTimeout(effectiveTestCmd, timeout, undefined, { cwd: workdir });

  if (result.success && result.exitCode === 0) {
    logger.info("tdd", "Pre-story baseline: suite clean", { storyId });
    return new Set();
  }

  if (!result.output) return new Set();

  const summary = _baselineDeps.parseTestOutput(result.output);
  const failingFiles = new Set(summary.failures.map((f) => f.file).filter(Boolean));

  if (failingFiles.size > 0) {
    logger.warn("tdd", "Pre-story baseline: pre-existing failures detected — will be suppressed in gate", {
      storyId,
      count: failingFiles.size,
      files: Array.from(failingFiles),
    });
  }

  return failingFiles;
}
