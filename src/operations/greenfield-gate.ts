/**
 * Greenfield Gate Operation
 *
 * Detects whether a story is greenfield (no existing test files in workdir).
 * Part of US-005: Promotes greenfield gate to first-class orchestrator phase.
 */

import { pickSelector } from "../config";
import type { UserStory } from "../prd";
import type { ResolvedTestPatterns } from "../test-runners";
import type { RunOperation } from "./types";

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
 */
export interface GreenfieldGateOutput {
  readonly success: boolean;
  readonly isGreenfield: boolean;
}

const greenfieldGateConfigSelector = pickSelector("greenfield-gate", "execution");
type GreenfieldGateConfig = ReturnType<typeof greenfieldGateConfigSelector.select>;

/**
 * Greenfield Gate Operation — detects if story is greenfield (no test files).
 * When true, TDD test-writer phase is skipped to prevent empty test file creation (BUG-010).
 */
export const greenfieldGateOp: RunOperation<GreenfieldGateInput, GreenfieldGateOutput, GreenfieldGateConfig> = {
  kind: "run",
  name: "greenfield-gate",
  stage: "run",
  config: greenfieldGateConfigSelector,
  session: { role: "main", lifetime: "fresh" },
  build: () => ({
    role: {
      id: "greenfield",
      content: "Detect if project is greenfield (has no test files)",
      overridable: false,
    },
    task: { id: "detect", content: "Scan project for test files", overridable: false },
  }),
  parse: (): GreenfieldGateOutput => {
    // Stub: will be implemented in next phase
    return { success: false, isGreenfield: false };
  },
};
