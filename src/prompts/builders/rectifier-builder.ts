/**
 * RectifierPromptBuilder — prompt builder for rectification sessions.
 *
 * Cross-domain: needs TDD context (story, isolation, role task) AND review context
 * (prior failures, findings). A dedicated builder avoids forcing rectification prompts
 * into either TddPromptBuilder or ReviewPromptBuilder.
 *
 * Four triggers cover all rectification entry points:
 *   tdd-test-failure  — implementer fixes tests written by the test-writer
 *   tdd-suite-failure — implementer fixes regressions after the full-suite gate
 *   verify-failure    — post-verify rectification loop (autofix)
 *   review-findings   — review surfaced critical findings; rectifier addresses them
 *
 * Replaces: buildImplementerRectificationPrompt / buildRectificationPrompt from src/tdd/prompts.ts
 */

import type { RectificationConfig } from "../../config";
import type { UserStory } from "../../prd";
import type { ReviewCheckResult } from "../../review/types";
import { formatFailureSummary } from "../../verification/parser";
import type { TestFailure } from "../../verification/types";
import {
  SectionAccumulator,
  findingsSection,
  priorFailuresSection,
  universalConstitutionSection,
  universalContextSection,
} from "../core";
import type { FailureRecord, PromptSection, ReviewFinding } from "../core";
import { buildConventionsSection, buildIsolationSection, buildStorySection } from "../sections";

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

export type RectifierTrigger =
  | "tdd-test-failure" // tests written by test-writer fail; implementer rectifies
  | "tdd-suite-failure" // full suite fails after implementation
  | "verify-failure" // post-verify rectification (autofix loop)
  | "review-findings"; // review surfaced critical findings; rectifier addresses them

export type { FailureRecord, ReviewFinding };

export class RectifierPromptBuilder {
  private acc = new SectionAccumulator();
  private trigger: RectifierTrigger;

  private constructor(trigger: RectifierTrigger) {
    this.trigger = trigger;
  }

  static for(trigger: RectifierTrigger): RectifierPromptBuilder {
    return new RectifierPromptBuilder(trigger);
  }

  constitution(c: string | undefined): this {
    this.acc.add(universalConstitutionSection(c));
    return this;
  }

  context(md: string | undefined): this {
    this.acc.add(universalContextSection(md));
    return this;
  }

  story(s: UserStory): this {
    this.acc.add(this.s("story", buildStorySection(s)));
    return this;
  }

  priorFailures(failures: FailureRecord[]): this {
    this.acc.add(priorFailuresSection(failures));
    return this;
  }

  findings(fs: ReviewFinding[]): this {
    this.acc.add(findingsSection(fs));
    return this;
  }

  testCommand(cmd: string | undefined): this {
    if (!cmd) return this;
    this.acc.add({
      id: "test-command",
      overridable: false,
      content: `# TEST COMMAND\n\n\`${cmd}\``,
    });
    return this;
  }

  isolation(mode?: "strict" | "lite"): this {
    this.acc.add(this.s("isolation", buildIsolationSection("implementer", mode, undefined)));
    return this;
  }

  conventions(): this {
    this.acc.add(this.s("conventions", buildConventionsSection()));
    return this;
  }

  task(): this {
    this.acc.add(rectifierTaskFor(this.trigger));
    return this;
  }

  build(): Promise<string> {
    return Promise.resolve(this.acc.join());
  }

