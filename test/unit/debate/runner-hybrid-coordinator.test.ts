import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ConfigSelector } from "@/config";
import { runHybrid } from "@/debate/runner-hybrid";
import { _hybridDeps } from "@/debate/runner-hybrid";
import type { HybridCtx } from "@/debate/runner-hybrid";
import type { DebateStageConfig } from "@/debate/types";
import { NaxError } from "@/errors";
import { DebatePromptBuilder } from "@/prompts";
import type { PackageView } from "@/runtime";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager, withDepsRestore } from "@test/helpers";

function installCallOp(impl: typeof _hybridDeps.callOp) {
  const spy = mock(impl);
  _hybridDeps.callOp = spy;
  return spy;
}

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "stateful",
    mode: "hybrid",
    rounds: 2,
    timeoutSeconds: 60,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "fast" },
      { agent: "gemini", model: "fast" },
    ],
    ...overrides,
  };
}

function makeHybridCtx(stageConfigOverrides: Partial<DebateStageConfig> = {}): HybridCtx {
  const fullConfig = makeNaxConfig({
    debate: {
      maxConcurrentDebaters: 3,
    },
  });
  const testView: PackageView = {
    packageDir: "/tmp/work",
    relativeFromRoot: "",
    repoRoot: "/tmp/work",
    hasOverride: false,
    config: fullConfig,
    select: (sel) => sel.select(fullConfig),
  };
  const agentManager = makeMockAgentManager({
    runAsSessionFn: async (agentName) => ({
      output: `proposal-${agentName}`,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
    }),
  });
  const sessionManager = makeSessionManager({
    openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
    closeSession: mock(async () => {}),
    nameFor: mock((req) => req.role ?? ""),
  });

  return {
    storyId: "US-hybrid",
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
        configLoader: {
          current: () => fullConfig,
          select: <C>(sel: ConfigSelector<C>) => sel.select(fullConfig),
        },
        packages: {
          resolve: () => testView,
        },
        signal: undefined,
      },
      packageView: testView,
      packageDir: "/tmp/work",
      agentName: "claude",
      storyId: "US-hybrid",
      featureName: "feat-hybrid",
    },
    agentManager,
    sessionManager,
    abortSignal: new AbortController().signal,
  };
}

afterEach(() => {
  mock.restore();
});

