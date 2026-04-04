import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { AgentAdapter, AgentRunOptions, CompleteOptions, CompleteResult } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockAdapter(
  name: string,
  options: {
    runFn?: (opts: AgentRunOptions) => Promise<ReturnType<AgentAdapter["run"]> extends Promise<infer R> ? R : never>;
    completeFn?: (prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
  } = {},
): AgentAdapter {
  return {
    name,
    displayName: name,
    binary: name,
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"],
      maxContextTokens: 100_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    },
    isInstalled: async () => true,
    run:
      options.runFn ??
      (async () => ({
        success: true,
        exitCode: 0,
        output: `output from ${name}`,
        rateLimited: false,
        durationMs: 1,
        estimatedCost: 0.01,
      })),
    buildCommand: () => [],
    buildAllowedEnv: () => ({}),
    plan: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    complete: options.completeFn ?? (async () => ({ output: "", costUsd: 0, source: "fallback" })),
  };
}

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

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let origGetAgent: typeof _debateSessionDeps.getAgent;
let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetAgent = _debateSessionDeps.getAgent;
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => undefined);
});

afterEach(() => {
  _debateSessionDeps.getAgent = origGetAgent;
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

// ─── AC1: sessionRole is 'debate-hybrid-{debaterIndex}' (0-based) ────────────

describe("runHybrid() — sessionRole for proposal calls (AC1)", () => {
  test("debater 0 gets sessionRole 'debate-hybrid-0' and debater 1 gets 'debate-hybrid-1'", async () => {
    const runCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          runCalls.push(opts);
          return {
            success: true,
            exitCode: 0,
            output: `proposal-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-A-role",
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    const proposalCalls = runCalls.filter((c) => c.prompt === "test prompt");
    expect(proposalCalls.length).toBe(2);
    const roles = proposalCalls.map((c) => c.sessionRole).sort();
    expect(roles).toContain("debate-hybrid-0");
    expect(roles).toContain("debate-hybrid-1");
  });

  test("sessionRole index matches debater position in the debaters array (3 debaters)", async () => {
    const runCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          runCalls.push(opts);
          return {
            success: true,
            exitCode: 0,
            output: `proposal-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-A-role-3",
      stage: "run",
      stageConfig: makeHybridStageConfig({
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    const proposalCalls = runCalls.filter((c) => c.prompt === "test prompt");
    expect(proposalCalls.length).toBe(3);
    const roles = proposalCalls.map((c) => c.sessionRole).sort();
    expect(roles).toContain("debate-hybrid-0");
    expect(roles).toContain("debate-hybrid-1");
    expect(roles).toContain("debate-hybrid-2");
  });
});

// ─── AC3: every proposal call uses keepSessionOpen: true ─────────────────────

describe("runHybrid() — keepSessionOpen for proposal calls (AC3)", () => {
  test("all proposal run() calls have keepSessionOpen: true", async () => {
    const runCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          runCalls.push(opts);
          return {
            success: true,
            exitCode: 0,
            output: `proposal-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-A-ksopen",
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    const proposalCalls = runCalls.filter((c) => c.prompt === "test prompt");
    expect(proposalCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of proposalCalls) {
      expect(call.keepSessionOpen).toBe(true);
    }
  });
});

// ─── AC2: parallel via allSettledBounded respecting maxConcurrentDebaters ────

describe("runHybrid() — parallel proposals via allSettledBounded (AC2)", () => {
  test("all debaters are invoked in the proposal round", async () => {
    const invoked: string[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async () => {
          invoked.push(name);
          return {
            success: true,
            exitCode: 0,
            output: `proposal-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-A-parallel",
      stage: "run",
      stageConfig: makeHybridStageConfig({
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(invoked).toContain("claude");
    expect(invoked).toContain("opencode");
    expect(invoked).toContain("gemini");
  });

  test("maxConcurrentDebaters: 1 still runs all proposals (sequentially)", async () => {
    const runCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          runCalls.push(opts);
          return {
            success: true,
            exitCode: 0,
            output: `proposal-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-A-concurrency",
      stage: "run",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { debate: { maxConcurrentDebaters: 1 } } as any,
      stageConfig: makeHybridStageConfig(),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(runCalls.filter((c) => c.prompt === "test prompt").length).toBe(2);
  });
});

// ─── AC4: fallback when fewer than 2 proposals succeed ───────────────────────

describe("runHybrid() — single-agent fallback when fewer than 2 proposals succeed (AC4)", () => {
  test("returns outcome=passed with single debater when exactly 1 proposal succeeds", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async () => {
          if (name === "opencode") {
            return {
              success: false,
              exitCode: 1,
              output: "failed",
              rateLimited: false,
              durationMs: 1,
              estimatedCost: 0,
            };
          }
          return {
            success: true,
            exitCode: 0,
            output: `proposal-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-A-fallback-1",
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    const result = await session.run("test prompt");

    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
    expect(result.rounds).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].output).toBe("proposal-claude");
  });

  test("returns outcome=failed when 0 proposals succeed and fallback retry also fails", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async () => ({
          success: false,
          exitCode: 1,
          output: "error",
          rateLimited: false,
          durationMs: 1,
          estimatedCost: 0,
        }),
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-A-fallback-0",
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    const result = await session.run("test prompt");

    expect(result.outcome).toBe("failed");
    expect(result.debaters).toEqual([]);
  });
});

// ─── AC5: successful proposal outputs collected ───────────────────────────────

describe("runHybrid() — successful proposal outputs collected (AC5)", () => {
  test("both proposal outputs appear in result.proposals when 2 proposals succeed", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async () => ({
          success: true,
          exitCode: 0,
          output: `proposal-from-${name}`,
          rateLimited: false,
          durationMs: 1,
          estimatedCost: 0.01,
        }),
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-A-proposals",
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    const result = await session.run("test prompt");

    expect(result.proposals).toHaveLength(2);
    const outputs = result.proposals.map((p) => p.output);
    expect(outputs).toContain("proposal-from-claude");
    expect(outputs).toContain("proposal-from-opencode");
  });
});

// ─── AC6: adapters resolved via _debateSessionDeps.getAgent ──────────────────

describe("runHybrid() — adapter resolution via shared helper (AC6)", () => {
  test("_debateSessionDeps.getAgent is called for each debater to resolve adapters", async () => {
    const agentCalls: string[] = [];

    _debateSessionDeps.getAgent = mock((name: string) => {
      agentCalls.push(name);
      return makeMockAdapter(name);
    });

    const session = new DebateSession({
      storyId: "US-004-A-dep-calls",
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(agentCalls).toContain("claude");
    expect(agentCalls).toContain("opencode");
  });

  test("debater is skipped when _debateSessionDeps.getAgent returns undefined — triggers single-agent fallback", async () => {
    _debateSessionDeps.getAgent = mock((name: string) => {
      if (name === "opencode") return undefined;
      return makeMockAdapter(name);
    });

    const session = new DebateSession({
      storyId: "US-004-A-helper-skip",
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
    });

    const result = await session.run("test prompt");

    // Only 1 adapter resolved → falls back to single-agent
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
  });
});
