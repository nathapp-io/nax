/**
 * RectifierPromptBuilder — prompt builder for rectification sessions.
 *
 * Cross-domain: needs TDD context (story, isolation, role task) AND review context
 * (prior failures, findings). A dedicated builder avoids forcing rectification prompts
 * into either TddPromptBuilder or ReviewPromptBuilder.
 *
 * Replaces: buildImplementerRectificationPrompt / buildRectificationPrompt from src/tdd/prompts.ts
 *
 * NOTE: This class is being deprecated in favor of static factory methods.
 * The old `for(trigger)` builder pattern is removed in ADR-018 / Issue #737 PR 2.
 * Remaining: static methods for review, autofix, and escalation prompts.
 */

import type { RectificationConfig } from "../../config";
import type { UserStory } from "../../prd";
import { isBlockingSeverity } from "../../review/severity";
import type { ReviewCheckName, ReviewCheckResult } from "../../review/types";
import { formatFailureSummary } from "../../verification/parser";
import type { TestFailure } from "../../verification/types";
import { priorFailuresSection, universalConstitutionSection, universalContextSection } from "../core";
import type { FailureRecord, ReviewFinding } from "../core";
import { buildConventionsSection, buildIsolationSection, buildStorySection } from "../sections";
import {
  CONTRADICTION_ESCAPE_HATCH,
  adversarialRectification,
  combinedLlmRectification,
  formatCheckErrors,
  mechanicalRectification,
  semanticRectification,
} from "./rectifier-builder-helpers";

export { CONTRADICTION_ESCAPE_HATCH } from "./rectifier-builder-helpers";

export type { FailureRecord, ReviewFinding };

/**
 * Trigger type for rectification sessions.
 * Kept for backward compatibility and reference.
 * No longer used in the fluent builder pattern (which was removed).
 */
export type RectifierTrigger = "tdd-test-failure" | "tdd-suite-failure" | "verify-failure" | "review-findings";

type RectificationPriority = "compile-build" | "lint" | "behavior" | "semantic" | "architectural";

interface RectifierRenderOpts {
  blockingThreshold?: "error" | "warning" | "info";
}

interface PriorityBucket {
  priority: number;
  heading: string;
  guidance: string;
}

const PRIORITY_BUCKETS: Readonly<Record<RectificationPriority, PriorityBucket>> = {
  "compile-build": {
    priority: 1,
    heading: "Compile/build",
    guidance: "Must fix first. Fixes here may resolve later items automatically.",
  },
  lint: {
    priority: 2,
    heading: "Lint/style",
    guidance: "Fix after compile errors. Often automated.",
  },
  behavior: {
    priority: 3,
    heading: "Behavior",
    guidance: "Fix after compile passes. Indicates implementation does not match assertion.",
  },
  semantic: {
    priority: 4,
    heading: "Semantic",
    guidance: "Story-alignment concerns. Re-read the story before editing.",
  },
  architectural: {
    priority: 5,
    heading: "Architectural",
    guidance: "Lowest priority. Fix only after all above pass.",
  },
};

const PRIORITY_ORDER: Readonly<RectificationPriority[]> = [
  "compile-build",
  "lint",
  "behavior",
  "semantic",
  "architectural",
];

