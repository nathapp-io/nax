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
import type { AgentAdapter, CompleteOptions, CompleteResult } from "../../../src/agents/types";
import { waitForCondition } from "../../helpers/timeout";

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function makeMockAdapter(
  name: string,
  options: {
    completeFn?: (prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
    isInstalledFn?: () => Promise<boolean>;
  } = {},
): AgentAdapter {
  return {
    name,
    displayName: name,
    binary: name,
    capabilities: {
      supportedTiers: ["fast"] as const,
      maxContextTokens: 100_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    },
    isInstalled: options.isInstalledFn ?? (async () => true),
    run: async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCost: 0,
    }),
    buildCommand: () => [],
    plan: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    complete: options.completeFn ??
      (async (_p, _o) => ({
        output: `output from ${name}`,
        costUsd: 0,
        source: "fallback",
      })),
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

let origGetAgent: typeof _debateSessionDeps.getAgent;
let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetAgent = _debateSessionDeps.getAgent;
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
});

afterEach(() => {
  _debateSessionDeps.getAgent = origGetAgent;
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
});

// ─── AC1: resolves adapters via getAgent(), calls complete() with model override ──

describe("DebateSession.run() — agent resolution", () => {
  test("resolves each debater's adapter via getAgent(debater.agent)", async () => {
    const getAgentCalls: string[] = [];

    _debateSessionDeps.getAgent = mock((name: string) => {
      getAgentCalls.push(name);
      return makeMockAdapter(name);
    });

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig(),
    });

    await session.run("test prompt");

    expect(getAgentCalls).toContain("claude");
    expect(getAgentCalls).toContain("opencode");
    expect(getAgentCalls).toContain("gemini");
  });

  test("calls adapter.complete() with the debater's model override", async () => {
    const completeCalls: Array<{ agent: string; model: string | undefined }> = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async (_prompt, opts) => {
          completeCalls.push({ agent: name, model: opts?.model });
          return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
        },
      }),
    );

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

  test("passes the original prompt to each debater's complete() call", async () => {
    const receivedPrompts: string[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async (prompt) => {
          receivedPrompts.push(prompt);
          return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
        },
      }),
    );

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
  test("starts all debater complete() calls before any one resolves", async () => {
    const startTimes: number[] = [];
    const resolvers: Array<() => void> = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => {
          startTimes.push(Date.now());
          await new Promise<void>((resolve) => resolvers.push(resolve));
          return { output: `output from ${name}`, costUsd: 0, source: "fallback" };
        },
      }),
    );

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

  test("continues when one debater's complete() throws (allSettled semantics)", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => {
          if (name === "failing") throw new Error("agent error");
          return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
        },
      }),
    );

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
  test("skips debaters where getAgent returns undefined", async () => {
    const completeCalls: string[] = [];

    _debateSessionDeps.getAgent = mock((name: string) => {
      if (name === "missing-agent") return undefined;
      return makeMockAdapter(name, {
        completeFn: async () => {
          completeCalls.push(name);
          return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
        },
      });
    });

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
    }));

    _debateSessionDeps.getAgent = mock((name: string) => {
      if (name === "missing-agent") return undefined;
      return makeMockAdapter(name);
    });

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

  test("skips debaters where getAgent returns null", async () => {
    const completeCalls: string[] = [];

    _debateSessionDeps.getAgent = mock((name: string) => {
      if (name === "null-agent") return null as unknown as undefined;
      return makeMockAdapter(name, {
        completeFn: async () => {
          completeCalls.push(name);
          return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
        },
      });
    });

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
    _debateSessionDeps.getAgent = mock((name: string) => {
      if (name === "claude") {
        return makeMockAdapter("claude", {
          completeFn: async () => ({ output: "the single successful proposal", costUsd: 0, source: "fallback" }),
        });
      }
      return undefined;
    });

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
    _debateSessionDeps.getAgent = mock((name: string) => {
      if (name === "claude") return makeMockAdapter("claude");
      return undefined;
    });

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

  test("falls back to fresh complete() call when all debaters fail", async () => {
    _debateSessionDeps.getAgent = mock((_name: string) =>
      makeMockAdapter("any", {
        completeFn: async () => {
          throw new Error("simulated failure");
        },
      }),
    );

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

