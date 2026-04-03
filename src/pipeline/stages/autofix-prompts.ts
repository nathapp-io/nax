/**
 * Autofix prompt builders — check-specific rectification prompts.
 *
 * Extracted from autofix.ts to stay within the 400-line limit.
 * Semantic failures get an AC-focused prompt that instructs the agent
 * to verify findings before acting. Mechanical failures (lint/typecheck)
 * get the original direct-fix prompt.
 */

import type { UserStory } from "../../prd";
import type { ReviewCheckResult } from "../../review/types";

function formatCheckErrors(checks: ReviewCheckResult[]): string {
  return checks.map((c) => `## ${c.check} errors (exit code ${c.exitCode})\n\`\`\`\n${c.output}\n\`\`\``).join("\n\n");
}

function buildSemanticRectificationPrompt(
  semanticChecks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
): string {
  const errors = formatCheckErrors(semanticChecks);
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
Commit your fixes when done.${scopeConstraint}`;
}

function buildMechanicalRectificationPrompt(
  mechanicalChecks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
): string {
  const errors = formatCheckErrors(mechanicalChecks);

  return `You are fixing lint/typecheck errors from a code review.

Story: ${story.title} (${story.id})

The following quality checks failed after implementation:

${errors}

Fix ALL errors listed above. Do NOT change test files or test behavior.
Do NOT add new features — only fix the quality check errors.
Commit your fixes when done.${scopeConstraint}`;
}

export function buildReviewRectificationPrompt(failedChecks: ReviewCheckResult[], story: UserStory): string {
  // ENH-008: Scope constraint for monorepo stories — prevent out-of-package changes
  const scopeConstraint = story.workdir
    ? `\n\nIMPORTANT: Only modify files within \`${story.workdir}/\`. Do NOT touch files outside this directory.`
    : "";

  const semanticChecks = failedChecks.filter((c) => c.check === "semantic");
  const mechanicalChecks = failedChecks.filter((c) => c.check !== "semantic");

  // Pure semantic failure — use AC-focused prompt
  if (semanticChecks.length > 0 && mechanicalChecks.length === 0) {
    return buildSemanticRectificationPrompt(semanticChecks, story, scopeConstraint);
  }

  // Pure mechanical failure — use original lint/typecheck prompt
  if (mechanicalChecks.length > 0 && semanticChecks.length === 0) {
    return buildMechanicalRectificationPrompt(mechanicalChecks, story, scopeConstraint);
  }

  // Mixed — combine both sections
  const mechanicalSection = formatCheckErrors(mechanicalChecks);
  const semanticSection = formatCheckErrors(semanticChecks);
  const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

  return `You are fixing issues from a code review.

Story: ${story.title} (${story.id})

## Lint/Typecheck Errors

${mechanicalSection}

Fix ALL lint/typecheck errors listed above.

## Semantic Review Findings (AC Compliance)

### Acceptance Criteria
${acList}

### Findings
${semanticSection}

**Important:** The semantic reviewer may have flagged false positives. Before making changes for semantic findings, read the relevant files to verify each finding is a real issue. Do NOT add keys, functions, or imports that already exist.

Do NOT change test files or test behavior.
Do NOT add new features — only fix the identified issues.
Commit your fixes when done.${scopeConstraint}`;
}
