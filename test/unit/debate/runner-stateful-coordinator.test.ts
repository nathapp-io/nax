import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager } from "@test/helpers";
import * as callModule from "@/operations/call";
import { runStateful } from "../../../src/debate/runner-stateful";

interface PromiseWithResolvers<T> {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface StatefulDebaterInput {
  readonly debater: { readonly agent: string; readonly model?: string };
  readonly index: number;
  readonly proposePrompt: string;
  readonly buildRebutPrompt: (peerProposals: string[]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly signal: AbortSignal;
  readonly storyId: string;
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

function makeRunStatefulCtx(overrides: Partial<Record<string, unknown>> = {}) {
  const fullConfig = makeNaxConfig({
    debate: {
      maxConcurrentDebaters: 2,
    },
  });
  const sliceConfig = makeNaxConfig({
    debate: {
      maxConcurrentDebaters: 99,
    },
  });
  const agentManager = makeMockAgentManager({
    runAsSessionFn: async (_agentName, _handle, prompt) => ({
      output: prompt.includes("rebut") ? `rebut-from-${prompt}` : `proposal-from-${prompt}`,
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
      estimatedCostUsd: 0,
      internalRoundTrips: 1,
    }),
  });
  const sessionManager = makeSessionManager({
    openSession: mock(async (name: string) => ({ id: name, agentName: name })),
    closeSession: mock(async () => {}),
    nameFor: mock(() => "nax-stateful"),
    getLiveHandle: mock(() => undefined),
  });
  return {
    storyId: "US-855",
    stage: "review",
    stageConfig: {
      enabled: true,
      resolver: { type: "majority-fail-closed" },
      sessionMode: "stateful",
      mode: "panel",
      rounds: 1,
      debaters: [
        { agent: "claude", model: "fast" },
        { agent: "opencode", model: "balanced" },
        { agent: "gemini", model: "powerful" },
      ],
    },
    config: sliceConfig.debate,
    workdir: "/tmp/work",
    featureName: "feat-stateful",
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
      storyId: "US-855",
      featureName: "feat-stateful",
    },
    agentManager,
    sessionManager,
    ...overrides,
  } as Parameters<typeof runStateful>[0];
}

function makeResultingCallOpMock() {
  return spyOn(callModule, "callOp").mockImplementation(async (_ctx, _op, input: StatefulDebaterInput) => {
    input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
    const proposals = await Promise.all(input.proposalBarriers.map((barrier) => barrier.promise));
    return {
      success: true,
      rebut: `rebut-${input.index}:${proposals.join("|")}`,
    };
  });
}

afterEach(() => {
  mock.restore();
});

describe("runStateful coordinator", () => {
  test("launches one callOp per resolved debater and caps in-flight work using runtime.configLoader.current().debate.maxConcurrentDebaters", async () => {
    const callStarts: number[] = [];
    const permits = [defer<void>(), defer<void>(), defer<void>()];
    const callOpSpy = spyOn(callModule, "callOp").mockImplementation(async (_ctx, _op, input: StatefulDebaterInput) => {
      callStarts.push(input.index);
      input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
      await permits[input.index].promise;
      return { success: true, rebut: `rebut-${input.index}` };
    });

    const runPromise = runStateful(makeRunStatefulCtx(), "stateful debate prompt");
    await Promise.resolve();

    expect(callOpSpy).toHaveBeenCalledTimes(2);
    expect(callStarts).toEqual([0, 1]);

    permits[0].resolve();
    await Promise.resolve();

    expect(callStarts).toContain(2);

    permits[1].resolve();
    permits[2].resolve();
    await runPromise;
  });

  test("returns proposals, rebuttals, debaters, outcome, and totalCostUsd from the debater op results", async () => {
    const callOpSpy = makeResultingCallOpMock();
    const result = await runStateful(makeRunStatefulCtx(), "stateful debate prompt");

    expect(callOpSpy).toHaveBeenCalledTimes(3);
    expect(result.debaters).toEqual(["claude", "opencode", "gemini"]);
    expect(result.outcome).toBe("passed");
    expect(result.totalCostUsd).toBe(0);
    expect(result.proposals).toEqual([
      { debater: { agent: "claude", model: "fast" }, output: "proposal-0" },
      { debater: { agent: "opencode", model: "balanced" }, output: "proposal-1" },
      { debater: { agent: "gemini", model: "powerful" }, output: "proposal-2" },
    ]);
    expect(result.rebuttals).toEqual([
      { debater: { agent: "claude", model: "fast" }, round: 1, output: "rebut-0:proposal-0|proposal-1|proposal-2" },
      { debater: { agent: "opencode", model: "balanced" }, round: 1, output: "rebut-1:proposal-0|proposal-1|proposal-2" },
      { debater: { agent: "gemini", model: "powerful" }, round: 1, output: "rebut-2:proposal-0|proposal-1|proposal-2" },
    ]);
  });

  test("runner-stateful.ts no longer references the old session-manager and model-resolution escape hatches", async () => {
    const source = await Bun.file("src/debate/runner-stateful.ts").text();
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
