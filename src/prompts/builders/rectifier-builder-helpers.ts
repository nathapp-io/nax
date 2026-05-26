/**
 * RectifierPromptBuilder — shared helpers and constants.
 *
 * Extracted from rectifier-builder.ts to keep each file within the 600-line project limit.
 * All helpers are pure functions with no dependencies on the builder class.
 */

import type { UserStory } from "@/prd";
import { isBlockingSeverity } from "@/review";
import type { ReviewCheckResult } from "@/review/types";
import { buildIsolationSection } from "../sections";

interface CheckErrorFormatOptions {
  blockingThreshold?: "error" | "warning" | "info";
}

// ─── Individual exception constants ───────────────────────────────────────────

const EXCEPTION_1_LINT_ONLY = `### Exception 1 — Lint-only edit

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
\`\`\``;

const EXCEPTION_2_PRD_CONTRACT = `### Exception 2 — PRD-contract mismatch

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
signatures that directly contradict a quoted PRD interface.`;

const EXCEPTION_3_SIBLING_SCOPE = `### Exception 3 — Unrelated sibling spillover

When a lint or typecheck error is outside this story's intended scope, do NOT edit that
file. If the smallest package-local fix is required to satisfy this story's acceptance
criteria, you MAY make that fix instead. Otherwise declare:
\`\`\`
TEST_EDIT_REASON: sibling_scope
SIBLING_FILE: <file path>
FINDING: <error summary>
\`\`\`
and continue. Sibling-scope failures do not block your story.`;

/**
 * Exception 4 is only valid for three-session TDD flows that have a test-writer.
 * Broadened to cover both case (a) wrong mocks and case (b) missing test infrastructure.
 */
const EXCEPTION_4_MOCK_HANDOFF = `### Exception 4 — Mock-structure handoff

Use ONLY when the only path to satisfy the ACs requires a structural test rewrite
that does NOT fit Exception 2. Two cases qualify:

  (a) Existing mocks are wrong — mocks reference primitives the new code bypasses,
      or assertion topology must change to match a new dispatch shape.

  (b) Required test-infrastructure does not yet exist and must be introduced —
      e.g. in-process fake servers, network-level request interception, hermetic
      fixture-backed HTTP, or equivalent. Applies whenever the AC describes a
      hermetic/fixture-backed test surface that the current test setup cannot
      satisfy without new infrastructure.

Declare with:
\`\`\`
TEST_EDIT_REASON: mock_structure
FILES: <comma-separated test file paths>
REASON: <one paragraph: which mock is wrong vs which dispatch the new code uses,
         or what infrastructure must be introduced>
\`\`\`

Rules:
- Do NOT make any edits yourself; the test-writer will fulfill.
- Do NOT also emit \`UNRESOLVED:\` in the same turn — this declaration IS the handoff.
- FILES must list real test files. Each path must exist and be a test file.`;

// ─── Escape hatch builder ─────────────────────────────────────────────────────

interface EscapeHatchOptions {
  includeMockHandoff: boolean;
}

/**
 * Builds the contradiction escape hatch section for rectification prompts.
 *
 * Dynamically includes or excludes Exception 4 (mock-structure handoff) based on
 * whether the story runs a three-session TDD flow that has a test-writer agent.
 * The intro count always matches the number of included exceptions.
 */
export function buildEscapeHatch(opts: EscapeHatchOptions): string {
  const exceptions: string[] = [EXCEPTION_1_LINT_ONLY, EXCEPTION_2_PRD_CONTRACT, EXCEPTION_3_SIBLING_SCOPE];
  if (opts.includeMockHandoff) exceptions.push(EXCEPTION_4_MOCK_HANDOFF);

  const count = exceptions.length;
  const countWord = ["zero", "one", "two", "three", "four"][count];

  return `
If two findings in this list contradict each other and you cannot satisfy both, do not guess.
Emit fixes for defects you can resolve, then output a line in this exact format:
UNRESOLVED: <brief explanation of which findings conflicted and why they cannot both be satisfied>

Before emitting UNRESOLVED, confirm none of Exceptions 1–${count} apply.

## Test-file edit exceptions

The "do not modify test files" rule has ${countWord} narrow escape valves. Each requires a
declaration in your output. Outside these ${countWord} cases the rule is absolute.

${exceptions.join("\n\n")}`;
}

/**
 * Returns "three" or "four" depending on whether the story uses a three-session TDD
 * flow that includes a test-writer agent. Use to interpolate counts in prompt text
 * that sits outside the escape-hatch block.
 */
export function exceptionCountWord(story: UserStory): "three" | "four" {
  return THREE_SESSION_STRATEGIES.has(story.routing?.testStrategy ?? "") ? "four" : "three";
}