function priorityForCheck(checkName: ReviewCheckName): RectificationPriority {
  switch (checkName) {
    case "typecheck":
    case "build":
      return "compile-build";
    case "lint":
      return "lint";
    case "test":
      return "behavior";
    case "semantic":
      return "semantic";
    case "adversarial":
      return "architectural";
    default:
      return assertNever(checkName);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled review check category: ${String(value)}`);
}

function renderCheckBlock(check: ReviewCheckResult, opts?: RectifierRenderOpts): string {
  const parts: string[] = [];
  parts.push(`### ${check.check} (exit ${check.exitCode})\n`);
  const truncated = check.output.length > 4000;
  const output = truncated
    ? `${check.output.slice(0, 4000)}\n... (truncated — ${check.output.length} chars total)`
    : check.output;
  parts.push(`\`\`\`\n${output}\n\`\`\`\n`);

  // Defensive filter — only blocking-severity findings drive the fix prompt,
  // even if the caller populated `findings` with mixed severities.
  const threshold = opts?.blockingThreshold ?? "error";
  const blocking = (check.findings ?? []).filter((f) => isBlockingSeverity(f.severity, threshold));
  if (blocking.length > 0) {
    parts.push("Structured findings:\n");
    for (const f of blocking) {
      parts.push(`- [${f.severity}] ${f.file}:${f.line} — ${f.message}\n`);
    }
  }

  return parts.join("\n");
}

function renderPrioritizedFailures(failedChecks: Readonly<ReviewCheckResult[]>, opts?: RectifierRenderOpts): string {
  const grouped: Readonly<Record<RectificationPriority, Readonly<ReviewCheckResult[]>>> = {
    "compile-build": failedChecks.filter((check) => priorityForCheck(check.check) === "compile-build"),
    lint: failedChecks.filter((check) => priorityForCheck(check.check) === "lint"),
    behavior: failedChecks.filter((check) => priorityForCheck(check.check) === "behavior"),
    semantic: failedChecks.filter((check) => priorityForCheck(check.check) === "semantic"),
    architectural: failedChecks.filter((check) => priorityForCheck(check.check) === "architectural"),
  };

  const sections: string[] = [
    "**Order matters: fix Priority 1 first; later priorities may need redo if earlier ones change the code.**\n",
  ];

  for (const priority of PRIORITY_ORDER) {
    const checks = grouped[priority];
    if (checks.length === 0) {
      continue;
    }

    const bucket = PRIORITY_BUCKETS[priority];
    sections.push(`## Priority ${bucket.priority} — ${bucket.heading}\n`);
    sections.push(`${bucket.guidance}\n`);
    for (const check of checks) {
      sections.push(renderCheckBlock(check, opts));
    }
  }

  return sections.join("\n");
}

// biome-ignore lint/complexity/noStaticOnlyClass: Static-method namespace for prompt builders (ADR-018)
export class RectifierPromptBuilder {
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

    parts.push(renderPrioritizedFailures(failedChecks));

    parts.push(
      "\nFix in priority order. After fixing each priority, re-run the failing check(s) at that level to verify they pass before moving on. Do NOT change test files or test behavior. Commit your changes when all checks pass.",
    );
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

    parts.push(renderPrioritizedFailures(failedChecks));

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
   * Prompt for the test-writer to fix test file issues or write failing tests (D2, #897).
   *
   * Two modes:
   * - "fix-test-files" (default): fix existing test files flagged by review (#409).
   * - "write-failing-test": write a NEW failing test that documents spec-correct behavior
   *   described in an adversarial source-bug finding. The implementer then makes it pass.
   */
  static testWriterRectification(
    findings: ReviewCheckResult[],
    story: UserStory,
    options?: { mode?: "fix-test-files" | "write-failing-test"; blockingThreshold?: "error" | "warning" | "info" },
  ): string {
    if (options?.mode === "write-failing-test") {
      return RectifierPromptBuilder._testWriterWriteFailingTest(findings, story, options);
    }
    return RectifierPromptBuilder._testWriterFixTestFiles(findings, story, options);
  }

  private static _testWriterWriteFailingTest(
    findings: ReviewCheckResult[],
    story: UserStory,
    opts?: { blockingThreshold?: "error" | "warning" | "info" },
  ): string {
    const threshold = opts?.blockingThreshold ?? "error";
    const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
    const findingLines = findings
      .flatMap((c) =>
        (c.findings ?? [])
          .filter((f) => isBlockingSeverity(f.severity, threshold))
          .map((f) => `- [${f.severity}] ${f.file ?? "unknown"}:${f.line ?? "?"} — ${f.message}`),
      )
      .join("\n");

    const scopeConstraint = story.workdir
      ? `\n\nIMPORTANT: Only create or modify test files within \`${story.workdir}/\`. Do NOT touch source files.`
      : "\n\nIMPORTANT: Only create or modify test files. Do NOT touch source implementation files.";

    return `You are writing a failing test that documents spec-correct behavior.

Story: ${story.title} (${story.id})

### Acceptance Criteria
${acList}

### Source Bugs Found by Adversarial Review
${findingLines}

**Task:** For each bug above, write a NEW failing test that asserts the spec-correct behavior described in the finding. The test should FAIL with the current (buggy) implementation and PASS once the implementer fixes the source.

Rules:
1. Write the test against the SPECIFICATION, not the current behavior.
2. Do NOT fix the source files — only write test files.
3. Do NOT modify existing passing tests.
4. The test must fail with the current code.

Commit your new tests when done.${scopeConstraint}`;
  }

  private static _testWriterFixTestFiles(
    testFileFindings: ReviewCheckResult[],
    story: UserStory,
    opts?: { blockingThreshold?: "error" | "warning" | "info" },
  ): string {
    const threshold = opts?.blockingThreshold ?? "error";
    const scopeConstraint = story.workdir
      ? `\n\nIMPORTANT: Only modify test files within \`${story.workdir}/\`. Do NOT touch source files.`
      : "\n\nIMPORTANT: Only modify test files. Do NOT touch source implementation files.";

    const checkTypes = new Set(testFileFindings.map((c) => c.check));
    const isLintOnly = checkTypes.size === 1 && checkTypes.has("lint");
    const hasAdversarial = checkTypes.has("adversarial");

    const opener = isLintOnly
      ? "You are fixing test file lint errors."
      : hasAdversarial
        ? "You are fixing test file issues flagged by an adversarial code reviewer."
        : "You are fixing test file issues.";

    const sectionLabel = isLintOnly
      ? "lint"
      : hasAdversarial && checkTypes.size === 1
        ? "adversarial review"
        : "review";

    const findingLines = testFileFindings
      .flatMap((c) => {
        if (c.findings && c.findings.length > 0) {
          return c.findings
            .filter((f) => isBlockingSeverity(f.severity, threshold))
            .map((f) => `- [${f.severity}] ${f.file}:${f.line} — ${f.message}`);
        }
        // Lint raw output has no per-line severity, so the blocking filter above does not apply here.
        if (c.check === "lint" && c.output.trim()) {
          return [c.output.trim()];
        }
        return [];
      })
      .join("\n");

    const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

    const importantNote = isLintOnly
      ? "**Important:** Fix the lint errors in the test files listed above. Do NOT modify source implementation files."
      : `**Important:** You are encoding the SPECIFICATION, not the current behavior.

Before making any changes:
1. Read the flagged test files to verify each finding is a real issue.
2. Do NOT loosen assertions to match current implementation behavior. If a test is failing because the source is wrong, the source is the suspect — not the test.
3. Do NOT delete a failing test because the implementation makes it hard to assert on. Refactor the test structure if needed; never silently drop coverage.
4. If the current behavior disagrees with the acceptance criteria, write the test against the spec and let the implementer fix the source.
5. Do NOT modify source implementation files.`;

    return `${opener}

Story: ${story.title} (${story.id})

### Acceptance Criteria
${acList}

### Test File Findings (${sectionLabel})
${findingLines}

${importantNote}

Commit your fixes when done.${scopeConstraint}`;
  }

  /**
   * Re-prompt sent when the agent produced no file changes on a previous turn.
   *
   * Used by the no-op short-circuit in autofix.ts: when git HEAD doesn't advance
   * after an agent run, we re-prompt once without counting the attempt, forcing the
   * agent to either edit files or emit UNRESOLVED.
   */
  static noOpReprompt(
    failedChecks: ReviewCheckResult[],
    noOpCount: number,
    maxNoOpReprompts: number,
    opts?: RectifierRenderOpts,
  ): string {
    const parts: string[] = [];

    parts.push(
      "**Your previous turn produced no committed file changes.**\n\n" +
        "You must take one of these two actions:\n" +
        "1. **Edit project files** (source code, configuration, or dependency manifest) to address the review findings listed below, then **commit** the changes, OR\n" +
        "2. **Emit `UNRESOLVED: <reason>`** if the findings are contradictory or cannot be fixed\n\n" +
        "**Important:** Running a dependency-install command alone (e.g. `bun install`, `npm install`, `go mod tidy`, `pip install`, `cargo fetch`) does not count — if a package is missing, add it to your project's dependency manifest AND commit. Staged-but-uncommitted changes also do not count.\n\n" +
        "After editing, re-run the failing check(s) to verify they pass, then commit.\n\n",
    );

    if (noOpCount >= maxNoOpReprompts) {
      parts.push(
        "**WARNING:** If you produce no file changes again this attempt will count against your rectification budget.\n\n",
      );
    }

    parts.push("## Remaining Review Failures\n\n");

    const threshold = opts?.blockingThreshold ?? "error";
    for (const check of failedChecks) {
      parts.push(`### ${check.check} (exit ${check.exitCode})\n`);
      const truncated = check.output.length > 4000;
      const output = truncated
        ? `${check.output.slice(0, 4000)}\n... (truncated — ${check.output.length} chars total)`
        : check.output;
      parts.push(`\`\`\`\n${output}\n\`\`\`\n\n`);
      const blocking = (check.findings ?? []).filter((f) => isBlockingSeverity(f.severity, threshold));
      if (blocking.length > 0) {
        parts.push("Structured findings:\n");
        for (const f of blocking) {
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
        return semanticRectification(semanticChecks, story, scopeConstraint);
      }
      if (semanticChecks.length === 0) {
        return adversarialRectification(adversarialChecks, story, scopeConstraint);
      }
      // Both semantic and adversarial failed — combined LLM reviewer prompt.
      return combinedLlmRectification(semanticChecks, adversarialChecks, story, scopeConstraint);
    }

    if (mechanicalChecks.length > 0 && llmChecks.length === 0) {
      return mechanicalRectification(mechanicalChecks, story, scopeConstraint);
    }

    // Mixed: mechanical + one or more LLM reviewer checks.
    const mechanicalSection = formatCheckErrors(mechanicalChecks);
    const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

    const llmSection =
      semanticChecks.length > 0 && adversarialChecks.length > 0
        ? `## Semantic Review Findings\n\n${formatCheckErrors(semanticChecks)}\n\n## Adversarial Review Findings\n\n${formatCheckErrors(adversarialChecks)}`
        : semanticChecks.length > 0
          ? `## Semantic Review Findings\n\n${formatCheckErrors(semanticChecks)}`
          : `## Adversarial Review Findings\n\n${formatCheckErrors(adversarialChecks)}`;

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

    const errors = formatCheckErrors(failedChecks);

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

  /**
   * Prepends handoff markdown to a base prompt when swapping to a new agent.
   *
   * Used by execution.ts during agent fallback: when an agent is unavailable
   * and nax swaps to a different agent, the new agent needs context about
   * what happened before (prior context, rebuild info, etc.). This function
   * composes that delta into the prompt.
   */
  static swapHandoff(basePrompt: string, pushMarkdown?: string): string {
    const trimmed = pushMarkdown?.trim();
    if (!trimmed) return basePrompt;
    return `${trimmed}\n\n${basePrompt}`;
  }

  /**
   * Prompt for implementing rectification when tests fail after implementation.
   *
   * Used when the full test suite reveals failures — either during the TDD
   * full-suite gate (rectification-gate.ts) or post-verify rectification
   * (rectification-loop.ts). Demand is explicit: agents must run the FULL
   * test command, not just the listed failures.
   *
   * Covers both semantic scenarios:
   *   - tdd-suite-failure — implementation's changes broke existing tests
   *   - verify-failure — post-verify rectification caught cross-story regressions
   *
   * Issue #737 consolidates both into this single method (removed separate
   * trigger-based branching in PR 2).
   *
   * @param opts.story — the story context
   * @param opts.failures — test failures to display
   * @param opts.testCommand — the full-suite test command to run
   * @param opts.conventions — whether to include conventions section (default: true)
   * @param opts.isolation — isolation mode ("strict" | "lite"), if any
   * @param opts.constitution — constitution text, if any
   * @param opts.context — context markdown, if any
   * @param opts.promptPrefix — diagnostic prefix (e.g., from debate stage), if any
   * @returns fully assembled prompt string
   */
  static regressionFailure(opts: {
    story: UserStory;
    failures: FailureRecord[];
    testCommand: string;
    conventions?: boolean;
    isolation?: "strict" | "lite";
    constitution?: string;
    context?: string;
    promptPrefix?: string;
  }): string {
    const parts: string[] = [];

    // 1. Diagnostic prefix (optional)
    if (opts.promptPrefix) {
      parts.push(opts.promptPrefix);
      parts.push("\n\n");
    }

    // 2. Constitution (optional)
    if (opts.constitution) {
      const constSection = universalConstitutionSection(opts.constitution);
      if (constSection) {
        parts.push(constSection.content);
        parts.push("\n\n");
      }
    }

    // 3. Context (optional)
    if (opts.context) {
      const ctxSection = universalContextSection(opts.context);
      if (ctxSection) {
        parts.push(ctxSection.content);
        parts.push("\n\n");
      }
    }

    // 4. Story section
    parts.push(buildStorySection(opts.story));
    parts.push("\n\n");

    // 5. Prior failures section
    const failureSection = priorFailuresSection(opts.failures);
    if (failureSection) {
      parts.push(failureSection.content);
      parts.push("\n\n");
    }

    // 6. Test command section
    parts.push(`# TEST COMMAND\n\n\`${opts.testCommand}\``);
    parts.push("\n\n");

    // 7. Isolation (optional)
    if (opts.isolation) {
      parts.push(buildIsolationSection("implementer", opts.isolation, undefined));
      parts.push("\n\n");
    }

    // 8. Conventions (optional, default true)
    if (opts.conventions !== false) {
      parts.push(buildConventionsSection());
      parts.push("\n\n");
    }

    // 9. Task section with explicit full-suite demand
    parts.push(`# Rectification Required

Tests are failing. Fix the source so all tests pass — not just the ones listed.

## Instructions

1. Review the failures above and identify the root cause of each.
2. Fix the source code WITHOUT loosening test assertions or removing tests.
3. After your fix, run the FULL repo test suite — the EXACT command below:

   \`${opts.testCommand}\`

   The verifier will replay this same command. If you only run the failing
   tests in isolation, you may have introduced cross-story regressions you
   won't see. There is no benefit to skipping this — the verifier WILL catch
   anything you miss, and you'll just be back here in another cycle.

4. Do not declare done until step 3 shows 0 failures.

**IMPORTANT:**
- Do NOT modify test files unless there is a legitimate bug in the test itself.
- Do NOT loosen assertions to mask implementation bugs.
- Focus on fixing the source code to meet the test requirements.`);

    return parts.join("");
  }
}
