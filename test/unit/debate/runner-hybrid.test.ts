import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DebateRunner, _debateSessionDeps } from "@/debate";
import type { HybridCtx } from "@/debate/runner-hybrid";
import type { DebateRunnerOptions, DebateStageConfig } from "@/debate";
import type { CallContext } from "@/operations";
import * as callModule from "@/operations";
import type { DebateStatefulInput } from "@/operations/debate-stateful";
import { DEFAULT_CONFIG } from "@/config";
import { debateConfigSelector } from "@/config";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import { makeMockAgentManager, makeSessionManager } from "@test/helpers";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeHybridStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
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

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
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
    runtime: {
      agentManager,
      sessionManager,
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
      costAggregator: createNoOpCostAggregator(),
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-test",
    featureName: "feat-hybrid",
    ...overrides,
  };
}

function makeRunner(
  ctxOverrides: Partial<CallContext> = {},
  stageConfigOverrides: Partial<DebateStageConfig> = {},
  extraOpts: Partial<DebateRunnerOptions> = {},
): DebateRunner {
  const ctx = makeCallCtx(ctxOverrides);
  const sm = (ctx.runtime as any).sessionManager;
  return new DebateRunner({
    ctx,
    stage: "run",
    stageConfig: makeHybridStageConfig(stageConfigOverrides),
    config: DEFAULT_CONFIG,
    workdir: "/tmp/work",
    featureName: "feat-hybrid",
    timeoutSeconds: 60,
    sessionManager: sm,
    ...extraOpts,
  });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

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

// ─── AC1: sessionRole is 'debate-hybrid-{debaterIndex}' ──────────────────────

describe("DebateRunner hybrid mode — handle IDs correspond to sessionRole (AC1)", () => {
  test("debater 0 gets handle 'debate-hybrid-0' and debater 1 gets 'debate-hybrid-1'", async () => {
    const openedNames: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => { openedNames.push(name); return { id: name, agentName: "claude" }; }),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(openedNames).toContain("debate-hybrid-0");
    expect(openedNames).toContain("debate-hybrid-1");
  });

  test("sessionRole index matches debater position in the debaters array (3 debaters)", async () => {
    const openedNames: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => { openedNames.push(name); return { id: name, agentName: "claude" }; }),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig({
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(openedNames).toContain("debate-hybrid-0");
    expect(openedNames).toContain("debate-hybrid-1");
    expect(openedNames).toContain("debate-hybrid-2");
  });
});

// ─── AC2: parallel via allSettledBounded ─────────────────────────────────────

describe("DebateRunner hybrid mode — parallel proposals via allSettledBounded (AC2)", () => {
  test("all debaters are invoked in the proposal round", async () => {
    const invoked: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => {
        invoked.push(agentName);
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig({
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(invoked).toContain("claude");
    expect(invoked).toContain("opencode");
    expect(invoked).toContain("gemini");
  });

  test("maxConcurrentDebaters: 1 still runs all proposals (sequentially)", async () => {
    const proposalInvoked: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, prompt) => {
        // Only count proposal calls (not rebuttals)
        if (!prompt.includes("## Your Task")) proposalInvoked.push(agentName);
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: { ...DEFAULT_CONFIG, debate: { maxConcurrentDebaters: 1 } } as any,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(proposalInvoked.length).toBe(2);
  });
});

// ─── AC3: pre-opened sessions per debater ────────────────────────────────────

describe("DebateRunner hybrid mode — pre-opened sessions per debater (AC3)", () => {
  test("opens one session per debater before proposal round", async () => {
    const openCalls: string[] = [];
    const runAsSessionCalls: number[] = [];
    const closeCalls: number[] = [];

    const sm = makeSessionManager({
      openSession: mock(async (name: string) => { openCalls.push(name); return { id: "h-" + openCalls.length, agentName: "claude" }; }),
      closeSession: mock(async () => { closeCalls.push(1); }),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => {
        runAsSessionCalls.push(1);
        return { output: "proposal", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });

    await runner.run("prompt");

    // 2 debaters → 2 open, 2 close
    expect(openCalls.length).toBe(2);
    expect(closeCalls.length).toBe(2);
    // runAsSession is called for both proposals AND rebuttals (rounds=1 → 2+2=4 total)
    expect(runAsSessionCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── AC4: fallback when fewer than 2 proposals succeed ───────────────────────

describe("DebateRunner hybrid mode — single-agent fallback when fewer than 2 proposals succeed (AC4)", () => {
  test("returns outcome=passed with single debater when exactly 1 proposal succeeds", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => {
        if (agentName === "opencode") throw new Error("opencode failed");
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
    expect(result.rounds).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].output).toBe("proposal-claude");
  });

  test("returns outcome=failed when 0 proposals succeed and fallback retry also fails", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => { throw new Error("all failed"); },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("failed");
    expect(result.debaters).toEqual([]);
  });
});

// ─── AC5: successful proposal outputs collected ───────────────────────────────

describe("DebateRunner hybrid mode — successful proposal outputs collected (AC5)", () => {
  test("both proposal outputs appear in result.proposals when 2 proposals succeed", async () => {
    const runner = makeRunner();
    spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: DebateStatefulInput) => {
      if (!input.proposePrompt.includes("## Proposals")) {
        input.proposalBarriers[0]?.resolve(`proposal-from-${input.debater.agent}`);
        return { success: true, rebut: `proposal-from-${input.debater.agent}` };
      }

      return { success: true, rebut: `rebuttal-from-${input.debater.agent}` };
    });

    const result = await runner.run("test prompt");

    expect(result.proposals).toHaveLength(2);
    const outputs = result.proposals.map((p) => p.output);
    expect(outputs).toContain("proposal-from-claude");
    expect(outputs).toContain("proposal-from-opencode");
  });
});

// ─── AC6: adapters resolved via getAgent ─────────────────────────────────────

describe("DebateRunner hybrid mode — adapter resolution via getAgent (AC6)", () => {
  test("manager.getAgent is called for each debater to resolve adapters", async () => {
    const agentCalls: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      getAgentFn: (name: string) => {
        agentCalls.push(name);
        return {} as any;
      },
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(agentCalls).toContain("claude");
    expect(agentCalls).toContain("opencode");
  });

  test("debater is skipped when manager.getAgent returns undefined — triggers single-agent fallback", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      unavailableAgents: new Set(["opencode"]),
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
  });
});

// ─── HybridCtx callContext field (AC4) ───────────────────────────────────────

describe("HybridCtx — callContext field (AC4)", () => {
  test("HybridCtx interface accepts readonly callContext: CallContext (compile-time check)", () => {
    const callCtx = makeCallCtx();
    const ctx: HybridCtx = {
      storyId: "US-ac4",
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: debateConfigSelector.select(DEFAULT_CONFIG),
      workdir: "/tmp",
      featureName: "feat",
      timeoutSeconds: 60,
      callContext: callCtx,
      agentManager: makeMockAgentManager(),
      sessionManager: makeSessionManager(),
      runtime: { signal: undefined } as any,
      abortSignal: new AbortController().signal,
    };
    expect(ctx.callContext).toBeDefined();
    expect(ctx.callContext).toBe(callCtx);
  });
});

// ─── US-005: Two-scope cost tracking (hybrid) ────────────────────────────────

describe("runHybrid() — two-scope cost tracking (US-005)", () => {
  function makeScopedCostAgg(debaterCost = 0, resolverCost = 0) {
    let callCount = 0;
    const closed: string[] = [];
    const openFn = mock(() => {
      const isDebater = callCount++ === 0;
      const scopeId = isDebater ? "debater-scope" : "resolver-scope";
      return {
        scopeId,
        snapshot: () => ({
          totalCostUsd: isDebater ? debaterCost : resolverCost,
          totalEstimatedCostUsd: 0,
          totalExactCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
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
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    return {
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG, select: (_: unknown) => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_: unknown) => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: costAgg,
      } as any,
      packageView: { config: DEFAULT_CONFIG, select: (_: unknown) => DEFAULT_CONFIG } as any,
      packageDir: "/tmp/work",
      agentName: "claude",
      storyId: "US-cost-hybrid",
      featureName: "feat-cost-hybrid",
    };
  }

  test("AC5/AC1: opens debaterScope and resolverScope, both closed in finally", async () => {
    const costAgg = makeScopedCostAgg();
    const ctx = makeCtxWithCostAgg(costAgg);
    const sm = (ctx.runtime as any).sessionManager;
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });
    await runner.run("prompt");
    expect(costAgg.openScope).toHaveBeenCalledTimes(2);
    expect(costAgg.closed).toContain("debater-scope");
    expect(costAgg.closed).toContain("resolver-scope");
  });

  test("AC6: totalCostUsd = debaterScope (0.10) + resolverScope (0.02) = 0.12", async () => {
    const costAgg = makeScopedCostAgg(0.10, 0.02);
    const ctx = makeCtxWithCostAgg(costAgg);
    const sm = (ctx.runtime as any).sessionManager;
    spyOn(callModule, "callOp").mockImplementation(async (_callCtx: unknown, _op: unknown, input: unknown) => {
      (input as any).proposalBarriers?.[0]?.resolve("ok");
      return { success: true, rebut: "ok" } as any;
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });
    const result = await runner.run("prompt");
    expect(result.totalCostUsd).toBeCloseTo(0.12);
  });
});
