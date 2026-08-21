/**
 * RectifierPromptBuilder — shared helpers and constants.
 *
 * Extracted from rectifier-builder.ts to keep each file within the 600-line project limit.
 * All helpers are pure functions with no dependencies on the builder class.
 */

import { isSingleSessionTestOwningStrategy, isThreeSessionStrategy } from "@/config";
import type { Finding } from "@/findings/types";
import type { UserStory } from "@/prd";
import { isBlockingSeverity } from "@/review";
import type { ReviewCheckResult } from "@/review/types";
import { buildIsolationSection, buildNaxArtifactsSection } from "../sections";

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
- FILES must list real test files. Each path must exist and be a test file.
- Write each path exactly as it appears in the findings above (repository-relative).
  Paths that resolve under neither the repository root nor the package directory are
  rejected and the handoff is dropped — the findings then have no owner.`;

// ─── Escape hatch builder ─────────────────────────────────────────────────────

interface EscapeHatchOptions {
  includeMockHandoff: boolean;
  /**
   * Include Exception 3 (sibling spillover). Defaults to true. The repo-scoped
   * rectification prompt (#1654) omits it: Exception 3 licenses declining an
   * out-of-scope failure and continuing, which is the instruction that dispatch
   * exists to override.
   */
  includeSiblingScope?: boolean;
}

/**
 * Builds the contradiction escape hatch section for rectification prompts.
 *
 * Dynamically includes or excludes Exception 4 (mock-structure handoff) based on
 * whether the story runs a three-session TDD flow that has a test-writer agent.
 * The intro count always matches the number of included exceptions.
 */
export function buildEscapeHatch(opts: EscapeHatchOptions): string {
  const exceptions: string[] = [EXCEPTION_1_LINT_ONLY, EXCEPTION_2_PRD_CONTRACT];
  if (opts.includeSiblingScope !== false) exceptions.push(EXCEPTION_3_SIBLING_SCOPE);
  if (opts.includeMockHandoff) exceptions.push(EXCEPTION_4_MOCK_HANDOFF);

  const count = exceptions.length;
  const countWord = ["zero", "one", "two", "three", "four"][count];

  return `
If two findings in this list contradict each other and you cannot satisfy both, do not guess.
Emit fixes for defects you can resolve, then output a line in this exact format:
UNRESOLVED: <brief explanation of which findings conflicted and why they cannot both be satisfied>

Before emitting UNRESOLVED, confirm none of Exceptions 1–${count} apply.

**A missing-test or \`test-gap\` finding is never a false positive because a \`.nax/\` file exists.**
\`.nax/\` is nax's own artifact directory; \`.nax-acceptance.test.ts\` is generated scaffolding for the
acceptance gate — it is NOT source-tree test coverage. You may NOT cite any \`.nax/\`-resident file as
evidence that an acceptance criterion is already tested, and you may NOT emit UNRESOLVED on that basis.
The only valid response to a missing-test finding is to
author a real test under the package's resolved test path.

${buildNaxArtifactsSection("implementer")}

## Test-file edit exceptions

The "do not modify test files" rule has ${countWord} narrow escape valves. Each requires a
declaration in your output. Outside these ${countWord} cases the rule is absolute.

${exceptions.join("\n\n")}`;
}

/**
 * True when the story's strategy makes the implementer the author of its own
 * tests (single-session). Such an implementer may edit test files to resolve
 * genuine AC/spec contradictions during rectification.
 *
 * Strategy classification is the SSOT in `src/config/test-strategy.ts`.
 */
export function implementerOwnsTests(story: UserStory): boolean {
  return isSingleSessionTestOwningStrategy(story.routing?.testStrategy);
}

/**
 * Permit-with-guard headline for single-session implementers. Replaces the
 * "Do NOT change test files…" prohibition that three-session stories receive.
 */
const SINGLE_SESSION_PERMIT_HEADLINE =
  "You authored these tests in the same session as the implementation, so you MAY edit test files — but ONLY to resolve a genuine contradiction between a test and this story's acceptance criteria (or between two acceptance criteria). NEVER weaken, delete, loosen, or skip a test merely to make it pass. See the test-edit guidance appended below.";

