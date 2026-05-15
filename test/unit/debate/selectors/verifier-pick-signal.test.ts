import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeMockAgentManager, makeMockRuntime, makeNaxConfig, makeSessionManager } from "@test/helpers";
import { runPatchStep } from "../../../../src/debate/selectors/verifier-pick";

type RunPatchStepWinner = Parameters<typeof runPatchStep>[1];
type RunPatchStepRunnerUp = Parameters<typeof runPatchStep>[2];

function makeSelectorContext() {
  const config = makeNaxConfig({
    debate: {
      maxConcurrentDebaters: 2,
    },
  });
  const agentManager = makeMockAgentManager({
    runAsSessionFn: async () => ({
      output: "patched proposal output",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
    }),
  });
  const sessionManager = makeSessionManager();
  const runtime = makeMockRuntime({ agentManager, sessionManager, config });

  return {
    storyId: "US-003",
    stage: "plan",
    stageConfig: {
      enabled: true,
      resolver: { type: "synthesis" as const },
      sessionMode: "one-shot" as const,
      rounds: 1,
      selector: {
        kind: "verifier-pick" as const,
        patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 2 },
      },
    },
    config: {
      debate: config.debate,
      models: config.models,
      agent: config.agent,
    },
    proposals: [],
    critiques: [],
    workdir: "/tmp/test",
    featureName: "test-feature",
    timeoutMs: 30_000,
    agentManager,
    debaters: [],
    callContext: {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: runtime.workdir,
      agentName: "claude",
      storyId: "US-003",
      featureName: "test-feature",
    },
  } as Parameters<typeof runPatchStep>[0];
}

function makeWinner(output: string): RunPatchStepWinner {
  return {
    proposal: {
      debater: { agent: "claude", model: "fast" },
      agentName: "claude",
      output,
      cost: 0,
    },
    score: {
      citationRate: 1,
      citationDistributionScore: 1,
      failureModesCovered: 0,
      contextFilesValidRate: 1,
      total: 1,
    },
  } as RunPatchStepWinner;
}

function makeRunnerUp(output: string): RunPatchStepRunnerUp {
  return {
    proposal: {
      debater: { agent: "opencode", model: "fast" },
      agentName: "opencode",
      output,
      cost: 0,
    },
    score: {
      citationRate: 1,
      citationDistributionScore: 1,
      failureModesCovered: 0,
      contextFilesValidRate: 1,
      total: 1,
    },
  } as RunPatchStepRunnerUp;
}

afterEach(() => {
  mock.restore();
});

describe("verifier-pick patch flow", () => {
  test("runPatchStep returns a patch prompt string and does not invoke agentManager.runAsSession", async () => {
    const ctx = makeSelectorContext();
    const winner = makeWinner("Winner proposal output with AC1 and AC2");
    const runnerUp = makeRunnerUp("Runner-up proposal output with AC2 and AC3");

    const prompt = await runPatchStep(ctx, winner, runnerUp, 2);

    expect(typeof prompt).toBe("string");
    expect(prompt).toContain(winner.proposal.output);
    expect(prompt).toContain("AC3");
    expect(ctx.agentManager.runAsSession).not.toHaveBeenCalled();
  });

  test("verifier-pick.ts no longer dispatches patch turns or throws VERIFIER_PICK_NO_HANDLE", async () => {
    const source = await Bun.file("src/debate/selectors/verifier-pick.ts").text();

    expect(source).not.toContain("agentManager.runAsSession");
    expect(source).not.toContain("VERIFIER_PICK_NO_HANDLE");
    expect(source).not.toContain("await runPatchStep(");
  });
});
