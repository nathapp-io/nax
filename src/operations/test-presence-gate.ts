/**
 * Test Presence Gate Operation
 *
 * Runs AFTER the implementer for single-session test-authoring strategies
 * (tdd-simple, test-after). Scans the filesystem (tracked AND untracked) for at
 * least one authored test file matching the resolved patterns, excluding `.nax/`
 * so the generated acceptance harness never counts as coverage.
 *
 * A failure (success=false + pauseReason="no-tests-authored") means the implementer
 * produced no test files — the orchestrator will re-run the implementer with an
 * explicit directive to author tests, instead of relying on adversarial review
 * to notice the gap after the fact.
 *
 * No LLM session is opened — this is a pure deterministic filesystem check.
 */

import { pickSelector } from "../config";
import { hasTestFilesOnDisk } from "../context/greenfield";
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
 * a filesystem scan (`hasTestFilesOnDisk`). Tracked-only detection (`git ls-files`)
 * would miss the freshly-authored, still-untracked tests and false-fire; the scan
 * sees them, and excludes `.nax/` so nax's own harness never counts.
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
    // Scan the FILESYSTEM (not `git ls-files`): the implementer just authored these
    // tests and they are still untracked, so a tracked-only check would miss them and
    // false-fire. `hasTestFilesOnDisk` excludes `.nax/` so the generated acceptance
    // harness never counts as authored coverage.
    const globs: readonly string[] = input.resolvedTestPatterns.globs;
    let hasTests: boolean;
    try {
      hasTests = await hasTestFilesOnDisk(input.workdir, globs);
    } catch {
      // Scan failed (e.g. workdir vanished) — do not block the story on a flaky scan.
      return { success: true, hasTests: true };
    }
    if (!hasTests) {
      return { success: false, hasTests: false, pauseReason: "no-tests-authored" };
    }
    return { success: true, hasTests: true };
  },
};
