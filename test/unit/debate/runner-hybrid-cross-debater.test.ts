/**
 * Cross-debater in-round visibility test for runHybrid.
 *
 * Regression guard: this test was added after discovering that runner-hybrid.ts
 * used statefulDebaterOp + local per-call barriers, which meant debaters never
 * shared proposal outputs via a common barrier — they only saw outputs via the
 * coordinator's sequential prompt construction. The correct fix is to dispatch
 * hybridDebaterOp with shared N-element barriers.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeNaxConfig, makeMockAgentManager, makeSessionManager } from "@test/helpers";
import { _debateSessionDeps, runHybrid } from "@/debate";
import type { HybridCtx, DebateStageConfig } from "@/debate";
import type { DebateHybridInput } from "@/operations/debate-hybrid";
import * as callModule from "@/operations";
import type { RunOperation } from "@/operations/types";

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "stateful",
    mode: "hybrid",
    rounds: 1,
    timeoutSeconds: 60,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "fast" },
    ],
    ...overrides,
  };
}

function makeHybridCtx(stageConfigOverrides: Partial<DebateStageConfig> = {}): HybridCtx {
  const fullConfig = makeNaxConfig({ debate: { maxConcurrentDebaters: 3 } });
  const agentManager = makeMockAgentManager();
  const sessionManager = makeSessionManager({
    openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
    closeSession: mock(async () => {}),
    nameFor: mock((req) => req.role ?? ""),
  });

  return {
    storyId: "US-cross-debater",
    stage: "run",
    stageConfig: makeStageConfig(stageConfigOverrides),
    config: fullConfig,
    workdir: "/tmp/work",
    featureName: "feat-hybrid",
    timeoutSeconds: 60,
    callContext: {
      runtime: {
        agentManager,
        sessionManager,
        configLoader: { current: () => fullConfig, select: (_sel: unknown) => fullConfig },
        packages: { resolve: () => ({ config: fullConfig, select: (_sel: unknown) => fullConfig }) },
        signal: undefined,
      } as never,
      packageView: { config: fullConfig, select: (_sel: unknown) => fullConfig } as never,
      packageDir: "/tmp/work",
      agentName: "claude",
      storyId: "US-cross-debater",
      featureName: "feat-hybrid",
    },
    agentManager,
    sessionManager,
    abortSignal: new AbortController().signal,
  };
}

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }));
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

describe("runHybrid — cross-debater in-round visibility", () => {
  test("dispatches hybridDebaterOp (not statefulDebaterOp) for every debater", async () => {
    const ctx = makeHybridCtx();
    const opNames: string[] = [];

    spyOn(callModule, "callOp").mockImplementation(
      async (_callCtx, op: RunOperation<DebateHybridInput, unknown, unknown>, input: DebateHybridInput) => {
        opNames.push(op.name);
        input.proposalBarriers[input.index]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      },
    );

    await runHybrid(ctx, "debate prompt");

    // Both debaters must use the hybrid op — not the stateful op
    expect(opNames).toHaveLength(2);
    for (const name of opNames) {
      expect(name).toBe("debate-hybrid");
    }
  });

  test("shared proposalBarriers array has one slot per debater so peers can synchronize", async () => {
    const ctx = makeHybridCtx();
    const capturedBarrierLengths: number[] = [];

    spyOn(callModule, "callOp").mockImplementation(
      async (_callCtx, _op, input: DebateHybridInput) => {
        capturedBarrierLengths.push(input.proposalBarriers.length);
        input.proposalBarriers[input.index]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      },
    );

    await runHybrid(ctx, "debate prompt");

    // Each debater must receive a barrier array with N slots (one per debater).
    // The broken implementation passes a fresh 1-element array per call.
    expect(capturedBarrierLengths).toHaveLength(2);
    for (const len of capturedBarrierLengths) {
      expect(len).toBe(2); // 2 debaters → 2-slot shared barrier
    }
  });

  test("debater A's buildRebutPrompt receives debater B's proposal (proves in-round peer visibility)", async () => {
    const ctx = makeHybridCtx();
    const capturedBuildRebutPrompts: Array<DebateHybridInput["buildRebutPrompt"]> = [];

    spyOn(callModule, "callOp").mockImplementation(
      async (_callCtx, _op, input: DebateHybridInput) => {
        capturedBuildRebutPrompts.push(input.buildRebutPrompt);
        input.proposalBarriers[input.index]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      },
    );

    await runHybrid(ctx, "debate prompt");

    expect(capturedBuildRebutPrompts).toHaveLength(2);

    // Simulate what hybridDebaterOp hopBody does: call buildRebutPrompt for debater A
    // with peerOutputs containing BOTH debaters' proposals (A's and B's from the same round).
    const buildRebutPromptForA = capturedBuildRebutPrompts[0];
    const peerOutputs = ["A-proposal", "B-proposal"];
    const prompt = buildRebutPromptForA(1, peerOutputs, []);

    // Debater A's rebuttal prompt must include debater B's proposal
    expect(prompt).toContain("B-proposal");
  });

  test("rebutBarriers array has one slot per debater and one array per round", async () => {
    const ctx = makeHybridCtx({ rounds: 2 });
    const capturedRebutBarrierShapes: Array<{ rounds: number; slots: number }> = [];

    spyOn(callModule, "callOp").mockImplementation(
      async (_callCtx, _op, input: DebateHybridInput) => {
        capturedRebutBarrierShapes.push({
          rounds: input.rebutBarriers.length,
          slots: input.rebutBarriers[0]?.length ?? 0,
        });
        input.proposalBarriers[input.index]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      },
    );

    await runHybrid(ctx, "debate prompt");

    expect(capturedRebutBarrierShapes).toHaveLength(2);
    for (const shape of capturedRebutBarrierShapes) {
      expect(shape.rounds).toBe(2); // 2 rebuttal rounds
      expect(shape.slots).toBe(2); // 2 debaters
    }
  });
});
