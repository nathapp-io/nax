import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { DebateStageConfig } from "../../../src/debate/types";

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
} as NaxConfig;

describe("DebateSession.runPlan()", () => {
  let origGetAgent: typeof _debateSessionDeps.getAgent;
  let origReadFile: typeof _debateSessionDeps.readFile;

  beforeEach(() => {
    origGetAgent = _debateSessionDeps.getAgent;
    origReadFile = _debateSessionDeps.readFile;
  });

  afterEach(() => {
    _debateSessionDeps.getAgent = origGetAgent;
    _debateSessionDeps.readFile = origReadFile;
  });

  test("passes unique indexed sessionRole to each plan debater", async () => {
    const planCalls: Array<{ sessionRole?: string; storyId?: string }> = [];

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      }),
      buildCommand: () => [],
      plan: async (options: { sessionRole?: string; storyId?: string }) => {
        planCalls.push({ sessionRole: options.sessionRole, storyId: options.storyId });
        return { specContent: "ok" };
      },
      decompose: async () => ({ stories: [] }),
      complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    }));

    _debateSessionDeps.readFile = mock(async (path: string) => `output:${path}`);

    const session = new DebateSession({
      storyId: "config-ssot",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "opencode" }, { agent: "opencode" }, { agent: "opencode" }],
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } },
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

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      }),
      buildCommand: () => [],
      plan: async (options: { storyId?: string }) => {
        storyIds.push(options.storyId ?? "");
        return { specContent: "ok" };
      },
      decompose: async () => ({ stories: [] }),
      complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    }));

    _debateSessionDeps.readFile = mock(async () => "{}");

    const session = new DebateSession({
      storyId: "config-ssot",
      stage: "plan",
      stageConfig: makeStageConfig(),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } },
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

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async (options: { prompt?: string; sessionRole?: string; keepOpen?: boolean }) => {
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
        };
      },
      buildCommand: () => [],
      plan: async (options: { sessionRole?: string }) => {
        return { specContent: "ok" };
      },
      decompose: async () => ({ stories: [] }),
      complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    }));

    _debateSessionDeps.readFile = mock(async (path: string) => `{"proposal":"from ${path}"}`);

    const session = new DebateSession({
      storyId: "plan-hybrid-test",
      stage: "plan",
      stageConfig: makeStageConfig({
        mode: "hybrid",
        sessionMode: "stateful",
        rounds: 1,
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } },
    });

    const result = await session.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "plan-hybrid-test",
      outputDir: "/tmp/out",
    });

    // Rebuttal calls should use adapter.run() with plan-hybrid-{idx} session roles
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

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async (options: { prompt?: string }) => {
        runCalls.push({ prompt: options.prompt ?? "" });
        return {
          success: true,
          exitCode: 0,
          output: "run-output",
          rateLimited: false,
          durationMs: 1,
          estimatedCost: 0,
        };
      },
      buildCommand: () => [],
      plan: async () => {
        return { specContent: "ok" };
      },
      decompose: async () => ({ stories: [] }),
      complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    }));

    _debateSessionDeps.readFile = mock(async () => "{}");

    const session = new DebateSession({
      storyId: "plan-panel-test",
      stage: "plan",
      stageConfig: makeStageConfig(), // defaults to panel mode
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } },
    });

    const result = await session.runPlan("task context", "output format", {
      workdir: "/tmp/workdir",
      feature: "plan-panel-test",
      outputDir: "/tmp/out",
    });

    // No adapter.run() calls should happen in panel mode
    expect(runCalls).toHaveLength(0);
    expect(result.rebuttals).toBeUndefined();
    expect(result.rounds).toBe(1);
  });

  test("warns and skips rebuttal when mode=hybrid but sessionMode=one-shot", async () => {
    const warnings: string[] = [];
    const origLogger = _debateSessionDeps.getSafeLogger;
    _debateSessionDeps.getSafeLogger = mock(
      () =>
        ({
          warn: (_stage: string, msg: string) => warnings.push(msg),
          info: () => {},
          debug: () => {},
          error: () => {},
        }) as ReturnType<typeof _debateSessionDeps.getSafeLogger>,
    );

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      }),
      buildCommand: () => [],
      plan: async () => ({ specContent: "ok" }),
      decompose: async () => ({ stories: [] }),
      complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    }));

    _debateSessionDeps.readFile = mock(async () => "{}");

    const session = new DebateSession({
      storyId: "plan-hybrid-oneshot",
      stage: "plan",
      stageConfig: makeStageConfig({
        mode: "hybrid",
        sessionMode: "one-shot",
        rounds: 2,
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } },
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

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      }),
      buildCommand: () => [],
      plan: async () => ({ specContent: "ok" }),
      decompose: async () => ({ stories: [] }),
      complete: async (prompt: string) => {
        capturedSynthesisPrompt = prompt;
        return { output: '{"userStories":[]}', costUsd: 0, source: "fallback" as const };
      },
    }));

    _debateSessionDeps.readFile = mock(async () => '{"userStories":[]}');

    const specContent = `# My Feature\n## Stories\n### US-001\n**AC:**\n- AC one\n- AC two`;

    const session = new DebateSession({
      storyId: "spec-anchor-test",
      stage: "plan",
      stageConfig: makeStageConfig({
        resolver: { type: "synthesis", agent: "opencode" },
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } },
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

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      }),
      buildCommand: () => [],
      plan: async () => ({ specContent: "ok" }),
      decompose: async () => ({ stories: [] }),
      complete: async (prompt: string) => {
        capturedSynthesisPrompt = prompt;
        return { output: '{"userStories":[]}', costUsd: 0, source: "fallback" as const };
      },
    }));

    _debateSessionDeps.readFile = mock(async () => '{"userStories":[]}');

    const session = new DebateSession({
      storyId: "no-spec-anchor",
      stage: "plan",
      stageConfig: makeStageConfig({
        resolver: { type: "synthesis", agent: "opencode" },
      }),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } },
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

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      }),
      buildCommand: () => [],
      plan: async (options: { sessionRole?: string }) => {
        const index = Number((options.sessionRole ?? "").replace("plan-", ""));
        startedOrder.push(index);
        await new Promise<void>((resolve) => {
          resolvers[index] = resolve;
        });
        return { specContent: "ok" };
      },
      decompose: async () => ({ stories: [] }),
      complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    }));

    _debateSessionDeps.readFile = mock(async () => "{}");

    const session = new DebateSession({
      storyId: "config-ssot",
      stage: "plan",
      stageConfig: makeStageConfig(),
      config: { ...TEST_CONFIG, debate: { enabled: true, agents: 2, maxConcurrentDebaters: 2 } },
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
