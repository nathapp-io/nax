import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeCallOp, makeLogger, makeMockAgentManager, makeMockRuntime, makeSessionManager } from "@test/helpers";
import { DEFAULT_CONFIG, debateConfigSelector } from "@/config";
import { DebateRunner } from "@/debate/runner";
import { _debateSessionDeps } from "@/debate/session-helpers";
import type { DebateStageConfig } from "@/debate/types";
import * as callModule from "@/operations";
import type { CallContext } from "@/operations/types";
import type { ICostAggregator } from "@/runtime";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager({
    completeFn: async (_name: string, _p: string, _o: unknown) => ({
      output: '{"passed":true}',
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
    }),
  });
  const runtime =
    overrides.runtime ??
    makeMockRuntime({
      agentManager,
      sessionManager: makeSessionManager(),
      costAggregator: createNoOpCostAggregator(),
    });
  return {
    runtime,
    packageView: overrides.packageView ?? runtime.packages.repo(),
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-001",
    featureName: "feat-a",
    ...overrides,
  };
}

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    mode: "panel",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "fast" },
    ],
    ...overrides,
  };
}

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => makeLogger());
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

describe("DebateRunner — one-shot panel mode", () => {
  test.each([undefined, 1_800])(
    "decompose forwards its resolved timeout to every turn (override %s)",
    async (override) => {
      const timeouts: (number | undefined)[] = [];
      const agentManager = makeMockAgentManager({
        completeAsFn: async (_name, _prompt, options) => {
          timeouts.push(options?.timeoutMs);
          return { output: '{"passed":true}', tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
        },
      });
      const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
      try {
        const runner = new DebateRunner({
          ctx: makeCallCtx({ runtime }),
          stage: "decompose",
          stageConfig: makeStageConfig({ rounds: 2, timeoutSeconds: 1_200 }),
          timeoutSeconds: override,
          config: DEFAULT_CONFIG,
          workdir: "/tmp/work",
        });
        expect((await runner.run("prompt")).outcome).toBe("passed");
        expect(timeouts).toEqual(Array(4).fill((override ?? 1_200) * 1_000));
      } finally {
        await runtime.close();
      }
    },
  );

  test("run() returns passed result when both debaters succeed", async () => {
    const ctx = makeCallCtx();
    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("passed");
    expect(result.stage).toBe("review");
    expect(result.storyId).toBe("US-001");
  });

  test("run() returns passed with single debater when second fails", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name: string, _p: string, _o: unknown) => {
        callCount++;
        if (callCount === 2) throw new Error("second debater failed");
        return { output: '{"passed":true}', tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });
    const ctx = makeCallCtx({
      runtime: makeMockRuntime({
        agentManager,
        sessionManager: makeSessionManager(),
        costAggregator: createNoOpCostAggregator(),
      }),
    });
    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp",
    });
    const result = await runner.run("prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toHaveLength(1);
  });

  test("run() returns failed when all debaters fail", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => {
        throw new Error("all fail");
      },
    });
    const ctx = makeCallCtx({
      runtime: makeMockRuntime({
        agentManager,
        sessionManager: makeSessionManager(),
        costAggregator: createNoOpCostAggregator(),
      }),
    });
    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp",
    });
    const result = await runner.run("prompt");
    expect(result.outcome).toBe("failed");
  });

  test("run() calls agentManager.completeAs per debater", async () => {
    const calls: string[] = [];
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name: string, _p: string, _o: unknown) => {
        calls.push(name);
        return { output: '{"passed":true}', tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });
    const stageConfig = makeStageConfig({
      debaters: [
        { agent: "claude", model: "fast" },
        { agent: "opencode", model: "fast" },
      ],
    });
    const ctx = makeCallCtx({
      runtime: makeMockRuntime({
        agentManager,
        sessionManager: makeSessionManager(),
        costAggregator: createNoOpCostAggregator(),
      }),
    });
    const runner = new DebateRunner({ ctx, stage: "review", stageConfig, config: DEFAULT_CONFIG, workdir: "/tmp" });
    await runner.run("prompt");
    expect(calls).toContain("claude");
    expect(calls).toContain("opencode");
  });

  test("constructor accepts a DebateConfig slice (no NaxConfig cast)", () => {
    const slice = debateConfigSelector.select(DEFAULT_CONFIG);
    const ctx = makeCallCtx();
    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStageConfig(),
      config: slice,
      workdir: "/tmp",
    });
    expect(runner).toBeDefined();
  });
});

