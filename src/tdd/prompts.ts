import type { RectificationConfig } from "../config";
import type { TestFailure } from "../execution/test-output-parser";
import type { UserStory } from "../prd";
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
): string {
  // Reuse the existing rectification prompt builder from R2
  // It already includes story context, failure details, and instructions
  return createRectificationPrompt(failures, story, config);
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
 * @returns Formatted rectification prompt with failure details
 */
export function buildRectificationPrompt(
  story: UserStory,
  failures: TestFailure[],
  config?: RectificationConfig,
): string {
  return createRectificationPrompt(failures, story, config);
}