  /**
   * Lean transition prompt for the first autofix attempt when the implementer
   * session is confirmed open (PROMPT-001 / #412).
   *
   * The agent already has full story context from the execution session — only
   * the review findings need to be delivered. Avoids re-sending story title, ACs,
   * and other context that is already in the conversation history.
   */
  static firstAttemptDelta(failedChecks: ReviewCheckResult[], maxAttempts: number): string {
    const parts: string[] = [];
    const attemptWord = maxAttempts === 1 ? "1 attempt" : `${maxAttempts} attempts`;

    parts.push(
      `Review failed after your implementation. Fix the following issues (${attemptWord} available before escalation):\n`,
    );

    for (const check of failedChecks) {
      parts.push(`### ${check.check} (exit ${check.exitCode})\n`);
      const truncated = check.output.length > 4000;
      const output = truncated
        ? `${check.output.slice(0, 4000)}\n... (truncated — ${check.output.length} chars total)`
        : check.output;
      parts.push(`\`\`\`\n${output}\n\`\`\`\n`);
      if (check.findings?.length) {
        parts.push("Structured findings:\n");
        for (const f of check.findings) {
          parts.push(`- [${f.severity}] ${f.file}:${f.line} — ${f.message}\n`);
        }
      }
    }

    parts.push("\nFix ALL issues listed. Do NOT change test files or test behavior. Commit your fixes when done.");
    parts.push(CONTRADICTION_ESCAPE_HATCH);

    return parts.join("\n");
  }

  /**
   * Builds a delta-only continuation prompt for autofix retry attempts (PROMPT-001).
   *
   * Sent on attempt 2+ when the implementer session is confirmed open.
   * Contains ONLY new error output + escalation preamble — NOT the full prompt.
   * This keeps retry tokens ~70% lower than re-sending the full rectification prompt.
   */
  static continuation(
    failedChecks: ReviewCheckResult[],
    attempt: number,
    rethinkAtAttempt: number,
    urgencyAtAttempt: number,
  ): string {
    const parts: string[] = [];

    parts.push("Your previous fix attempt did not resolve all issues. Here are the remaining failures:\n");

    for (const check of failedChecks) {
      parts.push(`### ${check.check} (exit ${check.exitCode})\n`);
      const truncated = check.output.length > 4000;
      const output = truncated
        ? `${check.output.slice(0, 4000)}\n... (truncated — ${check.output.length} chars total)`
        : check.output;
      parts.push(`\`\`\`\n${output}\n\`\`\`\n`);
      if (check.findings?.length) {
        parts.push("Structured findings:\n");
        for (const f of check.findings) {
          parts.push(`- [${f.severity}] ${f.file}:${f.line} — ${f.message}\n`);
        }
      }
    }

    if (attempt >= rethinkAtAttempt) {
      parts.push(
        "\n**Rethink your approach.** The same strategy has failed multiple times. Consider a fundamentally different fix.\n",
      );
    }
    if (attempt >= urgencyAtAttempt) {
      parts.push(
        "\n**URGENT: This is your final attempt.** If you cannot fix all issues, emit `UNRESOLVED: <reason>` to escalate.\n",
      );
    }

    parts.push(CONTRADICTION_ESCAPE_HATCH);

    return parts.join("\n");
  }

  /**
   * Prompt for the test-writer to fix test file issues flagged by adversarial review (#409).
   *
   * Sent when adversarial review found problems in test files that the implementer
   * cannot fix (isolation constraint). The test-writer is allowed to modify test files.
   */
  static testWriterRectification(testFileFindings: ReviewCheckResult[], story: UserStory): string {
    const scopeConstraint = story.workdir
      ? `\n\nIMPORTANT: Only modify test files within \`${story.workdir}/\`. Do NOT touch source files.`
      : "\n\nIMPORTANT: Only modify test files. Do NOT touch source implementation files.";

    const findingLines = testFileFindings
      .flatMap((c) => c.findings ?? [])
      .map((f) => `- [${f.severity}] ${f.file}:${f.line} — ${f.message}`)
      .join("\n");

    const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

    return `You are fixing test file issues flagged by an adversarial code reviewer.

Story: ${story.title} (${story.id})

### Acceptance Criteria
${acList}

### Test File Findings (adversarial review)
${findingLines}

**Important:** These findings are in test files. Before making any changes:
1. Read the flagged test files to verify each finding is a real issue
2. Only fix findings that are genuinely incorrect or missing — do NOT remove tests
3. Do NOT modify source implementation files

Commit your fixes when done.${scopeConstraint}`;
  }

