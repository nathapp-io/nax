import type { RectificationConfig } from "../config";
import type { UserStory } from "../prd";
import type { TestFailure } from "../verification/parser";
import { createRectificationPrompt } from "../verification/rectification";

/**
 * Build implementer rectification prompt (v0.11)
 *
 * Used during the full-suite gate in three-session TDD when the implementer
 * introduced regressions. Provides failure context to guide fixes.
 */
export function buildImplementerRectificationPrompt(
  failures: TestFailure[],
  story: UserStory,
  _contextMarkdown?: string,
  config?: RectificationConfig,
  testCommand?: string,
  scopeFileThreshold?: number,
  testScopedTemplate?: string,
): string {
  // Reuse the existing rectification prompt builder from R2.
  // attempt is undefined: the TDD gate does not use progressive escalation preambles.
  return createRectificationPrompt(
    failures,
    story,
    config,
    undefined,
    testCommand,
    scopeFileThreshold,
    testScopedTemplate,
  );
}

/**
 * Build rectification prompt for retry after test failures
 *
 * Wrapper around createRectificationPrompt from the rectification core module.
 * Used when tests fail after implementation to provide failure context for retry.
 *
 * @param story - User story being implemented
 * @param failures - Array of test failures from test output parser
 * @param config - Optional rectification config (for maxFailureSummaryChars)
 * @param testCommand - Full-suite test command (quality.commands.test)
 * @param scopeFileThreshold - Max failing files before falling back to full suite
 * @param testScopedTemplate - Scoped command template with {{files}} placeholder (quality.commands.testScoped)
 * @returns Formatted rectification prompt with failure details
 */
export function buildRectificationPrompt(
  story: UserStory,
  failures: TestFailure[],
  config?: RectificationConfig,
  testCommand?: string,
  scopeFileThreshold?: number,
  testScopedTemplate?: string,
): string {
  // attempt is undefined: callers of buildRectificationPrompt do not track attempt numbers.
  return createRectificationPrompt(
    failures,
    story,
    config,
    undefined,
    testCommand,
    scopeFileThreshold,
    testScopedTemplate,
  );
}
