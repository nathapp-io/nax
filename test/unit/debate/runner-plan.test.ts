import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import { _runPlanDeps } from "@/debate";
import { DebateRunner } from "@/debate/runner";
import { _debateSessionDeps } from "@/debate/session-helpers";
import type { DebateStageConfig } from "@/debate/types";
import * as callModule from "@/operations";
import type { CallContext } from "@/operations/types";
import { makeMockAgentManager, makeSessionManager } from "@test/helpers";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager();
  return {
    runtime: {
      agentManager,
      sessionManager: makeSessionManager(),
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-020",
    featureName: "feat-plan",
    ...overrides,
  };
}

function makeCallCtxWithIds(
  storyId: string,
  agentManager: ReturnType<typeof makeMockAgentManager>,
  sessionManager: ReturnType<typeof makeSessionManager>,
  config: NaxConfig = DEFAULT_CONFIG,
): CallContext {
  return {
    runtime: {
      agentManager,
      sessionManager,
      configLoader: { current: () => config, select: (_sel: unknown) => config } as any,
      packages: { resolve: () => ({ config, select: (_sel: unknown) => config }) } as any,
      signal: undefined,
    } as any,
    packageView: { config, select: (_sel: unknown) => config } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId,
    featureName: "test",
  };
}

function makePlanStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
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

const TEST_CONFIG = {
  autoMode: { defaultAgent: "opencode" },
} as unknown as NaxConfig;

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;
let origReadFile: typeof _debateSessionDeps.readFile;
let origCallOp: typeof callModule.callOp;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  origReadFile = _debateSessionDeps.readFile;
  origCallOp = callModule.callOp;
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }));
  _debateSessionDeps.readFile = mock(async (_path: string) => '{"plan": "output"}');
  // Default callOp mock for plan debater ops — intercepts only "debate-plan" op calls.
  // All other ops (synthesis resolver, verifier, etc.) fall through to the real callOp.
  spyOn(callModule, "callOp").mockImplementation(async (ctx, op: any, input) => {
    if (op?.name === "debate-plan") return { success: true, rebut: '{"plan":"output"}' } as never;
    return origCallOp(ctx, op, input);
  });
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  _debateSessionDeps.readFile = origReadFile;
  mock.restore();
});

// ─── Core plan mode tests ─────────────────────────────────────────────────────

describe("DebateRunner.runPlan() — plan mode uses callOp (one-shot path)", () => {
  test("plan mode delegates to callOp (not runInSession)", async () => {
    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager({});
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/work",
      feature: "feat-plan",
      outputDir: "/tmp/out",
    });

    // After migration: callOp drives one-shot plan debaters; runInSession is never called.
    expect(sm.runInSession).not.toHaveBeenCalled();
  });

  test("runPlan launches one callOp per debater in one-shot mode", async () => {
    let callCount = 0;
    spyOn(callModule, "callOp").mockImplementation(async () => {
      callCount++;
      return { success: true, rebut: "ok" } as never;
    });

    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager({});
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/work",
      feature: "feat-plan",
      outputDir: "/tmp/out",
    });

    // One callOp per debater (default stageConfig has 2 debaters)
    expect(callCount).toBe(2);
    expect(sm.runInSession).not.toHaveBeenCalled();
  });

  test("runPlan() returns a DebateResult", async () => {
    const sm = makeSessionManager({
      runInSession: mock(async (_name: string, _prompt: string, _opts: unknown) => ({
        output: "plan output",
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        internalRoundTrips: 1,
      })) as any,
      nameFor: mock((_req: unknown) => "nax-result-session"),
    });

    const agentManager = makeMockAgentManager();

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/work",
      feature: "feat-plan",
      outputDir: "/tmp/out",
    });

    expect(result).toHaveProperty("outcome");
    expect(result).toHaveProperty("stage");
    expect(result).toHaveProperty("storyId");
    expect(result).toHaveProperty("proposals");
    expect(result.stage).toBe("plan");
  });

  test("runPlan() returns failed when sessionManager is missing", async () => {
    const agentManager = makeMockAgentManager();

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: undefined as any,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: undefined,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/work",
      feature: "feat-plan",
      outputDir: "/tmp/out",
    });

    expect(result.outcome).toBe("failed");
  });
});

// ─── Extended plan mode tests (from session-plan) ────────────────────────────