  /**
   * Re-prompt sent when the agent produced no file changes on a previous turn.
   *
   * Used by the no-op short-circuit in autofix.ts: when git HEAD doesn't advance
   * after an agent run, we re-prompt once without counting the attempt, forcing the
   * agent to either edit files or emit UNRESOLVED.
   */
  static noOpReprompt(failedChecks: ReviewCheckResult[], noOpCount: number, maxNoOpReprompts: number): string {
    const parts: string[] = [];

    parts.push(
      "**Your previous turn produced no file changes.**\n\n" +
        "You must take one of these two actions:\n" +
        "1. **Edit source files** to address the review findings listed below, OR\n" +
        "2. **Emit `UNRESOLVED: <reason>`** if the findings are contradictory or cannot be fixed\n\n",
    );

    if (noOpCount >= maxNoOpReprompts) {
      parts.push(
        "**WARNING:** If you produce no file changes again this attempt will count against your rectification budget.\n\n",
      );
    }

    parts.push("## Remaining Review Failures\n\n");

    for (const check of failedChecks) {
      parts.push(`### ${check.check} (exit ${check.exitCode})\n`);
      const truncated = check.output.length > 4000;
      const output = truncated
        ? `${check.output.slice(0, 4000)}\n... (truncated — ${check.output.length} chars total)`
        : check.output;
      parts.push(`\`\`\`\n${output}\n\`\`\`\n\n`);
      if (check.findings?.length) {
        parts.push("Structured findings:\n");
        for (const f of check.findings) {
          parts.push(`- [${f.severity}] ${f.file}:${f.line} — ${f.message}\n`);
        }
        parts.push("\n");
      }
    }

    parts.push(CONTRADICTION_ESCAPE_HATCH);
    return parts.join("");
  }

