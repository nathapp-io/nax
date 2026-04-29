/**
 * RectifierPromptBuilder — shared helpers and constants.
 *
 * Extracted from rectifier-builder.ts to keep each file within the 600-line project limit.
 * All helpers are pure functions with no dependencies on the builder class.
 */

import type { UserStory } from "../../prd";
import type { ReviewCheckResult } from "../../review/types";

/**
 * Reviewer contradiction escape hatch (REVIEW-003).
 *
 * Appended to all rectification prompts so the implementer can signal
 * when two findings cannot both be satisfied. The autofix stage detects
 * "UNRESOLVED: <explanation>" in the agent output and escalates instead
 * of retrying — avoiding an infinite loop on an unresolvable conflict.
 */
export const CONTRADICTION_ESCAPE_HATCH = `
If two findings in this list contradict each other and you cannot satisfy both, do not guess.
Emit fixes for defects you can resolve, then output a line in this exact format:
UNRESOLVED: <brief explanation of which findings conflicted and why they cannot both be satisfied>`;

export function formatCheckErrors(checks: ReviewCheckResult[]): string {
  return checks.map((c) => `## ${c.check} errors (exit code ${c.exitCode})\n\`\`\`\n${c.output}\n\`\`\``).join("\n\n");
}

export function semanticRectification(checks: ReviewCheckResult[], story: UserStory, scopeConstraint: string): string {
  const errors = formatCheckErrors(checks);
  const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

  return `You are fixing acceptance criteria compliance issues found during semantic review.

Story: ${story.title} (${story.id})

### Acceptance Criteria
${acList}

### Semantic Review Findings
${errors}

**Important:** The semantic reviewer only analyzed the git diff and may have flagged false positives (e.g., claiming a key or function is "missing" when it already exists in the codebase). Before making any changes:
1. Read the relevant files to verify each finding is a real issue
2. Only fix findings that are actually valid problems
3. Do NOT add keys, functions, or imports that already exist — check first

Do NOT change test files or test behavior.
Do NOT add new features — only fix valid issues.
Commit your fixes when done.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
}

export function adversarialRectification(
  checks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
): string {
  const errors = formatCheckErrors(checks);
  const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

  return `You are fixing issues found during an adversarial code review.

Story: ${story.title} (${story.id})

### Acceptance Criteria
${acList}

### Adversarial Review Findings
${errors}

**Important:** The adversarial reviewer probes for breakage, missing error paths, and edge cases. Before making any changes:
1. Read the relevant files to verify each finding is a real issue
2. Only fix findings that are actually valid problems
3. Do NOT add keys, functions, or imports that already exist — check first

Do NOT add new features — only fix valid issues.
Commit your fixes when done.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
}

export function combinedLlmRectification(
  semanticChecks: ReviewCheckResult[],
  adversarialChecks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
): string {
  const semanticErrors = formatCheckErrors(semanticChecks);
  const adversarialErrors = formatCheckErrors(adversarialChecks);
  const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

  return `You are fixing issues found during LLM code review.

Story: ${story.title} (${story.id})

### Acceptance Criteria
${acList}

### Semantic Review Findings
${semanticErrors}

### Adversarial Review Findings
${adversarialErrors}

**Important:** LLM reviewers may flag false positives. Before making any changes:
1. Read the relevant files to verify each finding is a real issue
2. Only fix findings that are actually valid problems
3. Do NOT add keys, functions, or imports that already exist — check first

Do NOT add new features — only fix valid issues.
Commit your fixes when done.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
}

export function mechanicalRectification(
  checks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
): string {
  const errors = formatCheckErrors(checks);

  return `You are fixing lint/typecheck errors from a code review.

Story: ${story.title} (${story.id})

The following quality checks failed after implementation:

${errors}

Fix ALL errors listed above. Do NOT change test files or test behavior.
Do NOT add new features — only fix the quality check errors.
After fixing, re-run the failing check(s) to verify they pass, then commit your changes.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
}