describe("DebateRunner.runPlan()", () => {
  test("passes unique index and storyId to each plan debater callOp", async () => {
    const capturedIndices: number[] = [];
    const capturedStoryIds: string[] = [];
    spyOn(callModule, "callOp").mockImplementation(async (callCtx, _op, input: any) => {
      capturedIndices.push(input.index as number);
      capturedStoryIds.push((callCtx as any).storyId ?? "");
      return { success: true, rebut: "ok" } as never;
    });

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 3, maxConcurrentDebaters: 3 },
    } as unknown as NaxConfig;
    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("config-ssot", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({
        debaters: [{ agent: "opencode" }, { agent: "opencode" }, { agent: "opencode" }],
      }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "config-ssot",
      outputDir: "/tmp/out",
    });

    expect(capturedIndices.sort()).toEqual([0, 1, 2]);
    expect(capturedStoryIds).toEqual(["config-ssot", "config-ssot", "config-ssot"]);
  });

  test("runs hybrid rebuttal loop when mode=hybrid and sessionMode=stateful", async () => {
    // After migration to callOp/planDebaterOp, the coordinator launches one callOp per
    // debater and collects the rebuttal from the rebuttalBarrier propagated by the .then() handler.
    const mockSM = makeSessionManager();
    const agentManager = makeMockAgentManager();
    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;

    let callIdx = 0;
    spyOn(callModule, "callOp").mockImplementation(
      async () => ({ success: true, rebut: `rebut-${callIdx++}` }) as never,
    );

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("plan-hybrid-test", agentManager, mockSM, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({
        mode: "hybrid",
        sessionMode: "stateful",
        rounds: 1,
        debaters: [{ agent: "opencode" }, { agent: "opencode" }],
      }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: mockSM,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "plan-hybrid-test",
      outputDir: "/tmp/out",
    });

    // One callOp per debater; rebuttal output collected via rebuttalBarrier
    expect(result.rebuttals).toBeDefined();
    expect(result.rebuttals).toHaveLength(2);
    expect(result.rounds).toBe(1);
    expect(mockSM.runInSession).not.toHaveBeenCalled();
  });

  test("skips rebuttal loop when mode is panel (default)", async () => {
    const runAsSessionCalls: Array<{ prompt: string }> = [];

    const sm = makeSessionManager({
      runInSession: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, _handle, prompt) => {
        runAsSessionCalls.push({ prompt });
        return {
          output: "run-output",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      },
    });

    _debateSessionDeps.readFile = mock(async () => "{}");

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("plan-panel-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "plan-panel-test",
      outputDir: "/tmp/out",
    });

    expect(runAsSessionCalls).toHaveLength(0);
    expect(result.rebuttals).toBeUndefined();
    expect(result.rounds).toBe(1);
  });

  test("warns and skips rebuttal when mode=hybrid but sessionMode=one-shot", async () => {
    const warnings: string[] = [];
    _debateSessionDeps.getSafeLogger = mock(() => ({
      warn: (_stage: string, msg: string) => warnings.push(msg),
      info: () => {},
      debug: () => {},
      error: () => {},
    })) as unknown as typeof _debateSessionDeps.getSafeLogger;

    const sm = makeSessionManager({
      runInSession: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });

    _debateSessionDeps.readFile = mock(async () => "{}");

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("plan-hybrid-oneshot", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({
        mode: "hybrid",
        sessionMode: "one-shot",
        rounds: 2,
      }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "plan-hybrid-oneshot",
      outputDir: "/tmp/out",
    });

    expect(warnings.some((w) => w.includes("hybrid") && w.includes("stateful"))).toBe(true);
    expect(result.rebuttals).toBeUndefined();
    expect(result.rounds).toBe(1);
  });

  test("synthesis prompt includes spec anchor when specContent provided, omits when not", async () => {
    let capturedSynthesisPrompt = "";
    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const sm = makeSessionManager({
      runInSession: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });
    const agentManager = makeMockAgentManager({
      completeFn: async (_agentName, prompt) => {
        capturedSynthesisPrompt = prompt;
        return { output: '{"userStories":[]}', tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });
    _debateSessionDeps.readFile = mock(async () => '{"userStories":[]}');

    const specContent = "# My Feature\n## Stories\n### US-001\n**AC:**\n- AC one\n- AC two";
    const makeRunner = (storyId: string) =>
      new DebateRunner({
        ctx: makeCallCtxWithIds(storyId, agentManager, sm, config),
        stage: "plan",
        stageConfig: makePlanStageConfig({ resolver: { type: "synthesis", agent: "opencode" } }),
        config,
        workdir: "/tmp/workdir",
        sessionManager: sm,
      });

    await makeRunner("spec-anchor-test").runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "spec-anchor-test",
      outputDir: "/tmp/out",
      specContent,
    });
    expect(capturedSynthesisPrompt).toContain("## Original Spec");
    expect(capturedSynthesisPrompt).toContain("AC one");
    expect(capturedSynthesisPrompt).toContain("AC two");
    expect(capturedSynthesisPrompt).toContain("acceptanceCriteria");
    expect(capturedSynthesisPrompt).toContain("suggestedCriteria");

    capturedSynthesisPrompt = "";
    await makeRunner("no-spec-anchor").runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "no-spec-anchor",
      outputDir: "/tmp/out",
    });
    expect(capturedSynthesisPrompt).not.toContain("## Original Spec");
    expect(capturedSynthesisPrompt).not.toContain("suggestedCriteria");
  });

  test("runs plan debaters in parallel (when limit >= agents)", async () => {
    const startedOrder: number[] = [];
    const resolvers: Array<() => void> = [];

    spyOn(callModule, "callOp").mockImplementation(async (_ctx, op: any, input: any) => {
      if (op?.name !== "debate-plan") return origCallOp(_ctx, op, input);
      const idx = input.index as number;
      startedOrder.push(idx);
      await new Promise<void>((resolve) => {
        resolvers[idx] = resolve;
      });
      return { success: true, rebut: "ok" } as never;
    });

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("config-ssot", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const runPromise = runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "config-ssot",
      outputDir: "/tmp/out",
    });

    for (let attempt = 0; attempt < 20; attempt++) {
      if (startedOrder.length >= 2) break;
      await Promise.resolve();
    }
    expect(startedOrder).toEqual([0, 1]);

    resolvers[0]?.();
    resolvers[1]?.();
    await runPromise;
  });

  test("prepends manifestSection to each debater prompt when provided, omits when not", async () => {
    const capturedPrompts: string[] = [];
    spyOn(callModule, "callOp").mockImplementation(async (_ctx, op: any, input: any) => {
      if (op?.name === "debate-plan") capturedPrompts.push(input.proposePrompt as string);
      else return origCallOp(_ctx, op, input);
      return { success: true, rebut: "ok" } as never;
    });

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager();
    const makeRunner = (storyId: string) =>
      new DebateRunner({
        ctx: makeCallCtxWithIds(storyId, agentManager, sm, config),
        stage: "plan",
        stageConfig: makePlanStageConfig(),
        config,
        workdir: "/tmp/workdir",
        sessionManager: sm,
      });

    await makeRunner("manifest-thread-test").runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "manifest-thread-test",
      outputDir: "/tmp/out",
      manifestSection: "## Facts Manifest\n- F-001: some fact",
    });
    expect(capturedPrompts.length).toBeGreaterThan(0);
    for (const prompt of capturedPrompts) {
      expect(prompt).toContain("## Facts Manifest");
      expect(prompt).toContain("F-001: some fact");
    }

    capturedPrompts.length = 0;
    await makeRunner("no-manifest-test").runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "no-manifest-test",
      outputDir: "/tmp/out",
    });
    expect(capturedPrompts.length).toBeGreaterThan(0);
    for (const prompt of capturedPrompts) {
      expect(prompt).not.toContain("## Facts Manifest");
    }
  });
});