describe("runHybrid coordinator", () => {
  withDepsRestore(_hybridDeps);

  test("launches one callOp per debater, builds proposal prompts through DebatePromptBuilder, and returns the expected DebateResult shape", async () => {
    const ctx = makeHybridCtx(); // 3 debaters, rounds=2
    const proposalPromptSpy = spyOn(DebatePromptBuilder.prototype, "buildProposalPrompt");
    const callOpSpy = installCallOp(async (_callCtx, _op, input) => {
      // Each callOp simulates hybridDebaterOp: resolve shared proposal + rebuttal barriers
      input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
      for (let r = 0; r < input.rounds; r++) {
        input.rebutBarriers[r][input.index].resolve(`rebut-${r + 1}-${input.index}`);
      }
      return { success: true, rebut: `rebut-${input.rounds}-${input.index}` };
    });
    const result = await runHybrid(ctx, "hybrid debate prompt");

    expect(result.storyId).toBe("US-hybrid");
    expect(result.stage).toBe("run");
    expect(result.rounds).toBe(2);
    expect(result.debaters).toEqual(["claude", "opencode", "gemini"]);
    expect(result.resolverType).toBe("majority-fail-closed");
    expect(typeof result.totalCostUsd).toBe("number");
    // One callOp per debater (op's hopBody handles all rounds internally)
    expect(callOpSpy).toHaveBeenCalledTimes(3);
    expect(proposalPromptSpy).toHaveBeenCalledTimes(3);
    expect(proposalPromptSpy.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
    expect(result.proposals).toHaveLength(3);
    expect(result.proposals.map((proposal) => proposal.output)).toEqual(["rebut-2-0", "rebut-2-1", "rebut-2-2"]);
    expect(result.rebuttals).toEqual([
      { debater: { agent: "claude", model: "fast" }, round: 1, output: "rebut-1-0" },
      { debater: { agent: "opencode", model: "fast" }, round: 1, output: "rebut-1-1" },
      { debater: { agent: "gemini", model: "fast" }, round: 1, output: "rebut-1-2" },
      { debater: { agent: "claude", model: "fast" }, round: 2, output: "rebut-2-0" },
      { debater: { agent: "opencode", model: "fast" }, round: 2, output: "rebut-2-1" },
      { debater: { agent: "gemini", model: "fast" }, round: 2, output: "rebut-2-2" },
    ]);
  });

  test("falls back to a failed result instead of throwing when debaters fail", async () => {
    const ctx = makeHybridCtx();
    installCallOp(async (_callCtx, _op, input) => {
      if (input.index === 0) {
        input.proposalBarriers[input.index].resolve("proposal-0");
        for (let r = 0; r < input.rounds; r++) {
          input.rebutBarriers[r][input.index].resolve(`rebut-${r + 1}-0`);
        }
        return { success: true, rebut: "proposal-0" };
      }
      throw new Error("boom");
    });

    const result = await runHybrid(ctx, "hybrid debate prompt");

    expect(result.outcome).toBe("passed");
    expect(result.proposals).toEqual([{ debater: { agent: "claude", model: "fast" }, output: "proposal-0" }]);
  });

  test("propagates CALL_OP_ABORTED instead of degrading an abort into a normal debate result", async () => {
    const controller = new AbortController();
    const ctx = makeHybridCtx();
    ctx.abortSignal = controller.signal;
    ctx.callContext.runtime.signal = controller.signal;

    installCallOp(async (_callCtx, _op, input) => {
      if (input.index === 0) {
        input.proposalBarriers[input.index].resolve("proposal-0");
        return { success: true, rebut: "proposal-0" };
      }
      controller.abort();
      throw new NaxError("aborted", "CALL_OP_ABORTED", { storyId: "US-hybrid" });
    });

    await expect(runHybrid(ctx, "hybrid debate prompt")).rejects.toMatchObject({ code: "CALL_OP_ABORTED" });
  });

  test("when a debater callOp returns success:false without resolving its barriers, waiting peers do not deadlock", async () => {
    // Regression guard: buildHopCallback converts a runAsSession throw into a failed
    // AgentResult (success:false), so callOp returns normally. The coordinator must
    // still reject unresolved barriers so the other debater's hopBody can proceed.
    const ctx = makeHybridCtx(); // 3 debaters, rounds=2
    installCallOp(async (_callCtx, _op, input) => {
      if (input.index === 1) {
        // Simulate callOp returning success:false without resolving barriers
        // (mirrors what happens when hopBody throws before resolving proposalBarriers)
        return { success: false, rebut: 'Agent "opencode" failed: boom' };
      }
      input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
      for (let r = 0; r < input.rounds; r++) {
        input.rebutBarriers[r][input.index].resolve(`rebut-${r + 1}-${input.index}`);
      }
      return { success: true, rebut: `rebut-${input.rounds}-${input.index}` };
    });

    const result = await runHybrid(ctx, "hybrid debate prompt");

    // Only debaters 0 and 2 succeeded — single-debater fallback or 2-debater result
    expect(result).toBeDefined();
    expect(result.storyId).toBe("US-hybrid");
  });

  test("runner-hybrid.ts no longer references the old session-manager and model-resolution escape hatches", async () => {
    const source = await Bun.file("src/debate/runner-hybrid.ts").text();
    const forbiddenSnippets = [
      "sessionManager.openSession",
      "sessionManager.closeSession",
      "agentManager.runAsSession",
      "resolveModelDefForDebater",
      "ctx.config.models",
      'DebateConfig["models"]',
    ];

    for (const snippet of forbiddenSnippets) {
      expect(source).not.toContain(snippet);
    }
  });
});