  /**
   * Prompt for escalation to a higher-tier model after exhausting retries.
   *
   * Migrated from createEscalatedRectificationPrompt() in src/verification/rectification.ts.
   */
  static escalated(
    failures: TestFailure[],
    story: UserStory,
    priorAttempts: number,
    originalTier: string,
    targetTier: string,
    config?: RectificationConfig,
    testCommand?: string,
    testScopedTemplate?: string,
  ): string {
    const maxChars = config?.maxFailureSummaryChars ?? 2000;
    const failureSummary = formatFailureSummary(failures, maxChars);

    // #543: do not invent a `bun test` command for Go / Python / Rust packages.
    // If no testCommand is configured, surface the file without a command so the
    // agent uses its project's native test runner rather than a wrong default.
    const cmd = testCommand ?? "";

    const failingFiles = Array.from(new Set(failures.map((f) => f.file)));
    const testCommands = failingFiles
      .map((file) => {
        const scopedCmd = testScopedTemplate
          ? testScopedTemplate.replace("{{files}}", file)
          : cmd
            ? `${cmd} ${file}`
            : file;
        return `  ${scopedCmd}`;
      })
      .join("\n");

    const failingTestNames = failures.map((f) => f.testName);
    let failingTestsSection: string;
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
- When running tests, run ONLY the failing test files shown above${cmd ? ` — NEVER run \`${cmd}\` without a file filter` : " — never run the full test suite without a file filter"}.
`;
  }

  /**
   * Builds a rectification prompt for failed review checks (semantic, adversarial, or mechanical).
   *
   * Routes to the correct prompt based on which check types failed:
   *   - semantic only   → semanticRectification()
   *   - adversarial only → adversarialRectification()
   *   - mechanical only → mechanicalRectification()
   *   - mixed           → combined prompt with labelled sections per check type
   *
   * Migrated from buildReviewRectificationPrompt() in src/pipeline/stages/autofix-prompts.ts.
   */
  static reviewRectification(failedChecks: ReviewCheckResult[], story: UserStory): string {
    const scopeConstraint = story.workdir
      ? `\n\nIMPORTANT: Only modify files within \`${story.workdir}/\`. Do NOT touch files outside this directory.`
      : "";

    const semanticChecks = failedChecks.filter((c) => c.check === "semantic");
    const adversarialChecks = failedChecks.filter((c) => c.check === "adversarial");
    const mechanicalChecks = failedChecks.filter((c) => c.check !== "semantic" && c.check !== "adversarial");

    const llmChecks = [...semanticChecks, ...adversarialChecks];

    if (llmChecks.length > 0 && mechanicalChecks.length === 0) {
      if (adversarialChecks.length === 0) {
        return RectifierPromptBuilder.semanticRectification(semanticChecks, story, scopeConstraint);
      }
      if (semanticChecks.length === 0) {
        return RectifierPromptBuilder.adversarialRectification(adversarialChecks, story, scopeConstraint);
      }
      // Both semantic and adversarial failed — combined LLM reviewer prompt.
      return RectifierPromptBuilder.combinedLlmRectification(semanticChecks, adversarialChecks, story, scopeConstraint);
    }

    if (mechanicalChecks.length > 0 && llmChecks.length === 0) {
      return RectifierPromptBuilder.mechanicalRectification(mechanicalChecks, story, scopeConstraint);
    }

    // Mixed: mechanical + one or more LLM reviewer checks.
    const mechanicalSection = RectifierPromptBuilder.formatCheckErrors(mechanicalChecks);
    const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

    const llmSection =
      semanticChecks.length > 0 && adversarialChecks.length > 0
        ? `## Semantic Review Findings\n\n${RectifierPromptBuilder.formatCheckErrors(semanticChecks)}\n\n## Adversarial Review Findings\n\n${RectifierPromptBuilder.formatCheckErrors(adversarialChecks)}`
        : semanticChecks.length > 0
          ? `## Semantic Review Findings\n\n${RectifierPromptBuilder.formatCheckErrors(semanticChecks)}`
          : `## Adversarial Review Findings\n\n${RectifierPromptBuilder.formatCheckErrors(adversarialChecks)}`;

    return `You are fixing issues from a code review.

Story: ${story.title} (${story.id})

## Lint/Typecheck Errors

${mechanicalSection}

Fix ALL lint/typecheck errors listed above.

## LLM Review Findings (AC Compliance)

### Acceptance Criteria
${acList}

### Findings
${llmSection}

**Important:** LLM reviewers may flag false positives. Before making changes for LLM review findings, read the relevant files to verify each finding is a real issue. Do NOT add keys, functions, or imports that already exist.

Do NOT add new features — only fix the identified issues.
Commit your fixes when done.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
  }

  /**
   * Builds a rectification prompt that includes dialogue history and finding reasoning.
   *
   * Migrated from buildDialogueAwareRectificationPrompt() in src/pipeline/stages/autofix-prompts.ts.
   */
  static dialogueAwareRectification(
    failedChecks: ReviewCheckResult[],
    story: UserStory,
    opts: {
      findingReasoning: Map<string, string>;
      history: Array<{ role: string; content: string }>;
      maxHistoryMessages?: number;
    },
  ): string {
    const scopeConstraint = story.workdir
      ? `\n\nIMPORTANT: Only modify files within \`${story.workdir}/\`. Do NOT touch files outside this directory.`
      : "";

    const errors = RectifierPromptBuilder.formatCheckErrors(failedChecks);

    let reasoningSection = "";
    if (opts.findingReasoning.size > 0) {
      const entries = Array.from(opts.findingReasoning.entries())
        .map(([key, reason]) => `**${key}:** ${reason}`)
        .join("\n");
      reasoningSection = `\n\n### Finding Reasoning\n${entries}`;
    }

    let historySection = "";
    if (opts.history.length > 0) {
      const slice = opts.maxHistoryMessages !== undefined ? opts.history.slice(-opts.maxHistoryMessages) : opts.history;
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

  private static formatCheckErrors(checks: ReviewCheckResult[]): string {
    return checks
      .map((c) => `## ${c.check} errors (exit code ${c.exitCode})\n\`\`\`\n${c.output}\n\`\`\``)
      .join("\n\n");
  }

  private static semanticRectification(checks: ReviewCheckResult[], story: UserStory, scopeConstraint: string): string {
    const errors = RectifierPromptBuilder.formatCheckErrors(checks);
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

  private static adversarialRectification(
    checks: ReviewCheckResult[],
    story: UserStory,
    scopeConstraint: string,
  ): string {
    const errors = RectifierPromptBuilder.formatCheckErrors(checks);
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

  private static combinedLlmRectification(
    semanticChecks: ReviewCheckResult[],
    adversarialChecks: ReviewCheckResult[],
    story: UserStory,
    scopeConstraint: string,
  ): string {
    const semanticErrors = RectifierPromptBuilder.formatCheckErrors(semanticChecks);
    const adversarialErrors = RectifierPromptBuilder.formatCheckErrors(adversarialChecks);
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

  private static mechanicalRectification(
    checks: ReviewCheckResult[],
    story: UserStory,
    scopeConstraint: string,
  ): string {
    const errors = RectifierPromptBuilder.formatCheckErrors(checks);

    return `You are fixing lint/typecheck errors from a code review.

Story: ${story.title} (${story.id})

The following quality checks failed after implementation:

${errors}

Fix ALL errors listed above. Do NOT change test files or test behavior.
Do NOT add new features — only fix the quality check errors.
Commit your fixes when done.${scopeConstraint}${CONTRADICTION_ESCAPE_HATCH}`;
  }

  private s(id: string, content: string): PromptSection {
    return { id, content, overridable: false };
  }
}

function rectifierTaskFor(trigger: RectifierTrigger): PromptSection {
  switch (trigger) {
    case "tdd-test-failure":
      return { id: "task", overridable: false, content: TDD_TEST_FAILURE_TASK };
    case "tdd-suite-failure":
      return { id: "task", overridable: false, content: TDD_SUITE_FAILURE_TASK };
    case "verify-failure":
      return { id: "task", overridable: false, content: VERIFY_FAILURE_TASK };
    case "review-findings":
      return { id: "task", overridable: false, content: REVIEW_FINDINGS_TASK };
  }
}

const TDD_TEST_FAILURE_TASK = `# Rectification Required

The tests written for this story are failing. Fix the implementation to make them pass without modifying the test files.

## Instructions

1. Review the failures listed above carefully.
2. Identify the root cause of each failure.
3. Fix the implementation WITHOUT modifying test files.
4. Run the test command shown above to verify your fixes.
5. Ensure ALL tests pass before completing.

**IMPORTANT:**
- Do NOT modify test files — they were written by the test-writer and define the expected behavior.
- Do NOT loosen assertions to mask implementation bugs.
- Focus on fixing the source code to meet the test requirements.`;

const TDD_SUITE_FAILURE_TASK = `# Rectification Required

Your changes caused test regressions. Fix these without breaking existing logic.

## Instructions

1. Review the failures above carefully.
2. Identify the root cause of each failure.
3. Fix the implementation WITHOUT loosening test assertions.
4. Run the test command shown above to verify your fixes.
5. Ensure ALL tests pass before completing.

**IMPORTANT:**
- Do NOT modify test files unless there is a legitimate bug in the test itself.
- Do NOT loosen assertions to mask implementation bugs.
- Focus on fixing the source code to meet the test requirements.`;

const VERIFY_FAILURE_TASK = `# Rectification Required

The verification step failed. Fix the implementation to pass all tests.

## Instructions

1. Review the failures above carefully.
2. Identify the root cause of each failure.
3. Fix the implementation WITHOUT loosening test assertions.
4. Run the test command shown above to verify your fixes.
5. Ensure ALL tests pass before completing.

**IMPORTANT:**
- Do NOT modify test files unless there is a legitimate bug in the test itself.
- Do NOT loosen assertions to mask implementation bugs.
- Focus on fixing the source code to meet the test requirements.`;

const REVIEW_FINDINGS_TASK = `# Rectification Required

The code review surfaced critical findings that must be addressed before this story can proceed.

## Instructions

1. Review the findings listed above carefully.
2. Verify each finding is a real issue by reading the relevant files.
3. Fix only valid issues — do NOT add code that already exists in the codebase.
4. Do NOT change test files or test behavior.
5. Do NOT add new features — only fix the identified issues.

**IMPORTANT:**
- The reviewer may have flagged false positives based on the diff. Verify before acting.
- Commit your fixes when done.`;
