import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import { DebatePromptBuilder } from "@/prompts";
import * as callModule from "@/operations";
import { runHybrid } from "../../../src/debate/runner-hybrid";
import type { DebateStageConfig } from "@/debate/types";
import type { HybridCtx } from "@/debate/runner-hybrid";

interface PromiseWithResolvers<T> {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface HybridDebaterInput {
  readonly debater: { readonly agent: string; readonly model?: string };
  readonly index: number;
  readonly proposePrompt: string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
}

function defer<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  const agentManager = makeMockAgentManager({
    runAsSessionFn: async (agentName) => ({
      output: `proposal-${agentName}`,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
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
          select: (_sel: unknown) => fullConfig,
        },
        packages: {
          resolve: () => ({ config: fullConfig, select: (_sel: unknown) => fullConfig }),
        },
        signal: undefined,
      },
      packageView: { config: fullConfig, select: (_sel: unknown) => fullConfig },
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
  test("launches one callOp per debater, builds proposal prompts through DebatePromptBuilder, and returns the expected DebateResult shape", async () => {
    const ctx = makeHybridCtx();
    const proposalPromptSpy = spyOn(DebatePromptBuilder.prototype, "buildProposalPrompt");
    const callOpSpy = spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: HybridDebaterInput) => {
      if (!input.proposePrompt.includes("## Proposals")) {
        input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
        return {
          success: true,
          rebut: `proposal-${input.index}`,
        };
      }
      return {
        success: true,
        rebut: input.proposePrompt.includes("## Previous Rebuttals") ? `rebut-2-${input.index}` : `rebut-1-${input.index}`,
      };
    });
    const result = await runHybrid(ctx, "hybrid debate prompt");

    expect(result.storyId).toBe("US-hybrid");
    expect(result.stage).toBe("run");
    expect(result.rounds).toBe(2);
    expect(result.debaters).toEqual(["claude", "opencode", "gemini"]);
    expect(result.resolverType).toBe("majority-fail-closed");
    expect(typeof result.totalCostUsd).toBe("number");
    expect(callOpSpy).toHaveBeenCalledTimes(9);
    expect(proposalPromptSpy).toHaveBeenCalledTimes(3);
    expect(proposalPromptSpy.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
    expect(result.proposals).toHaveLength(3);
    expect(result.proposals.map((proposal) => proposal.output)).toEqual(["proposal-0", "proposal-1", "proposal-2"]);
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
    const callOpSpy = spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: HybridDebaterInput) => {
      if (input.index === 0) {
        if (!input.proposePrompt.includes("## Proposals")) {
          input.proposalBarriers[0]?.resolve("proposal-0");
          return { success: true, rebut: "proposal-0" };
        }
        return { success: true, rebut: input.proposePrompt.includes("## Previous Rebuttals") ? "rebut-2-0" : "rebut-1-0" };
      }
      if (input.index === 1) {
        throw new Error("boom");
      }
      return { success: false, rebut: "rebut-2" };
    });

    const result = await runHybrid(ctx, "hybrid debate prompt");

    expect(result.outcome).toBe("passed");
    expect(result.proposals).toEqual([{ debater: { agent: "claude", model: "fast" }, output: "proposal-0" }]);
    expect(callOpSpy).toHaveBeenCalledTimes(3);
  });

  test("propagates CALL_OP_ABORTED instead of degrading an abort into a normal debate result", async () => {
    const controller = new AbortController();
    const ctx = makeHybridCtx();
    ctx.abortSignal = controller.signal;
    ctx.callContext.runtime.signal = controller.signal;

    spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: HybridDebaterInput) => {
      if (input.index === 0) {
        input.proposalBarriers[0]?.resolve("proposal-0");
        return { success: true, rebut: "proposal-0" };
      }
      controller.abort();
      throw new NaxError("aborted", "CALL_OP_ABORTED", { storyId: "US-hybrid" });
    });

    await expect(runHybrid(ctx, "hybrid debate prompt")).rejects.toMatchObject({ code: "CALL_OP_ABORTED" });
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
