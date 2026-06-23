/**
 * Test Presence Gate Operation
 *
 * Runs AFTER the implementer for single-session test-authoring strategies
 * (tdd-simple, test-after). Detects whether the implementer authored at least
 * one test file by re-running the same greenfield check used before the implementer.
 *
 * A failure (success=false + pauseReason="no-tests-authored") means the implementer
 * produced no test files — the orchestrator will re-run the implementer with an
 * explicit directive to author tests, instead of relying on adversarial review
 * to notice the gap after the fact.
 *
 * No LLM session is opened — this is a pure deterministic filesystem check.
 */

import { pickSelector } from "../config";
import { isGreenfieldStory } from "../context/greenfield";
import type { UserStory } from "../prd";
import type { ResolvedTestPatterns } from "../test-runners";
import type { CallContext, DeterministicOperation } from "./types";

/**
 * Input for the test-presence gate — self-contained, does not consume prior outputs.
 */
export interface TestPresenceGateInput {
  readonly story: UserStory;
  readonly workdir: string;
  readonly resolvedTestPatterns: ResolvedTestPatterns;
}

/**
 * Output from the test-presence gate.
 * success=false + pauseReason="no-tests-authored" signals the orchestrator to
 * re-run the implementer with an explicit test-authoring directive.
 */
export interface TestPresenceGateOutput {
  readonly success: boolean;
  readonly hasTests: boolean;
  readonly pauseReason?: string;
}

const testPresenceGateConfigSelector = pickSelector("test-presence-gate", "execution");
type TestPresenceGateConfig = ReturnType<typeof testPresenceGateConfigSelector.select>;

/**
 * Test Presence Gate Operation — detects if the implementer authored test files via
 * filesystem scan. Reuses isGreenfieldStory: if the package is still "greenfield"
 * (no test files matching resolved patterns) after the implementer ran, the
 * implementer failed to author tests.
 *
 * success=false + pauseReason="no-tests-authored" triggers escalation so the
 * implementer is retried with an explicit instruction to write tests.
 *
 * No LLM session is opened — pure filesystem check.
 */
export const testPresenceGateOp: DeterministicOperation<
  TestPresenceGateInput,
  TestPresenceGateOutput,
  TestPresenceGateConfig
> = {
  kind: "deterministic",
  name: "test-presence-gate",
  stage: "verify",
  config: testPresenceGateConfigSelector,
  async execute(input: TestPresenceGateInput, _ctx: CallContext): Promise<TestPresenceGateOutput> {
    // isGreenfieldStory takes raw glob strings (readonly string[]), not ResolvedTestPatterns
    const globs: readonly string[] = input.resolvedTestPatterns.globs;
    // isGreenfieldStory catches its own errors and returns false (not greenfield) on failure.
    const stillGreenfield = await isGreenfieldStory(input.story, input.workdir, globs);
    if (stillGreenfield) {
      return { success: false, hasTests: false, pauseReason: "no-tests-authored" };
    }
    return { success: true, hasTests: true };
  },
};