// ─── AC-3: preDebatePhase invocation + onFailure routing ─────────────────────

describe("runner-plan — preDebatePhase invocation", () => {
  let origResolvePreDebatePhase: typeof _runPlanDeps.resolvePreDebatePhase;
  let origResolvePostDebateVerifier: typeof _runPlanDeps.resolvePostDebateVerifier;

  beforeEach(() => {
    origResolvePreDebatePhase = _runPlanDeps.resolvePreDebatePhase;
    origResolvePostDebateVerifier = _runPlanDeps.resolvePostDebateVerifier;
  });

  afterEach(() => {
    _runPlanDeps.resolvePreDebatePhase = origResolvePreDebatePhase;
    _runPlanDeps.resolvePostDebateVerifier = origResolvePostDebateVerifier;
  });

  test("AC-3: invokes resolvePreDebatePhase before proposer fan-out when preDebatePhase is configured", async () => {
    const prePhaseCalled: string[] = [];
    _runPlanDeps.resolvePreDebatePhase = mock((_kind: string) => {
      prePhaseCalled.push(_kind);
      return async () => ({ manifestSection: "## Grounded Facts\n- F-001", costUsd: 0 });
    }) as any;

    const sm = makeSessionManager({
      runInSession: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });
    _debateSessionDeps.readFile = mock(async () => "{}");

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("pre-phase-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({ preDebatePhase: { kind: "grounder" } }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "pre-phase-test",
      outputDir: "/tmp/out",
    });

    expect(prePhaseCalled).toEqual(["grounder"]);
  });

  test("AC-3: threads packageView through the plan pre-phase context", async () => {
    const packageView = {
      config: DEFAULT_CONFIG,
      select: mock((_sel: unknown) => DEFAULT_CONFIG),
    } as any;
    let receivedPackageView: unknown;

    _runPlanDeps.resolvePreDebatePhase = mock((_kind: string) => async (preCtx) => {
      receivedPackageView = preCtx.ctx.packageView;
      preCtx.ctx.packageView.select(() => DEFAULT_CONFIG);
      return { manifestSection: "## Grounded Facts\n- F-001", costUsd: 0 };
    }) as any;

    const sm = makeSessionManager({
      runInSession: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });
    _debateSessionDeps.readFile = mock(async () => "{}");

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const agentManager = makeMockAgentManager();
    const ctx = makeCallCtxWithIds("package-view-test", agentManager, sm, config);
    ctx.packageView = packageView;

    const runner = new DebateRunner({
      ctx,
      stage: "plan",
      stageConfig: makePlanStageConfig({ preDebatePhase: { kind: "grounder" } }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "package-view-test",
      outputDir: "/tmp/out",
    });

    expect(receivedPackageView).toBe(packageView);
    expect(packageView.select).toHaveBeenCalled();
  });

  test("AC-3: prepends prePhase manifestSection to proposal taskContext", async () => {
    _runPlanDeps.resolvePreDebatePhase = mock((_kind: string) => async () => ({
      manifestSection: "## Grounded Facts\n- F-001: critical fact",
      costUsd: 0,
    })) as any;

    const capturedPrompts: string[] = [];
    spyOn(callModule, "callOp").mockImplementation(async (_ctx, op: any, input: any) => {
      if (op?.name === "debate-plan") capturedPrompts.push(input.proposePrompt as string);
      else return origCallOp(_ctx, op, input);
      return { success: true, rebut: "ok" } as never;
    });

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("manifest-prepend-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({ preDebatePhase: { kind: "grounder" } }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "manifest-prepend-test",
      outputDir: "/tmp/out",
    });

    expect(capturedPrompts.length).toBeGreaterThan(0);
    for (const p of capturedPrompts) {
      expect(p).toContain("F-001: critical fact");
    }
  });

  test("AC-3: onFailure degrade — continues with empty manifestSection and logs warning when prePhase throws", async () => {
    const warnings: string[] = [];
    _debateSessionDeps.getSafeLogger = mock(() => ({
      warn: (_stage: string, msg: string) => warnings.push(msg),
      info: () => {},
      debug: () => {},
      error: () => {},
    })) as unknown as typeof _debateSessionDeps.getSafeLogger;

    _runPlanDeps.resolvePreDebatePhase = mock((_kind: string) => async () => {
      throw new Error("grounder failed");
    }) as any;

    let debaterCallCount = 0;
    spyOn(callModule, "callOp").mockImplementation(async (_ctx, op: any, input: any) => {
      if (op?.name === "debate-plan") {
        debaterCallCount++;
        return { success: true, rebut: "ok" } as never;
      }
      return origCallOp(_ctx, op, input);
    });

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("degrade-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({ preDebatePhase: { kind: "grounder", onFailure: "degrade" } }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "degrade-test",
      outputDir: "/tmp/out",
    });

    // Proposers should still run despite pre-phase failure
    expect(debaterCallCount).toBeGreaterThan(0);
    // Warning logged about the pre-phase failure
    expect(
      warnings.some(
        (w) => w.includes("grounder") || w.includes("pre-phase") || w.includes("degrade") || w.includes("failed"),
      ),
    ).toBe(true);
    // A result was returned (not an exception), regardless of selector outcome
    expect(result).toBeDefined();
    expect(result.storyId).toBe("degrade-test");
  });

  test("AC-3: onFailure block — returns failed before any proposer runs when prePhase throws", async () => {
    _runPlanDeps.resolvePreDebatePhase = mock((_kind: string) => async () => {
      throw new Error("grounder blocked");
    }) as any;

    const sm = makeSessionManager({
      runInSession: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });
    _debateSessionDeps.readFile = mock(async () => "{}");

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("block-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({ preDebatePhase: { kind: "grounder", onFailure: "block" } }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "block-test",
      outputDir: "/tmp/out",
    });

    expect(result.outcome).toBe("failed");
    // runInSession not called (no proposers ran)
    expect(sm.runInSession).not.toHaveBeenCalled();
  });
});

