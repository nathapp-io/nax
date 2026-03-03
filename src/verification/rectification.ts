/**
 * Rectification Logic
 *
 * Retry logic with backoff, max attempt tracking, and failure categorization.
 * Extracted from execution/rectification.ts to eliminate duplication.
 */

import type { RectificationConfig } from "../config";
import type { UserStory } from "../prd";
import { formatFailureSummary } from "./parser";
import type { RectificationState, TestFailure } from "./types";

/**
 * Determine if rectification should retry based on state and config.
 *
 * Returns true if:
 * - Current attempt < maxRetries
 * - AND currentFailures > 0 (still have failures to fix)
 * - AND NOT regressing (if abortOnIncreasingFailures is true)
 *
 * Returns false if:
 * - Max retries reached
 * - OR all tests passing (currentFailures = 0)
 * - OR failures increased (regression spiral) AND abortOnIncreasingFailures = true
 */
export function shouldRetryRectification(state: RectificationState, config: RectificationConfig): boolean {
  // Stop if max retries reached
  if (state.attempt >= config.maxRetries) {
    return false;
  }

  // Stop if all tests passing
  if (state.currentFailures === 0) {
    return false;
  }

  // Abort if failures increased (regression spiral check)
  if (config.abortOnIncreasingFailures && state.currentFailures > state.initialFailures) {
    return false;
  }

  // Continue retrying
  return true;
}

/**
 * Create a rectification prompt with failure context.
 *
 * Includes:
 * - Clear instructions about test regressions
 * - Formatted failure summary
 * - Specific test commands for failing files
 */
export function createRectificationPrompt(
  failures: TestFailure[],
  story: UserStory,
  config?: RectificationConfig,
): string {
  const maxChars = config?.maxFailureSummaryChars ?? 2000;
  const failureSummary = formatFailureSummary(failures, maxChars);

  // Extract unique failing test files
  const failingFiles = Array.from(new Set(failures.map((f) => f.file)));
  const testCommands = failingFiles.map((file) => `  bun test ${file}`).join("\n");

  return `# Rectification Required

Your changes caused test regressions. Fix these without breaking existing logic.

## Story Context

**Title:** ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

---

## Test Failures

${failureSummary}

---

## Instructions

1. Review the failures above carefully.
2. Identify the root cause of each failure.
3. Fix the implementation WITHOUT loosening test assertions.
4. Run the failing tests to verify your fixes:

${testCommands}

5. Ensure ALL tests pass before completing.

**IMPORTANT:**
- Do NOT modify test files unless there is a legitimate bug in the test itself.
- Do NOT loosen assertions to mask implementation bugs.
- Focus on fixing the source code to meet the test requirements.
- When running tests, run ONLY the failing test files shown above — NEVER run \`bun test\` without a file filter.
`;
}

// Re-export types for consumers that import from this module
export type { RectificationState } from "./types";
