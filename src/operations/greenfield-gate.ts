/**
 * Greenfield Gate Operation
 *
 * Detects whether a story is greenfield (no existing test files in workdir)
 * using a deterministic filesystem scan — no LLM session required.
 * Part of US-005 AC#2: Promotes greenfield gate to first-class orchestrator phase.
 */

import { pickSelector } from "../config";
import { isGreenfieldStory } from "../context/greenfield";
import type { UserStory } from "../prd";
import type { ResolvedTestPatterns } from "../test-runners";
import type { CallContext, DeterministicOperation } from "./types";

/**
 * Input for the greenfield gate — self-contained, does not consume prior outputs.
 */
export interface GreenfieldGateInput {
  readonly story: UserStory;
  readonly workdir: string;
  readonly resolvedTestPatterns: ResolvedTestPatterns;
}

/**
 * Output from the greenfield gate.
 * success=false + pauseReason="greenfield-no-tests" signals the orchestrator to pause.
 */
export interface GreenfieldGateOutput {
  readonly success: boolean;
  readonly hasPreExistingTests: boolean;
  readonly pauseReason?: string;
}

const greenfieldGateConfigSelector = pickSelector("greenfield-gate", "execution");
type GreenfieldGateConfig = ReturnType<typeof greenfieldGateConfigSelector.select>;

/**
 * Greenfield Gate Operation — detects if story is greenfield (no test files) via
 * filesystem scan. When greenfield, sets success=false + pauseReason="greenfield-no-tests"
 * so the orchestrator pause handler skips TDD test-writer (BUG-010).
 *
 * No LLM session is opened — this is a pure filesystem check.
 */
export const greenfieldGateOp: DeterministicOperation<GreenfieldGateInput, GreenfieldGateOutput, GreenfieldGateConfig> =
  {
    kind: "deterministic",
    name: "greenfield-gate",
    stage: "run",
    config: greenfieldGateConfigSelector,
    async execute(input: GreenfieldGateInput, _ctx: CallContext): Promise<GreenfieldGateOutput> {
      // isGreenfieldStory takes raw glob strings (readonly string[]), not ResolvedTestPatterns
      const globs: readonly string[] = input.resolvedTestPatterns.globs;
      // isGreenfieldStory catches its own errors and returns false (not greenfield) on failure.
      const isGreenfield = await isGreenfieldStory(input.story, input.workdir, globs);
      if (isGreenfield) {
        return { success: false, hasPreExistingTests: false, pauseReason: "greenfield-no-tests" };
      }
      return { success: true, hasPreExistingTests: true };
    },
  };
