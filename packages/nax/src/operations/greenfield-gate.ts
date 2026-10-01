/**
 * Greenfield Gate Operation
 *
 * Detects whether a story is greenfield (no existing test files in workdir)
 * using a deterministic filesystem scan — no LLM session required.
 * Part of US-005 AC#2: Promotes greenfield gate to first-class orchestrator phase.
 */

import { pickSelector } from "../config";
import { hasTestFilesOnDisk } from "../context/greenfield";
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
 * Greenfield Gate Operation — runs AFTER the test-writer and detects whether tests
 * now exist via a filesystem scan (`hasTestFilesOnDisk`). Tracked-only detection
 * (`git ls-files`) would miss the test-writer's freshly-authored, still-untracked
 * tests and false-fire `greenfield-no-tests`; the scan sees them and excludes `.nax/`
 * so nax's own acceptance harness never counts.
 *
 * When no tests exist, sets success=false + pauseReason="greenfield-no-tests".
 * No LLM session is opened — this is a pure deterministic filesystem check.
 */
export const greenfieldGateOp: DeterministicOperation<GreenfieldGateInput, GreenfieldGateOutput, GreenfieldGateConfig> =
  {
    kind: "deterministic",
    name: "greenfield-gate",
    stage: "verify",
    config: greenfieldGateConfigSelector,
    async execute(input: GreenfieldGateInput, _ctx: CallContext): Promise<GreenfieldGateOutput> {
      // Scan the FILESYSTEM (not `git ls-files`): the test-writer's freshly-authored
      // tests are still untracked when this gate runs, so a tracked-only check would
      // miss them and falsely report greenfield. hasTestFilesOnDisk also excludes
      // `.nax/` so the generated acceptance harness never counts.
      let hasTests: boolean;
      try {
        hasTests = await hasTestFilesOnDisk(input.workdir, input.resolvedTestPatterns);
      } catch {
        // Scan failed (e.g. workdir vanished) — do not pause the story on a flaky scan.
        return { success: true, hasPreExistingTests: true };
      }
      if (!hasTests) {
        return { success: false, hasPreExistingTests: false, pauseReason: "greenfield-no-tests" };
      }
      return { success: true, hasPreExistingTests: true };
    },
  };