// ─── AC-4: stateful session lifecycle in runPlan ─────────────────────────────

describe("runner-plan — stateful session lifecycle", () => {
  let origResolvePreDebatePhase: typeof _runPlanDeps.resolvePreDebatePhase;
  let origResolvePostDebateVerifier: typeof _runPlanDeps.resolvePostDebateVerifier;

  beforeEach(() => {
    origResolvePreDebatePhase = _runPlanDeps.resolvePreDebatePhase;
    origResolvePostDebateVerifier = _runPlanDeps.resolvePostDebateVerifier;
    _runPlanDeps.resolvePostDebateVerifier = mock(() => async () => ({
      outcome: "passed" as const,
      costUsd: 0,
    })) as any;
  });

  afterEach(() => {
    _runPlanDeps.resolvePreDebatePhase = origResolvePreDebatePhase;
    _runPlanDeps.resolvePostDebateVerifier = origResolvePostDebateVerifier;
  });

  test("AC-4: launches one callOp per debater (not runInSession) when sessionMode is stateful", async () => {
    // After migration: coordinator delegates session lifecycle to callOp/planDebaterOp.
    // The contract is: callOp called N times, runInSession never called.
    let callCount = 0;
    spyOn(callModule, "callOp").mockImplementation(async () => {
      callCount++;
      return { success: true, rebut: `output-${callCount}` } as never;
    });

    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager();
    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("stateful-open-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({
        sessionMode: "stateful",
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
      }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "stateful-open-test",
      outputDir: "/tmp/out",
    });

    expect(callCount).toBe(2);
    expect(sm.runInSession).not.toHaveBeenCalled();
  });

  test("AC-4: passes selectionSignal and rebuttalBarrier to each callOp when sessionMode is stateful", async () => {
    // Verify coordinator passes the correct barrier/signal wiring to each debater callOp.
    const capturedInputs: Array<{ index: number; hasSelectionSignal: boolean; hasRebuttalBarrier: boolean }> = [];
    spyOn(callModule, "callOp").mockImplementation(async (_ctx, _op, input: any) => {
      capturedInputs.push({
        index: input.index,
        hasSelectionSignal: input.selectionSignal instanceof Promise,
        hasRebuttalBarrier: input.rebuttalBarrier != null,
      });
      return { success: true, rebut: `output-${input.index}` } as never;
    });

    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager();
    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("stateful-runAsSession-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({
        sessionMode: "stateful",
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
      }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "stateful-runAsSession-test",
      outputDir: "/tmp/out",
    });

    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs.every((i) => i.hasSelectionSignal)).toBe(true);
    expect(capturedInputs.every((i) => i.hasRebuttalBarrier)).toBe(true);
    expect(sm.runInSession).not.toHaveBeenCalled();
  });

  test("AC-4: completes successfully with both debaters when sessionMode is stateful", async () => {
    // Verifies coordinator returns a valid result after both stateful callOps complete.
    // Session lifecycle (open/close) is now managed internally by callOp/buildHopCallback.
    spyOn(callModule, "callOp").mockImplementation(
      async (_ctx, _op, input: any) => ({ success: true, rebut: `output-${input.index}` }) as never,
    );

    const sm = makeSessionManager();
    const agentManager = makeMockAgentManager();
    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("stateful-close-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({
        sessionMode: "stateful",
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
      }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "stateful-close-test",
      outputDir: "/tmp/out",
    });

    expect(result.debaters).toHaveLength(2);
    expect(result.debaters).toContain("claude");
    expect(result.debaters).toContain("opencode");
    expect(sm.runInSession).not.toHaveBeenCalled();
  });
});

