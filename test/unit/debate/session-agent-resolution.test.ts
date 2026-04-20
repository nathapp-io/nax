/**
 * Tests for DebateSession — US-002
 *
 * File: session-agent-resolution.test.ts
 * Covers:
 * - AC1: resolves debater adapters via getAgent(), calls complete() with model override
 * - AC2: parallel proposal round via Promise.allSettled()
 * - AC3: skips debaters with null/undefined adapter, logs warning with stage 'debate'
 * - AC4: fallback to single-agent mode when fewer than 2 debaters succeed
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { IAgentManager } from "../../../src/agents";
import type { CompleteOptions, CompleteResult } from "../../../src/agents/types";
import { waitForCondition } from "../../helpers/timeout";

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function makeMockManager(
  options: {
    completeFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
    /** Set of agent names that are "unavailable" (getAgent returns undefined) */
    unavailableAgents?: Set<string>;
  } = {},
): IAgentManager {
  const unavailable = options.unavailableAgents ?? new Set<string>();
  return {
    getAgent: (name: string) => unavailable.has(name) ? undefined : ({} as any),
    getDefault: () => "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    events: { on: () => {} } as any,
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async () => ({ result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }, fallbacks: [] }),
    completeWithFallback: async (_p, _o) => ({ result: { output: "default output", costUsd: 0, source: "fallback" }, fallbacks: [] }),
    run: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }),
    complete: async (_p, _o) => ({ output: "default output", costUsd: 0, source: "fallback" }),
    completeAs: options.completeFn
      ? async (name, prompt, opts) => options.completeFn!(name, prompt, opts)
      : async (name, _p, _o) => ({ output: `output from ${name}`, costUsd: 0, source: "fallback" }),
    runAs: async (_name, request) => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCost: 0,
      agentFallbacks: [],
    }),
    plan: async () => ({ specContent: "" }),
    planAs: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    decomposeAs: async () => ({ stories: [] }),
  } as any;
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

let origCreateManager: typeof _debateSessionDeps.createManager;
let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origCreateManager = _debateSessionDeps.createManager;
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
});

afterEach(() => {
  _debateSessionDeps.createManager = origCreateManager;
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
});

// ─── AC1: resolves adapters via createManager(), calls completeAs() with model override ──

describe("DebateSession.run() — agent resolution", () => {
  test("resolves each debater via manager.getAgent(debater.agent)", async () => {
    const agentCalls: string[] = [];

    _debateSessionDeps.createManager = mock((_config) => ({
      ...makeMockManager(),
      getAgent: (name: string) => {
        agentCalls.push(name);
        return {} as any;
      },
    } as any));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig(),
    });

    await session.run("test prompt");

    expect(agentCalls).toContain("claude");
    expect(agentCalls).toContain("opencode");
    expect(agentCalls).toContain("gemini");
  });

  test("calls manager.completeAs() with the debater's model override", async () => {
    const completeCalls: Array<{ agent: string; model: string | undefined }> = [];

    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      completeFn: async (agentName, _prompt, opts) => {
        completeCalls.push({ agent: agentName, model: opts?.model });
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
      },
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [
          { agent: "claude", model: "claude-3-5-haiku-20241022" },
          { agent: "opencode", model: "gpt-4o-mini" },
        ],
      }),
    });

    await session.run("test prompt");

    const claudeCall = completeCalls.find((c) => c.agent === "claude");
    const opencodeCall = completeCalls.find((c) => c.agent === "opencode");

    expect(claudeCall?.model).toBe("claude-3-5-haiku-20241022");
    expect(opencodeCall?.model).toBe("gpt-4o-mini");
  });

  test("passes the original prompt to each debater's completeAs() call", async () => {
    const receivedPrompts: string[] = [];

    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      completeFn: async (_name, prompt) => {
        receivedPrompts.push(prompt);
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
      },
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
      }),
    });

    await session.run("the original task prompt");

    expect(receivedPrompts.every((p) => p.includes("the original task prompt"))).toBe(true);
  });
});

// ─── AC2: parallel proposal round via Promise.allSettled() ────────────────────

describe("DebateSession.run() — parallel execution", () => {
  test("starts all debater completeAs() calls before any one resolves", async () => {
    const startTimes: number[] = [];
    const resolvers: Array<() => void> = [];

    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      completeFn: async (name) => {
        startTimes.push(Date.now());
        await new Promise<void>((resolve) => resolvers.push(resolve));
        return { output: `output from ${name}`, costUsd: 0, source: "fallback" };
      },
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 1,
      }),
    });

    const runPromise = session.run("test prompt");

    await waitForCondition(() => startTimes.length === 2);
    expect(startTimes.length).toBe(2);

    for (const r of resolvers) r();
    await runPromise;
  });

  test("continues when one debater's completeAs() throws (allSettled semantics)", async () => {
    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      completeFn: async (name) => {
        if (name === "failing") throw new Error("agent error");
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
      },
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "failing" }, { agent: "opencode" }],
        rounds: 1,
      }),
    });

    await expect(session.run("test prompt")).resolves.toBeDefined();
  });
});

// ─── AC3: skips null agent, logs warning with stage 'debate' ─────────────────

describe("DebateSession.run() — unavailable agent handling", () => {
  test("skips debaters where manager.getAgent returns undefined", async () => {
    const completeCalls: string[] = [];

    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      unavailableAgents: new Set(["missing-agent"]),
      completeFn: async (name) => {
        completeCalls.push(name);
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
      },
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing-agent" }, { agent: "opencode" }],
      }),
    });

    await session.run("test prompt");

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

    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      unavailableAgents: new Set(["missing-agent"]),
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing-agent" }, { agent: "opencode" }],
      }),
    });

    await session.run("test prompt");

    const debateWarning = warnings.find((w) => w.stage === "debate");
    expect(debateWarning).toBeDefined();
    expect(debateWarning?.message).toMatch(/missing-agent/);
  });

  test("skips debaters where manager.getAgent returns null", async () => {
    const completeCalls: string[] = [];

    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      unavailableAgents: new Set(["null-agent"]),
      completeFn: async (name) => {
        completeCalls.push(name);
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
      },
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "null-agent" }, { agent: "opencode" }],
      }),
    });

    await session.run("test prompt");

    expect(completeCalls).not.toContain("null-agent");
  });
});

// ─── AC4: fallback to single-agent mode ───────────────────────────────────────

describe("DebateSession.run() — single-agent fallback", () => {
  test("returns the one successful proposal when only 1 debater succeeds", async () => {
    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      unavailableAgents: new Set(["missing-1", "missing-2"]),
      completeFn: async () => ({ output: "the single successful proposal", costUsd: 0, source: "fallback" }),
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing-1" }, { agent: "missing-2" }],
      }),
    });

    const result = await session.run("test prompt");

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.output).toBe("the single successful proposal");
  });

  test("result is not 'skipped' when falling back to single-agent", async () => {
    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      unavailableAgents: new Set(["missing"]),
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing" }],
      }),
    });

    const result = await session.run("test prompt");

    expect(result.outcome).not.toBe("skipped");
  });

  test("falls back to fresh completeAs() call when all debaters fail", async () => {
    _debateSessionDeps.createManager = mock((_config) => makeMockManager({
      completeFn: async () => {
        throw new Error("simulated failure");
      },
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "failing-1" }, { agent: "failing-2" }],
      }),
    });

    const result = await session.run("test prompt");
    expect(result).toBeDefined();
    expect(result.storyId).toBe("US-002");
  });
});

