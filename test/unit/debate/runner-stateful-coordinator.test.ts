import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runStateful } from "@/debate/runner-stateful";
import * as callModule from "@/operations";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager } from "@test/helpers";

interface PromiseWithResolvers<T> {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface StatefulDebaterInput {
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
    if (!input.proposePrompt.includes("Other Agents' Proposals")) {
      input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
      return {
        success: true,
        rebut: `proposal-${input.index}`,
      };
    }
    const proposals = ["proposal-0", "proposal-1", "proposal-2"];
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
      input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
      await permits[input.index].promise;
      return { success: true, rebut: `rebut-${input.index}` };
    });

    const runPromise = runStateful(makeRunStatefulCtx(), "stateful debate prompt");
    await Promise.resolve();

    expect(callOpSpy).toHaveBeenCalledTimes(2);
    expect(callStarts).toEqual([0, 1]);

    permits[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(callStarts).toContain(2);

    permits[1].resolve();
    permits[2].resolve();
    await runPromise;
  });

  test("returns proposals, rebuttals, debaters, outcome, and totalCostUsd from the debater op results", async () => {
    const callOpSpy = makeResultingCallOpMock();
    const baseCtx = makeRunStatefulCtx();
    const result = await runStateful(
      {
        ...baseCtx,
        stageConfig: {
          ...baseCtx.stageConfig,
          rounds: 2,
        },
      },
      "stateful debate prompt",
    );

    expect(callOpSpy).toHaveBeenCalledTimes(6);
    expect(result.debaters).toEqual(["claude", "opencode", "gemini"]);
    expect(result.outcome).toBe("failed");
    expect(result.totalCostUsd).toBe(0);
    expect(result.proposals).toEqual([
      { debater: { agent: "claude", model: "fast" }, output: "proposal-0" },
      { debater: { agent: "opencode", model: "balanced" }, output: "proposal-1" },
      { debater: { agent: "gemini", model: "powerful" }, output: "proposal-2" },
    ]);
    expect(result.rebuttals).toEqual([
      { debater: { agent: "claude", model: "fast" }, round: 1, output: "rebut-0:proposal-0|proposal-1|proposal-2" },
      {
        debater: { agent: "opencode", model: "balanced" },
        round: 1,
        output: "rebut-1:proposal-0|proposal-1|proposal-2",
      },
      { debater: { agent: "gemini", model: "powerful" }, round: 1, output: "rebut-2:proposal-0|proposal-1|proposal-2" },
    ]);
  });

  test("when one callOp throws, the runner returns without deadlocking", async () => {
    // Regression guard: stateful barriers are local (1-element, per-debater), so a
    // failing debater cannot block others. This test verifies the runner returns
    // quickly even when one debater's callOp throws instead of resolving its barrier.
    spyOn(callModule, "callOp").mockImplementation(async (_ctx, _op, input: StatefulDebaterInput) => {
      if (input.index === 1) throw new Error("debater 1 failed");
      input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
      return { success: true, rebut: `proposal-${input.index}` };
    });

    const result = await runStateful(makeRunStatefulCtx(), "test prompt");

    // debaters 0 and 2 succeed (index 1 throws); 2 successful → resolver runs
    expect(result).toBeDefined();
    expect(result.debaters).toHaveLength(2);
    expect(result.debaters).toContain("claude");
    expect(result.debaters).toContain("gemini");
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

  test("does not generate rebuttals when rounds is 1", async () => {
    spyOn(callModule, "callOp").mockImplementation(async (_ctx, _op, input: StatefulDebaterInput) => {
      input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
      return { success: true, rebut: `proposal-${input.index}` };
    });

    const result = await runStateful(
      makeRunStatefulCtx({
        stageConfig: {
          ...makeRunStatefulCtx().stageConfig,
          rounds: 1,
        },
      }),
      "stateful debate prompt",
    );

    expect(result.rebuttals).toEqual([]);
    expect(result.proposals).toEqual([
      { debater: { agent: "claude", model: "fast" }, output: "proposal-0" },
      { debater: { agent: "opencode", model: "balanced" }, output: "proposal-1" },
      { debater: { agent: "gemini", model: "powerful" }, output: "proposal-2" },
    ]);
  });
});
