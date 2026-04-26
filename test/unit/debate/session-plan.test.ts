import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { CallContext } from "../../../src/operations/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    mode: "panel",
    rounds: 1,
    debaters: [{ agent: "opencode" }, { agent: "opencode" }],
    timeoutSeconds: 60,
    ...overrides,
  };
}

const TEST_CONFIG = {
  autoMode: { defaultAgent: "opencode" },
} as unknown as NaxConfig;

function makeCallCtx(
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

describe("DebateRunner.runPlan()", () => {
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
  });

  afterEach(() => {
    _debateSessionDeps.getSafeLogger = origGetSafeLogger;
    _debateSessionDeps.readFile = origReadFile;
    mock.restore();
  });

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
      ctx: makeCallCtx("config-ssot", agentManager, sm, config),
      stage: "plan",
      stageConfig: makeStageConfig({
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
    expect(sessionRoles[0]).toBe("plan-0");
    expect(sessionRoles[1]).toBe("plan-1");
    expect(sessionRoles[2]).toBe("plan-2");
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
      ctx: makeCallCtx("config-ssot", agentManager, sm, config),
      stage: "plan",
      stageConfig: makeStageConfig(),
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
      ctx: makeCallCtx("plan-hybrid-test", agentManager, mockSM, config),
      stage: "plan",
      stageConfig: makeStageConfig({
        mode: "hybrid",
        sessionMode: "stateful",
        rounds: 1,
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

    // Rebuttal calls should use runAsSession with plan-hybrid-{idx} handle IDs
    expect(rebuttalCalls).toHaveLength(2);
    expect(rebuttalCalls[0]?.handleId).toBe("plan-hybrid-0");
    expect(rebuttalCalls[1]?.handleId).toBe("plan-hybrid-1");

    // Session close calls via sessionManager.closeSession
    expect(closedHandleIds).toHaveLength(2);

    // Result should include rebuttals and correct round count
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
      ctx: makeCallCtx("plan-panel-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makeStageConfig(), // defaults to panel mode
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "plan-panel-test",
      outputDir: "/tmp/out",
    });

    // No runAsSession calls in panel mode (rebuttal loop is skipped)
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
      ctx: makeCallCtx("plan-hybrid-oneshot", agentManager, sm, config),
      stage: "plan",
      stageConfig: makeStageConfig({
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
        return { output: '{"userStories":[]}', costUsd: 0, source: "fallback" as const };
      },
    });

    _debateSessionDeps.readFile = mock(async () => '{"userStories":[]}');

    const specContent = `# My Feature\n## Stories\n### US-001\n**AC:**\n- AC one\n- AC two`;

    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig;

    const runner = new DebateRunner({
      ctx: makeCallCtx("spec-anchor-test", agentManager, sm, config),
      stage: "plan",
      stageConfig: makeStageConfig({
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

    // Synthesis prompt should contain the spec anchor
    expect(capturedSynthesisPrompt).toContain("## Original Spec");
    expect(capturedSynthesisPrompt).toContain("AC one");
    expect(capturedSynthesisPrompt).toContain("AC two");
    // Should contain anchoring instruction
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
        return { output: '{"userStories":[]}', costUsd: 0, source: "fallback" as const };
      },
    });

    _debateSessionDeps.readFile = mock(async () => '{"userStories":[]}');

    const config = { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig;

    const runner = new DebateRunner({
      ctx: makeCallCtx("no-spec-anchor", agentManager, sm, config),
      stage: "plan",
      stageConfig: makeStageConfig({
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
      // no specContent
    });

    // Should NOT contain spec anchor section
    expect(capturedSynthesisPrompt).not.toContain("## Original Spec");
    expect(capturedSynthesisPrompt).not.toContain("suggestedCriteria");
  });

  test("runs plan debaters in parallel (when limit >= agents)", async () => {
    const startedOrder: number[] = [];
    const resolvers: Array<() => void> = [];

    const sm = makeSessionManager({
      runInSession: mock(async (_name: string, _prompt: string, opts: any) => {
        const index = Number((opts?.role ?? "").replace("plan-", ""));
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
      ctx: makeCallCtx("config-ssot", agentManager, sm, config),
      stage: "plan",
      stageConfig: makeStageConfig(),
      config,
      workdir: "/tmp/workdir",
      sessionManager: sm,
    });

    const runPromise = runner.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "config-ssot",
      outputDir: "/tmp/out",
    });

    // Wait for both plan debaters to start
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
