/**
 * Tests for DebateRunner — US-002
 *
 * File: session-agent-resolution.test.ts
 * Covers:
 * - AC1: resolves debater adapters via getAgent(), calls completeAs() with model override
 * - AC2: parallel proposal round via Promise.allSettled()
 * - AC3: skips debaters with null/undefined adapter, logs warning with stage 'debate'
 * - AC4: fallback to single-agent mode when fewer than 2 debaters succeed
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";
import { waitForCondition } from "../../helpers/timeout";

function makeCallCtx(
  overrides: Partial<CallContext> & { agentManagerOverride?: ReturnType<typeof makeMockAgentManager> } = {},
): CallContext {
  const { agentManagerOverride, ...rest } = overrides;
  const agentManager = agentManagerOverride ?? makeMockAgentManager();
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
    storyId: "US-002",
    featureName: "test",
    ...rest,
  };
}

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "claude-3-5-haiku-20241022" },
      { agent: "opencode", model: "gpt-4o-mini" },
      { agent: "gemini", model: "gemini-flash" },
    ],
    ...overrides,
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
});

// ─── AC1: resolves adapters via createManager(), calls completeAs() with model override ──

describe("DebateRunner.run() — agent resolution", () => {
  test("resolves each debater via manager.getAgent(debater.agent)", async () => {
    const agentCalls: string[] = [];

    const agentManager = makeMockAgentManager({
      getAgentFn: (name: string) => {
        agentCalls.push(name);
        return {} as any;
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    expect(agentCalls).toContain("claude");
    expect(agentCalls).toContain("opencode");
    expect(agentCalls).toContain("gemini");
  });

  test("calls manager.completeAs() for each debater in the panel", async () => {
    const completeCalls: Array<{ agent: string }> = [];

    const agentManager = makeMockAgentManager({
      completeAsFn: async (agentName, _prompt, _opts) => {
        completeCalls.push({ agent: agentName });
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" as const };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    const claudeCall = completeCalls.find((c) => c.agent === "claude");
    const opencodeCall = completeCalls.find((c) => c.agent === "opencode");

    // Model is now resolved via callOp from config, not directly from debater.model
    expect(claudeCall).toBeDefined();
    expect(opencodeCall).toBeDefined();
  });

  test("passes the original prompt to each debater's completeAs() call", async () => {
    const receivedPrompts: string[] = [];

    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, prompt) => {
        receivedPrompts.push(prompt);
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" as const };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("the original task prompt");

    expect(receivedPrompts.every((p) => p.includes("the original task prompt"))).toBe(true);
  });
});

// ─── AC2: parallel proposal round via Promise.allSettled() ────────────────────

describe("DebateRunner.run() — parallel execution", () => {
  test("starts all debater completeAs() calls before any one resolves", async () => {
    const startTimes: number[] = [];
    const resolvers: Array<() => void> = [];

    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => {
        startTimes.push(Date.now());
        await new Promise<void>((resolve) => resolvers.push(resolve));
        return { output: `output from ${name}`, costUsd: 0, source: "fallback" as const };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 1,
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const runPromise = runner.run("test prompt");

    await waitForCondition(() => startTimes.length === 2);
    expect(startTimes.length).toBe(2);

    for (const r of resolvers) r();
    await runPromise;
  });

  test("continues when one debater's completeAs() throws (allSettled semantics)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => {
        if (name === "failing") throw new Error("agent error");
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" as const };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "failing" }, { agent: "opencode" }],
        rounds: 1,
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await expect(runner.run("test prompt")).resolves.toBeDefined();
  });
});

// ─── AC3: skips null agent, logs warning with stage 'debate' ─────────────────

describe("DebateRunner.run() — unavailable agent handling", () => {
  test("skips debaters where manager.getAgent returns undefined", async () => {
    const completeCalls: string[] = [];

    const agentManager = makeMockAgentManager({
      unavailableAgents: new Set(["missing-agent"]),
      completeAsFn: async (name) => {
        completeCalls.push(name);
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" as const };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing-agent" }, { agent: "opencode" }],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    expect(completeCalls).not.toContain("missing-agent");
    expect(completeCalls).toContain("claude");
    expect(completeCalls).toContain("opencode");
  });

  test("logs a warning with stage 'debate' when a debater's agent is not found", async () => {
    const warnings: Array<{ stage: string; message: string }> = [];

    _debateSessionDeps.getSafeLogger = mock(() => ({
      info: () => {},
      debug: () => {},
      warn: (stage: string, message: string) => {
        warnings.push({ stage, message });
      },
      error: () => {},
    })) as unknown as typeof _debateSessionDeps.getSafeLogger;

    const agentManager = makeMockAgentManager({
      unavailableAgents: new Set(["missing-agent"]),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing-agent" }, { agent: "opencode" }],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    const debateWarning = warnings.find((w) => w.stage === "debate");
    expect(debateWarning).toBeDefined();
    expect(debateWarning?.message).toMatch(/missing-agent/);
  });

  test("skips debaters where manager.getAgent returns null", async () => {
    const completeCalls: string[] = [];

    const agentManager = makeMockAgentManager({
      unavailableAgents: new Set(["null-agent"]),
      completeAsFn: async (name) => {
        completeCalls.push(name);
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" as const };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "null-agent" }, { agent: "opencode" }],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    expect(completeCalls).not.toContain("null-agent");
  });
});

// ─── AC4: fallback to single-agent mode ───────────────────────────────────────

describe("DebateRunner.run() — single-agent fallback", () => {
  test("returns the one successful proposal when only 1 debater succeeds", async () => {
    const agentManager = makeMockAgentManager({
      unavailableAgents: new Set(["missing-1", "missing-2"]),
      completeAsFn: async () => ({ output: "the single successful proposal", costUsd: 0, source: "fallback" as const }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing-1" }, { agent: "missing-2" }],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const result = await runner.run("test prompt");

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.output).toBe("the single successful proposal");
  });

  test("result is not 'skipped' when falling back to single-agent", async () => {
    const agentManager = makeMockAgentManager({
      unavailableAgents: new Set(["missing"]),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing" }],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const result = await runner.run("test prompt");

    expect(result.outcome).not.toBe("skipped");
  });

  test("falls back to fresh completeAs() call when all debaters fail", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => {
        throw new Error("simulated failure");
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx({ agentManagerOverride: agentManager, storyId: "US-002" }),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "failing-1" }, { agent: "failing-2" }],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const result = await runner.run("test prompt");
    expect(result).toBeDefined();
    expect(result.storyId).toBe("US-002");
  });
});
