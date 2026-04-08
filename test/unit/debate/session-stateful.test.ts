import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { AgentAdapter, AgentRunOptions, CompleteOptions, CompleteResult } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import { buildSessionName } from "../../../src/agents/acp/adapter";

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

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "stateful",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "balanced" },
    ],
    ...overrides,
  };
}

let origGetAgent: typeof _debateSessionDeps.getAgent;

beforeEach(() => {
  origGetAgent = _debateSessionDeps.getAgent;
});

afterEach(() => {
  _debateSessionDeps.getAgent = origGetAgent;
  mock.restore();
});

describe("DebateSession.run() — stateful mode uses adapter.run SSOT", () => {
  test("proposal round calls adapter.run for each debater with stable sessionRole", async () => {
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
            estimatedCost: 0.1,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat-a",
      timeoutSeconds: 120,
    });

    await session.run("test prompt");

    expect(runCalls.length).toBe(2);
    expect(runCalls[0].sessionRole).toBe("debate-plan-0");
    expect(runCalls[1].sessionRole).toBe("debate-plan-1");
    expect(runCalls[0].storyId).toBe("US-003");
    expect(runCalls[0].featureName).toBe("feat-a");
    expect(runCalls[0].workdir).toBe("/tmp/work");
    expect(runCalls[0].keepSessionOpen).toBe(false);
    expect(runCalls[0].modelDef.model).not.toBe("fast");
    expect(runCalls[1].modelDef.model).not.toBe("balanced");
  });

  test("uses explicit non-tier debater model override for modelDef", async () => {
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
            estimatedCost: 0.1,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-003b",
      stage: "plan",
      stageConfig: makeStageConfig({
        rounds: 1,
        debaters: [
          { agent: "claude", model: "claude-sonnet-4-5-20250514" },
          { agent: "opencode", model: "balanced" },
        ],
      }),
      workdir: "/tmp/work",
      featureName: "feat-a",
    });

    await session.run("test prompt");

    expect(runCalls[0].modelDef.model).toBe("claude-sonnet-4-5-20250514");
  });

  test("rounds > 1 keeps proposal session open and reuses same role in critique", async () => {
    const runCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          runCalls.push(opts);
          return {
            success: true,
            exitCode: 0,
            output: opts.prompt.includes("Critique") ? `critique-${name}` : `proposal-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.1,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004",
      stage: "review",
      stageConfig: makeStageConfig({ rounds: 2 }),
      workdir: "/tmp/work",
      featureName: "feat-b",
      timeoutSeconds: 120,
    });

    await session.run("review prompt");

    expect(runCalls.length).toBe(4);
    expect(runCalls[0].keepSessionOpen).toBe(true);
    expect(runCalls[1].keepSessionOpen).toBe(true);
    expect(runCalls[2].keepSessionOpen).toBe(false);
    expect(runCalls[3].keepSessionOpen).toBe(false);
    expect(runCalls[2].sessionRole).toBe("debate-review-0");
    expect(runCalls[3].sessionRole).toBe("debate-review-1");
  });

  test("falls back to single-agent passed when only one proposal run succeeds", async () => {
    const runCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          runCalls.push(opts);
          if (opts.prompt === "Close this debate session.") {
            return {
              success: true,
              exitCode: 0,
              output: "closed",
              rateLimited: false,
              durationMs: 1,
              estimatedCost: 0.05,
            };
          }
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
            estimatedCost: 0.1,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-005",
      stage: "review",
      stageConfig: makeStageConfig({ rounds: 2 }),
      workdir: "/tmp/work",
      featureName: "feat-c",
    });

    const result = await session.run("review prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
    expect(runCalls.some((c) => c.prompt === "Close this debate session." && c.keepSessionOpen === false)).toBe(true);
  });
});

// ─── AC4: call site passes ctx.workdir and ctx.featureName to resolveOutcome ──

describe("runStateful() — resolveOutcome receives workdir and featureName (US-004 AC4)", () => {
  test("synthesis resolver receives sessionName built from ctx.workdir and ctx.featureName", async () => {
    const completeCalls: { opts?: CompleteOptions }[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (_opts) => ({
          success: true,
          exitCode: 0,
          output: '{"passed": true}',
          rateLimited: false,
          durationMs: 1,
          estimatedCost: 0.05,
        }),
        completeFn: async (_prompt: string, opts?: CompleteOptions) => {
          completeCalls.push({ opts });
          return { output: "synthesis resolved", costUsd: 0.01, source: "exact" as const };
        },
      }),
    );

    const workdir = "/tmp/stateful-work";
    const featureName = "stateful-feature";
    const storyId = "US-004-stateful";

    const session = new DebateSession({
      storyId,
      stage: "review",
      stageConfig: makeStageConfig({ resolver: { type: "synthesis" }, rounds: 1 }),
      workdir,
      featureName,
      timeoutSeconds: 60,
    });

    await session.run("review prompt");

    // The synthesis resolver's complete() should have been called with the synthesis sessionName.
    const synthesisCall = completeCalls.find((c) => c.opts !== undefined);
    expect(synthesisCall).toBeDefined();
    const expectedSessionName = buildSessionName(workdir, featureName, storyId, "synthesis");
    expect(synthesisCall?.opts?.sessionName).toBe(expectedSessionName);
  });
});

describe("DebateSession.run() — one-shot mode unchanged", () => {
  test("one-shot does not use adapter.run for proposal path", async () => {
    let runCount = 0;
    let completeCount = 0;

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (_opts) => {
          runCount += 1;
          return {
            success: true,
            exitCode: 0,
            output: `run-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.1,
          };
        },
        completeFn: async () => {
          completeCount += 1;
          return { output: '{"passed": true}', costUsd: 0.1, source: "exact" };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-006",
      stage: "plan",
      stageConfig: makeStageConfig({ sessionMode: "one-shot", rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat-d",
    });

    await session.run("plan prompt");

    expect(runCount).toBe(0);
    expect(completeCount).toBeGreaterThan(0);
  });
});
