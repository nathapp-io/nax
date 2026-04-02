import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { DebateStageConfig } from "../../../src/debate/types";

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
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

    await session.runPlan("base prompt", {
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

    await session.runPlan("base prompt", {
      workdir: "/tmp/workdir",
      feature: "config-ssot",
      outputDir: "/tmp/out",
    });

    expect(storyIds).toEqual(["config-ssot", "config-ssot"]);
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

    const runPromise = session.runPlan("base prompt", {
      workdir: "/tmp/workdir",
      feature: "config-ssot",
      outputDir: "/tmp/out",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // Verify parallel execution (both started)
    expect(startedOrder).toEqual([0, 1]);

    resolvers[0]?.();
    resolvers[1]?.();
    await runPromise;
  });
});