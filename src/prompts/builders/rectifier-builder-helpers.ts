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
UNRESOLVED: <brief explanation of which findings conflicted and why they cannot both be satisfied>

## Test-file edit exceptions

The "do not modify test files" rule has three narrow escape valves. Each requires a
declaration in your output. Outside these three cases the rule is absolute.

### Exception 1 — Lint-only edit

You MAY edit a test file ONLY when ALL of the following hold:
- The failing check is \`lint\` — not \`test\`, \`typecheck\`, \`semantic\`, or \`adversarial\`.
- Your edit removes or reformats a lint violation without altering any \`expect\`, \`assert\`,
  \`toBe\`, \`toEqual\`, \`toThrow\`, \`not.\`, or equivalent assertion call, its arguments, its
  input data, its mock setup, or its \`describe\`/\`it\`/\`test\` block text.
- If you are uncertain whether your edit is assertion-neutral, do NOT make it — emit
  \`UNRESOLVED\` instead.

Declare every lint-only test edit with:
\`\`\`
TEST_EDIT_REASON: lint_only
FILE: <test file path>
FINDING: <lint rule or message verbatim>
CHANGE: <before line> → <after line>
\`\`\`

### Exception 2 — PRD-contract mismatch

You MAY correct a test's argument arity, type, or return-handling ONLY when the test's
call contradicts a literal interface signature stated in this story's description or
acceptance criteria.

Declare every contract-mismatch edit with:
\`\`\`
TEST_EDIT_REASON: prd_contract
PRD_QUOTE: "<verbatim signature line from the story description or acceptance criteria>"
FILE: <test file path>
TEST_BEFORE: <offending call line>
TEST_AFTER: <corrected call line>
\`\`\`

Do NOT use this exception to change test logic, assertions, or mock setup — only call
signatures that directly contradict a quoted PRD interface.

### Exception 3 — Sibling-story lint spillover

When a lint or typecheck error is in a file you did NOT create or modify in this turn,
do NOT edit that file. Instead declare:
\`\`\`
TEST_EDIT_REASON: sibling_scope
SIBLING_FILE: <file path>
FINDING: <error summary>
\`\`\`
and continue. Sibling-scope failures do not block your story.`;

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

Do NOT change test files or test behavior — see the three narrow exceptions appended below.
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

Fix all errors listed above that are within this story's scope — see the three narrow exceptions appended below for sibling-story spillover. Do NOT change test files or test behavior except via those exceptions.
Do NOT add new features — only fix the quality check errors.
After fixing, re-run the failing check(s) to verify they pass, then commit your changes.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
}
