import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
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
  readonly buildRebutPrompt: (round: number, peerOutputs: string[]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly rebutBarriers: PromiseWithResolvers<string>[][];
  readonly signal: AbortSignal;
  readonly storyId: string;
  readonly rounds: number;
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
    const gates = [defer<void>(), defer<void>(), defer<void>()];
    const started: number[] = [];
    const proposalPromptSpy = spyOn(DebatePromptBuilder.prototype, "buildProposalPrompt");
    const callOpSpy = spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: HybridDebaterInput) => {
      started.push(input.index);
      await gates[input.index].promise;
      return {
        success: true,
        rebut: `rebut-${input.index}`,
      };
    });

    const runPromise = runHybrid(ctx, "hybrid debate prompt");
    await Promise.resolve();

    expect(callOpSpy).toHaveBeenCalledTimes(3);
    expect(started).toEqual([0, 1, 2]);
    expect(proposalPromptSpy).toHaveBeenCalledTimes(3);
    expect(proposalPromptSpy.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);

    gates[0].resolve();
    gates[1].resolve();
    gates[2].resolve();

    const result = await runPromise;

    expect(result.storyId).toBe("US-hybrid");
    expect(result.stage).toBe("run");
    expect(result.rounds).toBe(2);
    expect(result.debaters).toEqual(["claude", "opencode", "gemini"]);
    expect(result.resolverType).toBe("majority-fail-closed");
    expect(typeof result.totalCostUsd).toBe("number");
    expect(result.proposals).toHaveLength(3);
    expect(result.rebuttals).toBeDefined();
  });

  test("rejects when any callOp invocation throws or returns success false", async () => {
    const ctx = makeHybridCtx();
    const callOpSpy = spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: HybridDebaterInput) => {
      if (input.index === 0) {
        return { success: true, rebut: "rebut-0" };
      }
      if (input.index === 1) {
        throw new Error("boom");
      }
      return { success: false, rebut: "rebut-2" };
    });

    const runPromise = runHybrid(ctx, "hybrid debate prompt");

    await expect(runPromise).rejects.toBeDefined();
    expect(callOpSpy).toHaveBeenCalledTimes(3);
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
