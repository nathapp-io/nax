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

import type { UserStory } from "../../prd";
import type { ReviewCheckResult } from "../../review/types";
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