/**
 * Appended guidance block for single-session implementers. Stands in for the
 * Exception 1–4 escape hatch (which encodes an absolute prohibition with narrow
 * valves). Here the rule is inverted: edits are permitted but bounded.
 */
const SINGLE_SESSION_TEST_EDIT_POLICY = `

## Test-edit guidance (single-session implementer)

You wrote both the tests and the implementation for this story in one session, so no
separate test-writer owns the test contract. You therefore MAY edit test files during
rectification — subject to these limits:

- Edit a test ONLY to resolve a genuine contradiction between the test and an acceptance
  criterion, a contradiction between two acceptance criteria, or a clear defect in a test
  you authored (wrong arity/type, impossible setup, or asserting behavior the ACs do not require).
- NEVER weaken, delete, loosen, or \`skip\` a test simply because the implementation fails it.
  A failing test usually means the SOURCE is wrong — fix the source first.
- The semantic and adversarial reviewers still gate correctness; gaming a test to pass will be caught.

If two findings or two acceptance criteria contradict each other and you cannot satisfy
both even after adjusting tests, do not guess. Emit:
UNRESOLVED: <which findings/ACs conflicted and why they cannot both be satisfied>`;

/**
 * Returns the test-edit directive sentence for a rectification prompt.
 *
 * For single-session strategies the implementer authored its own tests, so the
 * directive permits bounded test edits. For all other strategies the caller's
 * `prohibition` text (the existing "Do NOT … test files …" sentence) is returned
 * verbatim, keeping three-session/no-test prompts byte-identical.
 */
export function testEditHeadline(story: UserStory, prohibition: string): string {
  return implementerOwnsTests(story) ? SINGLE_SESSION_PERMIT_HEADLINE : prohibition;
}

/**
 * Returns "three" or "four" depending on whether the story uses a three-session TDD
 * flow that includes a test-writer agent. Use to interpolate counts in prompt text
 * that sits outside the escape-hatch block.
 */
export function exceptionCountWord(story: UserStory): "three" | "four" {
  return isThreeSessionStrategy(story.routing?.testStrategy) ? "four" : "three";
}

/**
 * Builds the story-specific escape-hatch section, including or excluding Exception 4
 * based on whether the story runs a three-session TDD flow with a test-writer.
 */
export function escapeHatchFor(story: UserStory): string {
  if (implementerOwnsTests(story)) return SINGLE_SESSION_TEST_EDIT_POLICY;
  const isTdd = isThreeSessionStrategy(story.routing?.testStrategy);
  return buildEscapeHatch({ includeMockHandoff: isTdd });
}

/**
 * Safe-default escape-hatch constant for callers that lack story context
 * (e.g. continuation, noOpReprompt without story param).
 *
 * Uses three exceptions (no Exception 4) — the safe default that avoids
 * advertising a mock-structure handoff to non-TDD stories. Pass story to
 * escapeHatchFor(story) whenever story context is available.
 */
export const CONTRADICTION_ESCAPE_HATCH = buildEscapeHatch({ includeMockHandoff: false });

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
4. Break the fix into one small step per valid finding before touching code, each verified by re-running the relevant check

${testEditHeadline(story, `Do NOT change test files or test behavior — see the ${exceptionCountWord(story)} narrow exceptions appended below.`)}
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
4. Break the fix into one small step per valid finding before touching code, each verified by re-running the relevant check

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
4. Break the fix into one small step per valid finding before touching code, each verified by re-running the relevant check

