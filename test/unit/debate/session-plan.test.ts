import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { AgentRunRequest } from "../../../src/agents";
import type { AgentRunOptions, CompleteOptions, CompleteResult, PlanOptions, PlanResult } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

async function waitForStartedPlans(
  startedOrder: number[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (startedOrder.length >= expectedCount) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error(`Expected ${expectedCount} started plans, got ${startedOrder.length}`);
}

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

describe("DebateSession.runPlan()", () => {
  let origAgentManager: typeof _debateSessionDeps.agentManager;
  let origReadFile: typeof _debateSessionDeps.readFile;

  beforeEach(() => {
    origAgentManager = _debateSessionDeps.agentManager;
    origReadFile = _debateSessionDeps.readFile;
  });

  afterEach(() => {
    _debateSessionDeps.agentManager = origAgentManager;
    _debateSessionDeps.readFile = origReadFile;
  });

  test("passes unique indexed sessionRole to each plan debater", async () => {
    const planCalls: Array<{ sessionRole?: string; storyId?: string }> = [];

    _debateSessionDeps.agentManager = makeMockAgentManager({
      planFn: async (_agentName, options) => {
        planCalls.push({ sessionRole: options.sessionRole, storyId: options.storyId });
        return { specContent: "ok" };
      },
    });

    _debateSessionDeps.readFile = mock(async (path: string) => `output:${path}`);

    const session = new DebateSession({
      storyId: "config-ssot",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "opencode" }, { agent: "opencode" }, { agent: "opencode" }],
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig,
    });

    await session.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "config-ssot",
      outputDir: "/tmp/out",
    });

    expect(planCalls).toHaveLength(3);
    expect(planCalls[0]?.sessionRole).toBe("plan-0");
    expect(planCalls[1]?.sessionRole).toBe("plan-1");
    expect(planCalls[2]?.sessionRole).toBe("plan-2");
  });

  test("passes storyId through to each plan debater call", async () => {
    const storyIds: string[] = [];

    _debateSessionDeps.agentManager = makeMockAgentManager({
      planFn: async (_agentName, options) => {
        storyIds.push(options.storyId ?? "");
        return { specContent: "ok" };
      },
    });

    _debateSessionDeps.readFile = mock(async () => "{}");

    const session = new DebateSession({
      storyId: "config-ssot",
      stage: "plan",
      stageConfig: makeStageConfig(),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig,
    });

    await session.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "config-ssot",
      outputDir: "/tmp/out",
    });

    expect(storyIds).toEqual(["config-ssot", "config-ssot"]);
  });

  test("runs hybrid rebuttal loop when mode=hybrid and sessionMode=stateful", async () => {
    const rebuttalCalls: Array<{ prompt: string; handleId: string }> = [];
    const closedHandleIds: string[] = [];

    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "opencode" })),
      closeSession: mock(async (handle) => { closedHandleIds.push(handle.id); }),
      nameFor: mock((req) => req.role ?? ""),
    });

    _debateSessionDeps.agentManager = makeMockAgentManager({
      planFn: async () => ({ specContent: "ok" }),
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

    const session = new DebateSession({
      storyId: "plan-hybrid-test",
      stage: "plan",
      stageConfig: makeStageConfig({
        mode: "hybrid",
        sessionMode: "stateful",
        rounds: 1,
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig,
      sessionManager: mockSM,
    });

    const result = await session.runPlan("task context", "output format", {
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
    const runCalls: Array<{ prompt: string }> = [];

    _debateSessionDeps.agentManager = makeMockAgentManager({
      planFn: async () => ({ specContent: "ok" }),
      runFn: async (_agentName, options) => {
        runCalls.push({ prompt: options.prompt ?? "" });
        return {
          success: true,
          exitCode: 0,
          output: "run-output",
          rateLimited: false,
          durationMs: 1,
          estimatedCost: 0,
          agentFallbacks: [],
        };
      },
    });

    _debateSessionDeps.readFile = mock(async () => "{}");

    const session = new DebateSession({
      storyId: "plan-panel-test",
      stage: "plan",
      stageConfig: makeStageConfig(), // defaults to panel mode
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig,
    });

    const result = await session.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "plan-panel-test",
      outputDir: "/tmp/out",
    });

    // No manager.runAs() calls should happen in panel mode
    expect(runCalls).toHaveLength(0);
    expect(result.rebuttals).toBeUndefined();
    expect(result.rounds).toBe(1);
  });

  test("warns and skips rebuttal when mode=hybrid but sessionMode=one-shot", async () => {
    const warnings: string[] = [];
    const origLogger = _debateSessionDeps.getSafeLogger;
    _debateSessionDeps.getSafeLogger = mock(() => ({
      warn: (_stage: string, msg: string) => warnings.push(msg),
      info: () => {},
      debug: () => {},
      error: () => {},
    })) as unknown as typeof _debateSessionDeps.getSafeLogger;

    _debateSessionDeps.agentManager = makeMockAgentManager({
      planFn: async () => ({ specContent: "ok" }),
    });

    _debateSessionDeps.readFile = mock(async () => "{}");

    const session = new DebateSession({
      storyId: "plan-hybrid-oneshot",
      stage: "plan",
      stageConfig: makeStageConfig({
        mode: "hybrid",
        sessionMode: "one-shot",
        rounds: 2,
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig,
    });

    const result = await session.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "plan-hybrid-oneshot",
      outputDir: "/tmp/out",
    });

    expect(warnings.some((w) => w.includes("hybrid") && w.includes("stateful"))).toBe(true);
    expect(result.rebuttals).toBeUndefined();
    expect(result.rounds).toBe(1);

    _debateSessionDeps.getSafeLogger = origLogger;
  });

  test("includes spec anchor in synthesis prompt when specContent is provided", async () => {
    let capturedSynthesisPrompt = "";

    _debateSessionDeps.agentManager = makeMockAgentManager({
      planFn: async () => ({ specContent: "ok" }),
      completeFn: async (_agentName, prompt) => {
        capturedSynthesisPrompt = prompt;
        return { output: '{"userStories":[]}', costUsd: 0, source: "fallback" as const };
      },
    });

    _debateSessionDeps.readFile = mock(async () => '{"userStories":[]}');

    const specContent = `# My Feature\n## Stories\n### US-001\n**AC:**\n- AC one\n- AC two`;

    const session = new DebateSession({
      storyId: "spec-anchor-test",
      stage: "plan",
      stageConfig: makeStageConfig({
        resolver: { type: "synthesis", agent: "opencode" },
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig,
    });

    await session.runPlan("task context", "output format", {
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

    _debateSessionDeps.agentManager = makeMockAgentManager({
      planFn: async () => ({ specContent: "ok" }),
      completeFn: async (_agentName, prompt) => {
        capturedSynthesisPrompt = prompt;
        return { output: '{"userStories":[]}', costUsd: 0, source: "fallback" as const };
      },
    });

    _debateSessionDeps.readFile = mock(async () => '{"userStories":[]}');

    const session = new DebateSession({
      storyId: "no-spec-anchor",
      stage: "plan",
      stageConfig: makeStageConfig({
        resolver: { type: "synthesis", agent: "opencode" },
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig,
    });

    await session.runPlan("task context", "output format", {
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

    _debateSessionDeps.agentManager = makeMockAgentManager({
      planFn: async (_agentName, options) => {
        const index = Number((options.sessionRole ?? "").replace("plan-", ""));
        startedOrder.push(index);
        await new Promise<void>((resolve) => {
          resolvers[index] = resolve;
        });
        return { specContent: "ok" };
      },
    });

    _debateSessionDeps.readFile = mock(async () => "{}");

    const session = new DebateSession({
      storyId: "config-ssot",
      stage: "plan",
      stageConfig: makeStageConfig(),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } } as unknown as NaxConfig,
    });

    const runPromise = session.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "config-ssot",
      outputDir: "/tmp/out",
    });

    await waitForStartedPlans(startedOrder, 2);
    expect(startedOrder).toEqual([0, 1]);

    resolvers[0]?.();
    resolvers[1]?.();
    await runPromise;
  });
});
