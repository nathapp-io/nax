/**
 * preIterationTierCheck — dry run must never persist (nax#1809).
 *
 * A `--dry-run` run over a partially-attempted PRD reaches the tier pre-check
 * (unified-executor.ts dispatch sites run before runIteration's dry-run
 * short-circuit), and a story past its tier budget would otherwise flow into
 * the escalate/fail writes — savePRD, progress.txt, story:failed events. The
 * check reads `runtime.dryRun` and returns the same clean passthrough it
 * already returns at attempts === 0: never persist under a dry run.
 *
 * Mirrors the sparse per-topic layout of this directory rather than growing
 * tier-escalation.test.ts (file-size ratchet).
 */

import { describe, expect, spyOn, test } from "bun:test";
import { makeMockRuntime, makeNaxConfig, makePRD, makeStory } from "@test/helpers";

describe("preIterationTierCheck — dry run never persists escalation (nax#1809)", () => {
  test("returns a clean passthrough instead of savePRD when budget is exhausted", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePRD;
    const savePRDSpy = spyOn(_tierEscalationDeps, "savePRD").mockImplementation(() => Promise.resolve());

    try {
      const story = makeStory({
        id: "US-pre-iter-dryrun-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        // attempts === tierCfg.attempts (1) → budget exhausted → would escalate
        attempts: 1,
        routing: { complexity: "simple", reasoning: "", modelTier: "fast", testStrategy: "test-after" },
      });

      const prd = makePRD({
        project: "test",
        feature: "f",
        branchName: "b",
        userStories: [story],
      });

      const config = makeNaxConfig({
        autoMode: {
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", attempts: 1 },
              { tier: "balanced", attempts: 2 },
            ],
          },
        },
        routing: { llm: { mode: "per-story" }, strategy: "keyword" },
        models: { fast: { model: "test-fast", provider: "test" }, balanced: { model: "test-bal", provider: "test" } },
      });

      const result = await preIterationTierCheck(
        story,
        { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
        config,
        prd,
        "/tmp/test-prd-dryrun.json",
        undefined,
        { hooks: {} },
        "f",
        0,
        "/tmp",
        makeMockRuntime({ workdir: "/tmp", dryRun: true }),
      );

      expect(savePRDSpy).not.toHaveBeenCalled();
      expect(result.shouldSkipIteration).toBe(false);
      expect(result.prdDirty).toBe(false);
      expect(result.prd).toBe(prd);
    } finally {
      savePRDSpy.mockRestore();
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });
});