Do NOT add new features — only fix valid issues.
Commit your fixes when done.${scopeConstraint}${noTestIsolationBlock(story)}${escapeHatchFor(story)}`;
}

/**
 * Formats the failing-test bullet list shared by failingTestContext and
 * failingTestRectification. Returns only the listing lines; callers append
 * the closing directive and any escape-hatch sections.
 */
export function formatFailingTestsList(findings: Finding[]): string {
  if (findings.length === 0) {
    return "The full test suite has failing tests. Fix the implementation to make all tests pass.";
  }
  const lines: string[] = [`Fix the following ${findings.length} failing test${findings.length === 1 ? "" : "s"}:\n`];
  for (const f of findings) {
    const location = f.file ? `${f.file}` : "(unknown file)";
    const rule = f.rule ? `  Test: ${f.rule}\n` : "";
    lines.push(`- ${location}\n${rule}  Error: ${f.message}\n`);
  }
  return lines.join("\n");
}

export function mechanicalRectification(
  checks: ReviewCheckResult[],
  story: UserStory,
  scopeConstraint: string,
  opts?: CheckErrorFormatOptions,
): string {
  const errors = formatCheckErrors(checks, opts);
  const scopeDirective = implementerOwnsTests(story)
    ? `Fix all errors listed above that are within this story's scope. ${SINGLE_SESSION_PERMIT_HEADLINE}`
    : `Fix all errors listed above that are within this story's scope — see the ${exceptionCountWord(story)} narrow exceptions appended below for sibling-story spillover. Do NOT change test files or test behavior except via those exceptions.`;

  return `You are fixing lint/typecheck errors from a code review.

Story: ${story.title} (${story.id})

The following quality checks failed after implementation:

${errors}

${scopeDirective}
Do NOT add new features — only fix the quality check errors.
After fixing, re-run the failing check(s) to verify they pass, then commit your changes.${scopeConstraint}${noTestIsolationBlock(story)}${escapeHatchFor(story)}`;
}

// ─── Repo-scoped rectification (#1654) ────────────────────────────────────────

/**
 * The mandate for the repo-scoped fallthrough dispatch.
 *
 * Reached only after a story-scoped rectifier answered UNRESOLVED on a failing
 * test it judged out of scope. The story-scoped prompt asks the agent to fix a
 * test while forbidding it from touching what is broken; UNRESOLVED is the
 * agent correctly reporting that contradiction. This lifts the scope constraint
 * and nothing else — an agent free to edit any file is exactly the one that must
 * still be barred from making a red test green by weakening it.
 */
const REPO_SCOPE_MANDATE = `
These tests are failing, and a previous story-scoped attempt declined them as outside
this story's scope. That constraint is lifted: you MAY modify any file in the repository,
including files this story did not otherwise touch, when that is what it takes to make
these tests pass.

The scope constraint is lifted. The test-integrity rules are NOT:
- Fix the SOURCE. Never weaken, loosen, delete, or \`skip\` a test to make it pass.
- Do not edit test files outside the declared exceptions below.
- Make the smallest change that makes the test pass. This is not a refactor.
- Re-run the test suite after each change to verify.

If a test does not fail consistently, do NOT try to make it pass. Re-run it a few
times in isolation first. A test that passes on some runs is flaky, and editing it to
be green hides a real defect — emit UNRESOLVED naming the test and say it is flaky.

"It was not caused by this story" is not a reason to decline. Whether the failure
predates this story or was introduced by it, the remedy is the same and it is yours to
apply. Emit UNRESOLVED only when these tests cannot be made to pass at all — they
contradict each other, or they require infrastructure that does not exist and cannot be
created here. Say which, specifically.`;

/**
 * Build the repo-scoped failing-test rectification prompt.
 *
 * Drops Exception 3 (sibling spillover) — it instructs the agent to declare
 * `sibling_scope` and move on, which re-licenses the refusal this dispatch
 * responds to — and Exception 4 (mock-structure handoff), whose target is the
 * story's own test-writer and does not own tests outside the story.
 */
export function repoScopedRectification(findings: Finding[], story: UserStory): string {
  if (implementerOwnsTests(story)) {
    return [formatFailingTestsList(findings), REPO_SCOPE_MANDATE, SINGLE_SESSION_TEST_EDIT_POLICY].join("\n");
  }
  const hatch = buildEscapeHatch({ includeMockHandoff: false, includeSiblingScope: false });
  return [formatFailingTestsList(findings), REPO_SCOPE_MANDATE, hatch].join("\n");
}
