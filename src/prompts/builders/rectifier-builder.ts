/**
 * RectifierPromptBuilder
 *
 * Centralises all rectification prompt construction across:
 *   - src/tdd/rectification-gate.ts (tdd-suite-failure)
 *   - src/verification/rectification-loop.ts (verify-failure)
 *
 * Wraps createRectificationPrompt from verification/rectification to provide
 * a consistent fluent API across all rectification triggers.
 *
 * Replaces: src/tdd/prompts.ts (deleted in Phase 5)
 */

import type { RectificationConfig } from "../../config";
import type { UserStory } from "../../prd";
import type { TestFailure } from "../../test-runners/types";
import { createRectificationPrompt } from "../../verification/rectification";

export type RectifierTrigger =
  | "tdd-test-failure" // tests written by test-writer fail; implementer rectifies
  | "tdd-suite-failure" // full suite fails after implementation
  | "verify-failure" // post-verify rectification (autofix loop)
  | "review-findings"; // review surfaced critical findings; rectifier addresses them

export class RectifierPromptBuilder {
  private story_: UserStory | undefined;
  private failures_: TestFailure[] = [];
  private rectConfig_: RectificationConfig | undefined;
  private attempt_: number | undefined;
  private testCommand_: string | undefined;
  private scopeFileThreshold_: number | undefined;
  private testScopedTemplate_: string | undefined;

  // _trigger accepted for API symmetry; reserved for future per-trigger task text.
  private constructor(_trigger: RectifierTrigger) {}

  static for(trigger: RectifierTrigger): RectifierPromptBuilder {
    return new RectifierPromptBuilder(trigger);
  }

  story(s: UserStory): this {
    this.story_ = s;
    return this;
  }

  /**
   * Provide the test failures and optional rectification config.
   * Config controls maxFailureSummaryChars, progressive escalation thresholds, etc.
   */
  priorFailures(failures: TestFailure[], config?: RectificationConfig): this {
    this.failures_ = failures;
    if (config) this.rectConfig_ = config;
    return this;
  }

  /**
   * Attempt number for progressive escalation preamble.
   * Pass undefined (or omit) to suppress escalation messaging.
   */
  attempt(n: number): this {
    this.attempt_ = n;
    return this;
  }

  testCommand(cmd: string | undefined): this {
    if (cmd) this.testCommand_ = cmd;
    return this;
  }

  scopeThreshold(n: number | undefined): this {
    if (n !== undefined) this.scopeFileThreshold_ = n;
    return this;
  }

  testScopedTemplate(tmpl: string | undefined): this {
    if (tmpl) this.testScopedTemplate_ = tmpl;
    return this;
  }

  async build(): Promise<string> {
    if (!this.story_) throw new Error("RectifierPromptBuilder: story() is required");

    return createRectificationPrompt(
      this.failures_,
      this.story_,
      this.rectConfig_,
      this.attempt_,
      this.testCommand_,
      this.scopeFileThreshold_,
      this.testScopedTemplate_,
    );
  }
}
