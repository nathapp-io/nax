/**
 * Autofix prompt builders — check-specific rectification prompts.
 *
 * Extracted from autofix.ts to stay within the 400-line limit.
 * Semantic failures get an AC-focused prompt that instructs the agent
 * to verify findings before acting. Mechanical failures (lint/typecheck)
 * get the original direct-fix prompt.
 */

import type { UserStory } from "../../prd";
import { CONTRADICTION_ESCAPE_HATCH } from "../../prompts";
import type { DialogueMessage } from "../../review/dialogue";
import type { ReviewCheckResult } from "../../review/types";

export { CONTRADICTION_ESCAPE_HATCH };

export interface DialogueAwarePromptOptions {
  findingReasoning: Map<string, string>;
  history: DialogueMessage[];
  /** Max number of history messages to include (default: all) */
  maxHistoryMessages?: number;
}

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
Commit your fixes when done.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
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
Commit your fixes when done.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
}

export function buildReviewRectificationPrompt(failedChecks: ReviewCheckResult[], story: UserStory): string {
  // ENH-008: Scope constraint for monorepo stories — prevent out-of-package changes
  const scopeConstraint = story.workdir
    ? `\n\nIMPORTANT: Only modify files within \`${story.workdir}/\`. Do NOT touch files outside this directory.`
    : "";

  // Both semantic and adversarial failures need AC-aware rectification — not the mechanical prompt.
  const semanticChecks = failedChecks.filter((c) => c.check === "semantic" || c.check === "adversarial");
  const mechanicalChecks = failedChecks.filter((c) => c.check !== "semantic" && c.check !== "adversarial");

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
Commit your fixes when done.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
}

export function buildDialogueAwareRectificationPrompt(
  failedChecks: ReviewCheckResult[],
  story: UserStory,
  opts: DialogueAwarePromptOptions,
): string {
  const { findingReasoning, history, maxHistoryMessages } = opts;
  const scopeConstraint = story.workdir
    ? `\n\nIMPORTANT: Only modify files within \`${story.workdir}/\`. Do NOT touch files outside this directory.`
    : "";

  const errors = formatCheckErrors(failedChecks);

  // Build reasoning section from findingReasoning map
  let reasoningSection = "";
  if (findingReasoning.size > 0) {
    const entries = Array.from(findingReasoning.entries())
      .map(([key, reason]) => `**${key}:** ${reason}`)
      .join("\n");
    reasoningSection = `\n\n### Finding Reasoning\n${entries}`;
  }

  // Build dialogue history section (last N messages)
  let historySection = "";
  if (history.length > 0) {
    const slice = maxHistoryMessages !== undefined ? history.slice(-maxHistoryMessages) : history;
    const lines = slice.map((m) => `**${m.role}:** ${m.content}`).join("\n\n");
    historySection = `\n\n### Dialogue History\n${lines}`;
  }

  return `You are fixing acceptance criteria compliance issues found during semantic review.

Story: ${story.title} (${story.id})

### Semantic Review Findings
${errors}${reasoningSection}${historySection}

**Important:** The semantic reviewer only analyzed the git diff and may have flagged false positives. Before making any changes:
1. Read the relevant files to verify each finding is a real issue
2. Only fix findings that are actually valid problems
3. Do NOT add keys, functions, or imports that already exist — check first

Do NOT change test files or test behavior.
Do NOT add new features — only fix valid issues.
Commit your fixes when done.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
}
