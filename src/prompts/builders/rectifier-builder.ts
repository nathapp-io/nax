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
import { SectionAccumulator } from "../core/section-accumulator";
import { findingsSection } from "../core/sections/findings";
import type { ReviewFinding } from "../core/sections/findings";
import { priorFailuresSection } from "../core/sections/prior-failures";
import type { FailureRecord } from "../core/sections/prior-failures";
import type { PromptSection } from "../core/types";
import { universalConstitutionSection, universalContextSection } from "../core/universal-sections";
import { buildConventionsSection } from "../sections/conventions";
import { buildIsolationSection } from "../sections/isolation";
import { buildStorySection } from "../sections/story";

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
