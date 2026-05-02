import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { CallContext } from "../../../src/operations/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

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

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  origReadFile = _debateSessionDeps.readFile;
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }));
  _debateSessionDeps.readFile = mock(async (_path: string) => '{"plan": "output"}');
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  _debateSessionDeps.readFile = origReadFile;
  mock.restore();
});

// ─── Core plan mode tests ─────────────────────────────────────────────────────

describe("DebateRunner.runPlan() — plan mode uses sessionManager.runInSession", () => {
  test("plan mode calls sessionManager.runInSession", async () => {
    const runInSessionCalls: Array<{ name: string; prompt: string }> = [];

    const sm = makeSessionManager({
      runInSession: mock(async (name: string, prompt: string, _opts: unknown) => {
        runInSessionCalls.push({ name, prompt });
        return {
          output: "plan output",
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          internalRoundTrips: 1,
        };
      }) as any,
      nameFor: mock((_req: unknown) => "nax-test-session"),
    });

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

    expect(runInSessionCalls.length).toBeGreaterThan(0);
  });

  test("runPlan uses sessionManager.runInSession exclusively", async () => {
    const sm = makeSessionManager({
      runInSession: mock(async (_name: string, _prompt: string, _opts: unknown) => ({
        output: "plan output",
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        internalRoundTrips: 1,
      })) as any,
      nameFor: mock((_req: unknown) => "nax-mock-session"),
    });

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

    // planAs no longer exists on IAgentManager (deleted in Wave 3.5)
    expect(sm.runInSession).toHaveBeenCalled();
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
  test("passes unique indexed role to each plan debater via sessionManager.runInSession", async () => {
    const sessionRoles: string[] = [];

    const sm = makeSessionManager({
      runInSession: mock(async (name: string, _prompt: string, opts: any) => {
        sessionRoles.push(opts?.role ?? "");
        return {
          output: "ok",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      }) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });

    _debateSessionDeps.readFile = mock(async (path: string) => `output:${path}`);

    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 3, maxConcurrentDebaters: 3 } } as unknown as NaxConfig;
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

    expect(sessionRoles).toHaveLength(3);
    expect(sessionRoles[0]).toBe("debate-plan-0");
    expect(sessionRoles[1]).toBe("debate-plan-1");
    expect(sessionRoles[2]).toBe("debate-plan-2");
  });

  test("passes storyId through to each sessionManager.runInSession call", async () => {
    const capturedStoryIds: string[] = [];

    const sm = makeSessionManager({
      runInSession: mock(async (_name: string, _prompt: string, opts: any) => {
        capturedStoryIds.push(opts?.storyId ?? "");
        return {
          output: "ok",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      }) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });

    _debateSessionDeps.readFile = mock(async () => "{}");

    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig;
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("config-ssot", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "config-ssot",
      outputDir: "/tmp/out",
    });

    expect(capturedStoryIds).toEqual(["config-ssot", "config-ssot"]);
  });

  test("runs hybrid rebuttal loop when mode=hybrid and sessionMode=stateful", async () => {
    const rebuttalCalls: Array<{ prompt: string; handleId: string }> = [];
    const closedHandleIds: string[] = [];

    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "opencode" })),
      closeSession: mock(async (handle: any) => { closedHandleIds.push(handle.id); }),
      nameFor: mock((req: any) => req?.role ?? ""),
      runInSession: mock(async (_name: string, _prompt: string) => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })) as any,
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, handle, prompt) => {
        if (prompt.includes("You are debater") && prompt.includes("## Your Task")) {
          rebuttalCalls.push({ prompt, handleId: handle.id });
        }
        return {
          output: `run-output-${handle.id}`,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      },
    });

    _debateSessionDeps.readFile = mock(async (path: string) => `{"proposal":"from ${path}"}`);

    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig;

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

    expect(rebuttalCalls).toHaveLength(2);
    expect(rebuttalCalls[0]?.handleId).toBe("debate-plan-hybrid-0");
    expect(rebuttalCalls[1]?.handleId).toBe("debate-plan-hybrid-1");
    expect(closedHandleIds).toHaveLength(2);
    expect(result.rebuttals).toBeDefined();
    expect(result.rebuttals).toHaveLength(2);
    expect(result.rounds).toBe(1);
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

    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig;

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

    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig;
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

  test("includes spec anchor in synthesis prompt when specContent is provided", async () => {
    let capturedSynthesisPrompt = "";

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

    const specContent = `# My Feature\n## Stories\n### US-001\n**AC:**\n- AC one\n- AC two`;
    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig;

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("spec-anchor-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({
        resolver: { type: "synthesis", agent: "opencode" },
      }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
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
  });

  test("synthesis prompt omits spec anchor when specContent is not provided", async () => {
    let capturedSynthesisPrompt = "";

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

    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig;

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("no-spec-anchor", agentManager, sm, config),
      stage: "plan",
      stageConfig: makePlanStageConfig({
        resolver: { type: "synthesis", agent: "opencode" },
      }),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
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

    const sm = makeSessionManager({
      runInSession: mock(async (_name: string, _prompt: string, opts: any) => {
        const index = Number((opts?.role ?? "").match(/(\d+)$/)?.[1] ?? NaN);
        startedOrder.push(index);
        await new Promise<void>((resolve) => {
          resolvers[index] = resolve;
        });
        return {
          output: "ok",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      }) as any,
      nameFor: mock((req: any) => `nax-${req?.role ?? "unknown"}`),
    });

    _debateSessionDeps.readFile = mock(async () => "{}");

    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig;
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
});
