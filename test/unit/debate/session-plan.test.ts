import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { AgentRunRequest } from "../../../src/agents";
import type { AgentRunOptions, CompleteOptions, CompleteResult, PlanOptions, PlanResult } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import { makeMockAgentManager } from "../../helpers";

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

function makeMockManager(options: {
  planFn?: (agentName: string, opts: PlanOptions) => Promise<PlanResult>;
  runFn?: (agentName: string, opts: AgentRunOptions) => Promise<{ success: boolean; exitCode: number; output: string; rateLimited: boolean; durationMs: number; estimatedCost: number; agentFallbacks: any[] }>;
  completeFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
  unavailableAgents?: Set<string>;
} = {}): IAgentManager {
  const unavailable = options.unavailableAgents ?? new Set<string>();
  return {
    getAgent: (name: string) => unavailable.has(name) ? undefined : ({} as any),
    getDefault: () => "opencode",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    events: { on: () => {} } as any,
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async (_req: AgentRunRequest) => ({
      result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] },
      fallbacks: [],
    }),
    completeWithFallback: async () => ({ result: { output: "", costUsd: 0, source: "fallback" }, fallbacks: [] }),
    run: async (_req: AgentRunRequest) => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }),
    complete: async () => ({ output: "", costUsd: 0, source: "fallback" }),
    completeAs: options.completeFn
      ? async (name, prompt, opts) => options.completeFn!(name, prompt, opts)
      : async () => ({ output: "", costUsd: 0, source: "fallback" }),
    runAs: options.runFn
      ? async (agentName: string, request: AgentRunRequest) => options.runFn!(agentName, request.runOptions)
      : async (_name: string, _request: AgentRunRequest) => ({
          success: true,
          exitCode: 0,
          output: "",
          rateLimited: false,
          durationMs: 0,
          estimatedCost: 0,
          agentFallbacks: [],
        }),
    plan: async () => ({ specContent: "" }),
    planAs: options.planFn
      ? async (agentName: string, opts: PlanOptions) => options.planFn!(agentName, opts)
      : async () => ({ specContent: "ok" }),
    decompose: async () => ({ stories: [] }),
    decomposeAs: async () => ({ stories: [] }),
  } as any;
}

describe("DebateSession.runPlan()", () => {
  let origCreateManager: typeof _debateSessionDeps.createManager;
  let origReadFile: typeof _debateSessionDeps.readFile;

  beforeEach(() => {
    origCreateManager = _debateSessionDeps.createManager;
    origReadFile = _debateSessionDeps.readFile;
  });

  afterEach(() => {
    _debateSessionDeps.createManager = origCreateManager;
    _debateSessionDeps.readFile = origReadFile;
  });

  test("passes unique indexed sessionRole to each plan debater", async () => {
    const planCalls: Array<{ sessionRole?: string; storyId?: string }> = [];

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockAgentManager({
        planFn: async (_agentName, options) => {
          planCalls.push({ sessionRole: options.sessionRole, storyId: options.storyId });
          return { specContent: "ok" };
        },
      }),
    );

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

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockAgentManager({
        planFn: async (_agentName, options) => {
          storyIds.push(options.storyId ?? "");
          return { specContent: "ok" };
        },
      }),
    );

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
    const runCalls: Array<{ prompt: string; sessionRole?: string; keepOpen?: boolean }> = [];

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockAgentManager({
        planFn: async () => ({ specContent: "ok" }),
        runFn: async (_agentName, options) => {
          runCalls.push({
            prompt: options.prompt ?? "",
            sessionRole: options.sessionRole,
            keepOpen: options.keepOpen,
          });
          return {
            success: true,
            exitCode: 0,
            output: `run-output-${options.sessionRole}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.05,
            agentFallbacks: [],
          };
        },
      }),
    );

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
    });

    const result = await session.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "plan-hybrid-test",
      outputDir: "/tmp/out",
    });

    // Rebuttal calls should use manager.runAs() with plan-hybrid-{idx} session roles
    const rebuttalCalls = runCalls.filter(
      (c) => c.prompt.includes("You are debater") && c.prompt.includes("## Your Task"),
    );
    expect(rebuttalCalls).toHaveLength(2);
    expect(rebuttalCalls[0]?.sessionRole).toBe("plan-hybrid-0");
    expect(rebuttalCalls[1]?.sessionRole).toBe("plan-hybrid-1");

    // Session close calls
    const closeCalls = runCalls.filter((c) => c.prompt === "Close this debate session.");
    expect(closeCalls).toHaveLength(2);

    // Result should include rebuttals and correct round count
    expect(result.rebuttals).toBeDefined();
    expect(result.rebuttals).toHaveLength(2);
    expect(result.rounds).toBe(1);
  });

  test("skips rebuttal loop when mode is panel (default)", async () => {
    const runCalls: Array<{ prompt: string }> = [];

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockAgentManager({
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
      }),
    );

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

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockAgentManager({
        planFn: async () => ({ specContent: "ok" }),
      }),
    );

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

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockAgentManager({
        planFn: async () => ({ specContent: "ok" }),
        completeFn: async (_agentName, prompt) => {
          capturedSynthesisPrompt = prompt;
          return { output: '{"userStories":[]}', costUsd: 0, source: "fallback" as const };
        },
      }),
    );

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

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockAgentManager({
        planFn: async () => ({ specContent: "ok" }),
        completeFn: async (_agentName, prompt) => {
          capturedSynthesisPrompt = prompt;
          return { output: '{"userStories":[]}', costUsd: 0, source: "fallback" as const };
        },
      }),
    );

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

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockAgentManager({
        planFn: async (_agentName, options) => {
          const index = Number((options.sessionRole ?? "").replace("plan-", ""));
          startedOrder.push(index);
          await new Promise<void>((resolve) => {
            resolvers[index] = resolve;
          });
          return { specContent: "ok" };
        },
      }),
    );

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
