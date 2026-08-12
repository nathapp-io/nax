import { describe, expect, spyOn, test } from "bun:test";
import { finalizePlanSelection } from "../../../src/debate/runner-plan-helpers";
import * as verifierPick from "../../../src/debate/selectors/verifier-pick";
import type { ScoredProposal } from "../../../src/debate/selectors/verifier-pick";
import type { SuccessfulProposal } from "../../../src/debate/session-helpers";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeProposal(overrides: Partial<SuccessfulProposal> = {}): SuccessfulProposal {
  return {
    debater: { agent: "claude" },
    agentName: "claude",
    output: "AC1: does the thing",
    cost: 0,
    ...overrides,
  };
}

function makeScored(proposal: SuccessfulProposal, total: number): ScoredProposal {
  return {
    proposal,
    score: { citationRate: 0, citationDistributionScore: 0, failureModesCovered: 0, contextFilesValidRate: 0, total },
  };
}

const selectorCtx = {} as Parameters<typeof verifierPick.runPatchStep>[0];

describe("finalizePlanSelection", () => {
  test("skips runPatchStep when patchPrompts is empty (BUG-33)", async () => {
    // Two proposals with divergent ACs so overlap < threshold and patching
    // would normally be triggered — the only thing suppressing the call is
    // the empty `patchPrompts` array (nothing to resolve into).
    const winner = makeScored(makeProposal({ output: "AC1: winner-only behavior" }), 0.9);
    const runnerUp = makeScored(makeProposal({ output: "AC2: runner-up-only behavior" }), 0.5);

    const patchStepSpy = spyOn(verifierPick, "runPatchStep");

    try {
      const result = await finalizePlanSelection(
        [winner, runnerUp],
        { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 },
        [], // patchPrompts — nothing to resolve, so patching must be skipped entirely
        ["/tmp/winner.json", "/tmp/runner-up.json"],
        [winner.proposal, runnerUp.proposal],
        selectorCtx,
      );

      expect(patchStepSpy).not.toHaveBeenCalled();
      expect(result.winnerOutput).toBe(winner.proposal.output);
      expect(result.winnerOutputPath).toBe("/tmp/winner.json");
    } finally {
      patchStepSpy.mockRestore();
    }
  });

  test("still calls runPatchStep and resolves the winner's patch prompt when patchPrompts is non-empty", async () => {
    const winner = makeScored(makeProposal({ output: "AC1: winner-only behavior" }), 0.9);
    const runnerUp = makeScored(makeProposal({ output: "AC2: runner-up-only behavior" }), 0.5);

    const winnerSelection = Promise.withResolvers<{ readonly patchPrompt?: string }>();
    const runnerUpSelection = Promise.withResolvers<{ readonly patchPrompt?: string }>();

    const result = await finalizePlanSelection(
      [winner, runnerUp],
      { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 },
      [winnerSelection, runnerUpSelection],
      ["/tmp/winner.json", "/tmp/runner-up.json"],
      [winner.proposal, runnerUp.proposal],
      selectorCtx,
    );

    const winnerResolved = await winnerSelection.promise;
    const runnerUpResolved = await runnerUpSelection.promise;

    expect(result.winnerOutput).toBe(winner.proposal.output);
    expect(winnerResolved.patchPrompt).toBeDefined();
    expect(winnerResolved.patchPrompt).toContain("AC2");
    expect(runnerUpResolved).toEqual({});
  });
});
