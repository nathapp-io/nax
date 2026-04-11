/**
 * Rectification Logic
 *
 * Retry logic with backoff, max attempt tracking, and failure categorization.
 * Extracted from execution/rectification.ts to eliminate duplication.
 */

import type { RectificationConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import { formatFailureSummary } from "./parser";
import { buildProgressivePromptPreamble } from "./shared-rectification-loop";
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
  return buildProgressivePromptPreamble({
    attempt,
    maxAttempts: config.maxRetries,
    rethinkAtAttempt: config.rethinkAtAttempt,
    urgencyAtAttempt: config.urgencyAtAttempt,
    stage: "rectification",
    logger: getSafeLogger(),
    rethinkSection: `## ⚠️ Previous Attempt Did Not Fix the Failures

Your previous fix attempt (attempt ${attempt}) did not resolve all failures. **Step back and reconsider your approach.**

- The root cause may be different from what you assumed.
- Avoid iterating on the same fix — try a **fundamentally different strategy**.
- Re-read the story context and test failures carefully before making changes.
- Consider: are there missing edge cases, incorrect assumptions, or a design flaw in the implementation?

`,
    urgencySection: `## 🚨 Final Rectification Attempt Before Model Escalation

This is attempt ${attempt} — if the tests still fail after this, the task will escalate to a stronger model tier.
A **completely different approach** is required. Do not repeat what you have already tried.

`,
  });
}

/** Number of failing files above which rectification falls back to a full-suite run instead of per-file commands. */
const DEFAULT_SCOPE_FILE_THRESHOLD = 10;

/**
 * Deduplicate TestFailure[] by (file, testName).
 * When the same suite is parsed twice (e.g. run output + regression detector),
 * identical entries are concatenated without dedup. This ensures each distinct
 * failure appears only once in the rectification prompt.
 */
function deduplicateFailures(failures: TestFailure[]): TestFailure[] {
  const seen = new Set<string>();
  return failures.filter((f) => {
    const key = `${f.file}\0${f.testName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Normalize a failure file path to repo-root-relative form.
 * Strips leading "../" sequences that appear when a sub-package test runner
 * (e.g. running from apps/api/) reports paths relative to its own cwd.
 */
function normalizeFailurePath(file: string): string {
  let normalized = file;
  while (normalized.startsWith("../")) {
    normalized = normalized.slice(3);
  }
  return normalized;
}

/**
 * Create a rectification prompt with failure context.
 *
 * @deprecated Superseded by {@link RectifierPromptBuilder} (Phase 5 refactor).
 * Production callers now use `RectifierPromptBuilder.for("verify-failure")` from `src/prompts`.
 * This function is retained only while existing unit tests and acceptance tests are migrated.
 * Do not add new callers — use RectifierPromptBuilder instead.
 *
 * Includes:
 * - Progressive escalation preamble when attempt >= rethinkAtAttempt (or urgencyAtAttempt)
 * - Clear instructions about test regressions
 * - Formatted failure summary (duplicates removed)
 * - Per-file test commands when failing files ≤ scopeFileThreshold; full-suite command otherwise
 *   (mirrors the ScopedStrategy fallback pattern from quality.scopeTestThreshold)
 * - testScopedTemplate (e.g. "jest --testPathPattern={{files}}") is used for per-file commands
 *   when set; falls back to "${testCommand} <file>" (mirrors scoped.ts buildScopedCommand)
 */
export function createRectificationPrompt(
  failures: TestFailure[],
  story: UserStory,
  config?: RectificationConfig,
  /** Attempt number for progressive escalation preamble. Pass undefined to suppress. */
  attempt?: number,
  /** Full-suite test command (quality.commands.test). Used for full-suite fallback and as base for scoped commands. */
  testCommand?: string,
  /** Max failing files before falling back to full suite (quality.scopeTestThreshold). */
  scopeFileThreshold?: number,
  /** Scoped test command template with {{files}} placeholder (quality.commands.testScoped). Used for per-file commands when set. */
  testScopedTemplate?: string,
): string {
  const uniqueFailures = deduplicateFailures(failures);
  const maxChars = config?.maxFailureSummaryChars ?? 2000;
  const failureSummary = formatFailureSummary(uniqueFailures, maxChars);

  const cmd = testCommand ?? "bun test";
  const threshold = scopeFileThreshold ?? DEFAULT_SCOPE_FILE_THRESHOLD;

  // Extract unique failing test files (normalized)
  const allFiles = Array.from(new Set(uniqueFailures.map((f) => normalizeFailurePath(f.file))));

  let testCommands: string;
  let filterNote: string;
  if (allFiles.length > threshold) {
    // Full-suite fallback: too many failing files — scoped commands would mislead the agent
    testCommands = `  ${cmd}`;
    filterNote = `- ${allFiles.length} files are failing — run the full suite to catch all regressions at once.`;
  } else {
    // Scoped commands: one per unique failing file, using testScopedTemplate when available
    testCommands = allFiles
      .map((file) => {
        const scopedCmd = testScopedTemplate ? testScopedTemplate.replace("{{files}}", file) : `${cmd} ${file}`;
        return `  ${scopedCmd}`;
      })
      .join("\n");
    filterNote = `- When running tests, run ONLY the failing test files shown above — NEVER run \`${cmd}\` without a file filter.`;
  }

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
${filterNote}
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
  /** Full-suite test command (quality.commands.test). */
  testCommand?: string,
  /** Scoped test command template with {{files}} placeholder (quality.commands.testScoped). Used for per-file commands when set. */
  testScopedTemplate?: string,
): string {
  const maxChars = config?.maxFailureSummaryChars ?? 2000;
  const failureSummary = formatFailureSummary(failures, maxChars);

  const cmd = testCommand ?? "bun test";

  // Extract unique failing test files
  const failingFiles = Array.from(new Set(failures.map((f) => f.file)));
  const testCommands = failingFiles
    .map((file) => {
      const scopedCmd = testScopedTemplate ? testScopedTemplate.replace("{{files}}", file) : `${cmd} ${file}`;
      return `  ${scopedCmd}`;
    })
    .join("\n");

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
- When running tests, run ONLY the failing test files shown above — NEVER run \`${cmd}\` without a file filter.
`;
}

// Re-export types for consumers that import from this module
export type { RectificationState } from "./types";
