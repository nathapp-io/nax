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

  // #89: Handle unparseable failures (non-zero exit but 0 parsed failures).
  // Treat as infrastructure failure and retry until maxRetries reached.
  if (state.lastExitCode !== undefined && state.lastExitCode !== 0 && state.currentFailures === 0) {
    return true;
  }

  // Stop if all tests passing (and exit code was 0)
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
 * Build the progressive escalation preamble to prepend when attempt >= threshold.
 *
 * - rethink phase  (attempt >= rethinkAtAttempt):  nudge the agent to change strategy
 * - urgency phase  (attempt >= urgencyAtAttempt):  add "final chance" pressure
 *
 * Both thresholds are clamped to maxRetries so they always fire on the final attempt
 * when the configured value exceeds maxRetries (e.g. default urgencyAtAttempt=3 with
 * default maxRetries=2 → urgency fires on attempt 2).
 *
 * Returns an empty string when no injection is needed.
 */
function buildEscalationPreamble(attempt: number, config: RectificationConfig): string {
  const rethinkAt = Math.min(config.rethinkAtAttempt ?? 2, config.maxRetries);
  const urgencyAt = Math.min(config.urgencyAtAttempt ?? 3, config.maxRetries);

  if (attempt < rethinkAt) return "";

  const isUrgent = attempt >= urgencyAt;

  const rethinkSection = `## ⚠️ Previous Attempt Did Not Fix the Failures

Your previous fix attempt (attempt ${attempt}) did not resolve all failures. **Step back and reconsider your approach.**

- The root cause may be different from what you assumed.
- Avoid iterating on the same fix — try a **fundamentally different strategy**.
- Re-read the story context and test failures carefully before making changes.
- Consider: are there missing edge cases, incorrect assumptions, or a design flaw in the implementation?

`;

  const urgencySection = isUrgent
    ? `## 🚨 Final Rectification Attempt Before Model Escalation

This is attempt ${attempt} — if the tests still fail after this, the task will escalate to a stronger model tier.
A **completely different approach** is required. Do not repeat what you have already tried.

`
    : "";

  return `${urgencySection}${rethinkSection}`;
}

/**
 * Create a rectification prompt with failure context.
 *
 * Includes:
 * - Progressive escalation preamble when attempt >= rethinkAtAttempt (or urgencyAtAttempt)
 * - Clear instructions about test regressions
 * - Formatted failure summary
 * - Specific test commands for failing files
 */
export function createRectificationPrompt(
  failures: TestFailure[],
  story: UserStory,
  config?: RectificationConfig,
  attempt?: number,
): string {
  const maxChars = config?.maxFailureSummaryChars ?? 2000;
  const failureSummary = formatFailureSummary(failures, maxChars);

  // Extract unique failing test files
  const failingFiles = Array.from(new Set(failures.map((f) => f.file)));
  const testCommands = failingFiles.map((file) => `  bun test ${file}`).join("\n");

  // Progressive escalation preamble (empty string on attempt 1 or when thresholds not met)
  const preamble = config && attempt !== undefined && attempt > 1 ? buildEscalationPreamble(attempt, config) : "";

  return `${preamble}# Rectification Required

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

/**
 * Create an escalated rectification prompt with prior attempt context.
 *
 * Used when escalating to a higher-tier model after exhausting retries.
 * Includes:
 * - Previous rectification attempts summary
 * - Count of prior attempts and original tier
 * - Failing test list (first 10 + "and N more" if > 10)
 * - Escalation direction (source to target tier)
 * - Story context and failure details
 */
export function createEscalatedRectificationPrompt(
  failures: TestFailure[],
  story: UserStory,
  priorAttempts: number,
  originalTier: string,
  targetTier: string,
  config?: RectificationConfig,
): string {
  const maxChars = config?.maxFailureSummaryChars ?? 2000;
  const failureSummary = formatFailureSummary(failures, maxChars);

  // Extract unique failing test files
  const failingFiles = Array.from(new Set(failures.map((f) => f.file)));
  const testCommands = failingFiles.map((file) => `  bun test ${file}`).join("\n");

  // Build failing tests list with "and N more" truncation
  const failingTestNames = failures.map((f) => f.testName);
  let failingTestsSection = "";
  if (failingTestNames.length <= 10) {
    failingTestsSection = failingTestNames.map((name) => `- ${name}`).join("\n");
  } else {
    const first10 = failingTestNames
      .slice(0, 10)
      .map((name) => `- ${name}`)
      .join("\n");
    const remaining = failingTestNames.length - 10;
    failingTestsSection = `${first10}\n- and ${remaining} more`;
  }

  return `# Escalated Rectification Required

This is an escalated attempt after exhausting standard retries. The previous model tier was unable to fix the issues, so a more powerful model is attempting the fix.

## Previous Rectification Attempts

- **Prior Attempts:** ${priorAttempts}
- **Original Model Tier:** ${originalTier}
- **Escalated to:** ${targetTier} (escalated from ${originalTier} to ${targetTier})

### Still Failing Tests

${failingTestsSection}

---

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

## Instructions for Escalated Attempt

1. Review the failure context above and note the previous tier's attempts.
2. The ${originalTier} model could not resolve these issues — try a fundamentally different approach.
3. Consider:
   - Are there architectural issues or design flaws causing multiple failures?
   - Could the implementation be incomplete or missing core functionality?
   - Are there concurrency, state management, or ordering issues?
4. Fix the implementation WITHOUT loosening test assertions.
5. Run the failing tests to verify your fixes:

${testCommands}

6. Ensure ALL tests pass before completing.

**IMPORTANT:**
- Do NOT modify test files unless there is a legitimate bug in the test itself.
- Do NOT loosen assertions to mask implementation bugs.
- Focus on fixing the source code to meet the test requirements.
- When running tests, run ONLY the failing test files shown above — NEVER run \`bun test\` without a file filter.
`;
}

// Re-export types for consumers that import from this module
export type { RectificationState } from "./types";