// ─── AC-5: postDebateVerifier + tag-expert rewrite ────────────────────────────

describe("runner-plan — postDebateVerifier and tag-expert rewrite", () => {
  let origResolvePreDebatePhase: typeof _runPlanDeps.resolvePreDebatePhase;
  let origResolvePostDebateVerifier: typeof _runPlanDeps.resolvePostDebateVerifier;

  beforeEach(() => {
    origResolvePreDebatePhase = _runPlanDeps.resolvePreDebatePhase;
    origResolvePostDebateVerifier = _runPlanDeps.resolvePostDebateVerifier;
  });

  afterEach(() => {
    _runPlanDeps.resolvePreDebatePhase = origResolvePreDebatePhase;
    _runPlanDeps.resolvePostDebateVerifier = origResolvePostDebateVerifier;
  });

  // BUG-15: no file-read fallback anymore — stub both debaters' proposals directly.
  const stubDebatePlanOp = (output: string) =>
    spyOn(callModule, "callOp").mockImplementation(
      async (_c, op: any) =>
        (op?.name === "debate-plan" ? { success: true, rebut: output } : Promise.reject(new Error(op?.name))) as never,
    );
  function makeRunWithVerifier(verifierFn: () => Promise<{ outcome: string; costUsd: number }>) {
    const verifierCalled: string[] = [];
    _runPlanDeps.resolvePostDebateVerifier = mock((_kind: string) => {
      verifierCalled.push(_kind);
      return verifierFn;
    }) as any;

    const sm = makeSessionManager({
      runInSession: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });

    const prdOutput = JSON.stringify({
      userStories: [
        { id: "US-001", routing: { complexity: "simple" } },
        { id: "US-002", routing: { complexity: "medium" } },
      ],
    });
    _debateSessionDeps.readFile = mock(async () => prdOutput);

    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("verifier-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({ postDebateVerifier: { kind: "plan-checklist" } }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    return { runner, sm, verifierCalled };
  }

  test("AC-5: invokes resolvePostDebateVerifier and propagates its outcome to DebateResult", async () => {
    const { runner: passRunner, verifierCalled } = makeRunWithVerifier(async () => ({ outcome: "passed", costUsd: 0 }));
    await passRunner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "verifier-test",
      outputDir: "/tmp/out",
    });
    expect(verifierCalled).toEqual(["plan-checklist"]);

    const { runner: failRunner } = makeRunWithVerifier(async () => ({ outcome: "failed", costUsd: 0 }));
    const result = await failRunner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "verifier-test",
      outputDir: "/tmp/out",
    });
    expect(result.outcome).toBe("failed");
  });

  test("AC-5: rewrites all routing.complexity to expert when onBlocker=tag-expert and verifier finds blockers", async () => {
    const prdOutput = JSON.stringify({
      userStories: [
        { id: "US-001", routing: { complexity: "simple" } },
        { id: "US-002", routing: { complexity: "medium" } },
      ],
    });

    // Verifier returns passed + blocker findings — this is the plan-checklist tag-expert signal
    _runPlanDeps.resolvePostDebateVerifier = mock((_kind: string) => async () => ({
      outcome: "passed" as const,
      findings: [{ checklistItem: "files-exist", severity: "blocker", message: "file missing" }],
      costUsd: 0,
    })) as any;

    const sm = makeSessionManager({
      runInSession: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });
    stubDebatePlanOp(prdOutput);
    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("tag-expert-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({ postDebateVerifier: { kind: "plan-checklist", onBlocker: "tag-expert" } }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "tag-expert-test",
      outputDir: "/tmp/out",
    });

    expect(result.outcome).toBe("passed");
    const parsedOutput = JSON.parse(result.output ?? "{}");
    for (const story of parsedOutput.userStories) {
      expect(story.routing.complexity).toBe("expert");
    }
  });

  test("AC-5: does not rewrite complexities when verifier passes with no blockers", async () => {
    const prdOutput = JSON.stringify({
      userStories: [{ id: "US-001", routing: { complexity: "simple" } }],
    });

    _runPlanDeps.resolvePostDebateVerifier = mock((_kind: string) => async () => ({
      outcome: "passed" as const,
      findings: [],
      costUsd: 0,
    })) as any;

    const sm = makeSessionManager({
      runInSession: mock(async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });
    stubDebatePlanOp(prdOutput);
    const config = {
      ...TEST_CONFIG,
      debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 },
    } as unknown as NaxConfig;
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("no-rewrite-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({ postDebateVerifier: { kind: "plan-checklist", onBlocker: "tag-expert" } }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "no-rewrite-test",
      outputDir: "/tmp/out",
    });

    // outcome stays passed, but no rewrite
    expect(result.outcome).toBe("passed");
    const parsedOutput = JSON.parse(result.output ?? "{}");
    for (const story of parsedOutput.userStories) {
      expect(story.routing.complexity).toBe("simple"); // unchanged
    }
  });
});