// ─── toStatefulCtx callContext threading (AC5) ────────────────────────────────

describe("DebateRunner.toStatefulCtx — callContext included (AC5)", () => {
  test("stateful mode run succeeds with callContext threaded through toStatefulCtx", async () => {
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: '{"passed":true}',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      }),
    });
    const sessionManager = makeSessionManager();
    const ctx = makeCallCtx({
      runtime: makeMockRuntime({
        agentManager,
        sessionManager,
        costAggregator: createNoOpCostAggregator(),
      }),
    });
    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "stateful",
        mode: "panel",
        rounds: 1,
        debaters: [{ agent: "claude", model: "fast" }],
      },
      config: DEFAULT_CONFIG,
      workdir: "/tmp",
      sessionManager,
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("passed");
  });
});

// ─── US-006: Four-scope cost tracking ────────────────────────────────────────

describe("DebateRunner.runPanelOneShot() — four-scope cost tracking (US-006)", () => {
  function makeScopedCostAgg(scopeCosts = [0, 0, 0, 0]) {
    let callCount = 0;
    const closed: string[] = [];
    const scopeNames = ["pre-phase-scope", "debater-scope", "resolver-scope", "verifier-scope"];
    const openFn = mock(() => {
      const idx = callCount++;
      const scopeId = scopeNames[idx] ?? `scope-${idx}`;
      const cost = scopeCosts[idx] ?? 0;
      return {
        scopeId,
        snapshot: () => ({
          totalCostUsd: cost,
          totalEstimatedCostUsd: 0,
          totalExactCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
          totalErrorCostUsd: 0,
        }),
        close: mock(() => {
          closed.push(scopeId);
        }),
      };
    });
    return { openScope: openFn, closed };
  }

  function makeCtxWithCostAgg(costAgg: ReturnType<typeof makeScopedCostAgg>): CallContext {
    const agentManager = makeMockAgentManager({
      completeFn: async (_name: string, _p: string, _o: unknown) => ({
        output: '{"passed":true}',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });
    const costAggregator: ICostAggregator = {
      ...createNoOpCostAggregator(),
      openScope: costAgg.openScope,
    };
    const runtime = makeMockRuntime({
      agentManager,
      sessionManager: makeSessionManager(),
      costAggregator,
    });
    return {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp/work",
      agentName: "claude",
      storyId: "US-cost",
      featureName: "feat-cost",
    };
  }

  function makePanelCostRunner(ctx: CallContext) {
    return new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });
  }

  test("AC1: opens four scopes and closes all four in finally", async () => {
    const costAgg = makeScopedCostAgg();
    const runner = makePanelCostRunner(makeCtxWithCostAgg(costAgg));
    await runner.run("prompt");
    expect(costAgg.openScope).toHaveBeenCalledTimes(4);
    expect(costAgg.closed).toContain("pre-phase-scope");
    expect(costAgg.closed).toContain("debater-scope");
    expect(costAgg.closed).toContain("resolver-scope");
    expect(costAgg.closed).toContain("verifier-scope");
  });

  test("AC3: debater callOp receives scopeId from debaterScope", async () => {
    const costAgg = makeScopedCostAgg();
    const ctx = makeCtxWithCostAgg(costAgg);
    const capturedIds: (string | undefined)[] = [];
    spyOn(callModule, "callOp").mockImplementation(
      makeCallOp({
        fallback: '{"passed":true}',
        onDispatch: (op, callCtx) => {
          if (op.name === "debate-propose") capturedIds.push(callCtx.scopeId);
        },
      }),
    );
    await makePanelCostRunner(ctx).run("prompt");
    expect(capturedIds.length).toBeGreaterThan(0);
    expect(capturedIds.every((id) => id === "debater-scope")).toBe(true);
  });

  test("AC6: totalCostUsd = sum of all four scope snapshots", async () => {
    const costAgg = makeScopedCostAgg([0.01, 0.1, 0.02, 0]);
    const ctx = makeCtxWithCostAgg(costAgg);
    spyOn(callModule, "callOp").mockImplementation(makeCallOp({ fallback: '{"passed":true}' }));
    const result = await makePanelCostRunner(ctx).run("prompt");
    expect(result.totalCostUsd).toBeCloseTo(0.13);
  });
});