/**
 * Backward-compatible alias: always includes all four exceptions.
 * Used by methods that lack story context (continuation, noOpReprompt).
 * Prefer escapeHatchFor(story) in story-aware contexts.
 */
export const CONTRADICTION_ESCAPE_HATCH = buildEscapeHatch({ includeMockHandoff: true });

const THREE_SESSION_STRATEGIES = new Set(["three-session-tdd", "three-session-tdd-lite"]);

export function escapeHatchFor(story: UserStory): string {
  const isTdd = THREE_SESSION_STRATEGIES.has(story.routing?.testStrategy ?? "");
  return buildEscapeHatch({ includeMockHandoff: isTdd });
}

function noTestIsolationBlock(story: UserStory): string {
  if (story.routing?.testStrategy !== "no-test") return "";
  return `\n\n${buildIsolationSection("no-test")}`;
}

export function formatCheckErrors(checks: ReviewCheckResult[], opts?: CheckErrorFormatOptions): string {
  return checks.map((c) => formatCheckError(c, opts)).join("\n\n");
}

const MAX_STRUCTURED_FINDINGS = 10;
const RAW_WITH_FINDINGS_LIMIT = 1_000;
const RAW_FALLBACK_LIMIT = 4_000;

function capText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... (truncated — ${value.length} chars total)`;
}

function formatFindingLine(finding: NonNullable<ReviewCheckResult["findings"]>[number]): string {
  const location = typeof finding.line === "number" ? `${finding.file}:${finding.line}` : finding.file;
  return `- [${finding.severity}] ${location} ${finding.rule ? `${finding.rule} ` : ""}— ${finding.message}`;
}

function formatCheckError(check: ReviewCheckResult, opts?: CheckErrorFormatOptions): string {
  const lines: string[] = [`## ${check.check} errors (exit code ${check.exitCode})`];
  const threshold = opts?.blockingThreshold ?? "error";
  const blocking = (check.findings ?? []).filter((f) => isBlockingSeverity(f.severity, threshold));

  if (blocking.length > 0) {
    lines.push("Structured findings:");
    for (const finding of blocking.slice(0, MAX_STRUCTURED_FINDINGS)) {
      lines.push(formatFindingLine(finding));
    }
    const remaining = blocking.length - MAX_STRUCTURED_FINDINGS;
    if (remaining > 0) {
      lines.push(`...and ${remaining} more blocking findings`);
    }
    lines.push("");
    lines.push("Raw output excerpt:");
    lines.push("```");
    lines.push(capText(check.output, RAW_WITH_FINDINGS_LIMIT));
    lines.push("```");
    return lines.join("\n");
  }

  lines.push("```");
  lines.push(capText(check.output, RAW_FALLBACK_LIMIT));
  lines.push("```");
  return lines.join("\n");
}

export function semanticRectification(
  checks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
  opts?: CheckErrorFormatOptions,
): string {
  const errors = formatCheckErrors(checks, opts);
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

Do NOT change test files or test behavior — see the ${exceptionCountWord(story)} narrow exceptions appended below.
Do NOT add new features — only fix valid issues.
Commit your fixes when done.${scopeConstraint}${noTestIsolationBlock(story)}${escapeHatchFor(story)}`;
}

export function adversarialRectification(
  checks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
  opts?: CheckErrorFormatOptions,
): string {
  const errors = formatCheckErrors(checks, opts);
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
Commit your fixes when done.${scopeConstraint}${noTestIsolationBlock(story)}${escapeHatchFor(story)}`;
}

export function combinedLlmRectification(
  semanticChecks: ReviewCheckResult[],
  adversarialChecks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
  opts?: CheckErrorFormatOptions,
): string {
  const semanticErrors = formatCheckErrors(semanticChecks, opts);
  const adversarialErrors = formatCheckErrors(adversarialChecks, opts);
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
Commit your fixes when done.${scopeConstraint}${noTestIsolationBlock(story)}${escapeHatchFor(story)}`;
}

export function mechanicalRectification(
  checks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
  opts?: CheckErrorFormatOptions,
): string {
  const errors = formatCheckErrors(checks, opts);

  return `You are fixing lint/typecheck errors from a code review.

Story: ${story.title} (${story.id})

The following quality checks failed after implementation:

${errors}

Fix all errors listed above that are within this story's scope — see the ${exceptionCountWord(story)} narrow exceptions appended below for sibling-story spillover. Do NOT change test files or test behavior except via those exceptions.
Do NOT add new features — only fix the quality check errors.
After fixing, re-run the failing check(s) to verify they pass, then commit your changes.${scopeConstraint}${noTestIsolationBlock(story)}${escapeHatchFor(story)}`;
}
