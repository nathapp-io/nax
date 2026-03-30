/**
 * Tests for DebateSession — US-002
 *
 * Covers:
 * - AC1: resolves debater adapters via getAgent(), calls complete() with model override
 * - AC2: parallel proposal round via Promise.allSettled()
 * - AC3: skips debaters with null/undefined adapter, logs warning with stage 'debate'
 * - AC4: fallback to single-agent mode when fewer than 2 debaters succeed
 * - AC5: critique round sends each debater the others' proposals when rounds === 2
 * - AC6: critique round is skipped when rounds === 1
 * - AC11: DebateResult.totalCostUsd aggregates all complete() call costs
 * - AC12: DebateResult.proposals contains debater identity alongside each output
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { AgentAdapter, CompleteOptions } from "../../../src/agents/types";

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function makeMockAdapter(
  name: string,
  options: {
    completeFn?: (prompt: string, opts?: CompleteOptions) => Promise<string>;
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
    complete: options.completeFn ?? (async (_p, _o) => `output from ${name}`),
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
          return `{"passed": true}`;
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
          return `{"passed": true}`;
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
          return `output from ${name}`;
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

    // Give event loop a tick — both should have started
    await new Promise((r) => setTimeout(r, 20));
    expect(startTimes.length).toBe(2);

    // Unblock all
    for (const r of resolvers) r();
    await runPromise;
  });

  test("continues when one debater's complete() throws (allSettled semantics)", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => {
          if (name === "failing") throw new Error("agent error");
          return `{"passed": true}`;
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

    // Should not throw — allSettled handles individual failures
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
          return `{"passed": true}`;
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
          return `{"passed": true}`;
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
          completeFn: async () => "the single successful proposal",
        });
      }
      // Other debaters unavailable
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

    // Should not throw — falls back gracefully
    const result = await session.run("test prompt");
    expect(result).toBeDefined();
    expect(result.storyId).toBe("US-002");
  });
});

// ─── AC5: critique round when rounds === 2 ────────────────────────────────────

describe("DebateSession.run() — critique rounds (rounds === 2)", () => {
  test("each debater is called twice when rounds === 2", async () => {
    const callCounts: Record<string, number> = {};

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => {
          callCounts[name] = (callCounts[name] ?? 0) + 1;
          return `proposal from ${name}`;
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
    });

    await session.run("test prompt");

    expect(callCounts["claude"]).toBe(2);
    expect(callCounts["opencode"]).toBe(2);
  });

  test("claude's critique prompt contains opencode's proposal", async () => {
    const promptsByAgent: Record<string, string[]> = {};

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async (prompt) => {
          if (!promptsByAgent[name]) promptsByAgent[name] = [];
          promptsByAgent[name].push(prompt);
          return `proposal from ${name}`;
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
    });

    await session.run("test prompt");

    // Round 2 prompt for claude should include opencode's proposal
    const claudeRound2Prompt = promptsByAgent["claude"]?.[1];
    expect(claudeRound2Prompt).toBeDefined();
    expect(claudeRound2Prompt).toContain("proposal from opencode");
  });

  test("opencode's critique prompt contains claude's proposal", async () => {
    const promptsByAgent: Record<string, string[]> = {};

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async (prompt) => {
          if (!promptsByAgent[name]) promptsByAgent[name] = [];
          promptsByAgent[name].push(prompt);
          return `proposal from ${name}`;
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
    });

    await session.run("test prompt");

    const opencodeRound2Prompt = promptsByAgent["opencode"]?.[1];
    expect(opencodeRound2Prompt).toBeDefined();
    expect(opencodeRound2Prompt).toContain("proposal from claude");
  });

  test("debater's critique prompt does NOT contain its own proposal", async () => {
    const promptsByAgent: Record<string, string[]> = {};

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async (prompt) => {
          if (!promptsByAgent[name]) promptsByAgent[name] = [];
          promptsByAgent[name].push(prompt);
          return `proposal from ${name}`;
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
    });

    await session.run("test prompt");

    // claude's critique prompt should not include its own first proposal
    const claudeRound2Prompt = promptsByAgent["claude"]?.[1];
    expect(claudeRound2Prompt).not.toContain("proposal from claude");
  });
});

// ─── AC6: critique round skipped when rounds === 1 ────────────────────────────

describe("DebateSession.run() — no critique round (rounds === 1)", () => {
  test("each debater's complete() is called exactly once when rounds === 1", async () => {
    const callCounts: Record<string, number> = {};

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => {
          callCounts[name] = (callCounts[name] ?? 0) + 1;
          return `{"passed": true}`;
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

    await session.run("test prompt");

    expect(callCounts["claude"]).toBe(1);
    expect(callCounts["opencode"]).toBe(1);
  });
});

// ─── AC11: totalCostUsd is aggregated ─────────────────────────────────────────

describe("DebateSession.run() — cost tracking", () => {
  test("DebateResult.totalCostUsd is a non-negative number", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => `{"passed": true}`,
      }),
    );

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig(),
    });

    const result = await session.run("test prompt");

    expect(typeof result.totalCostUsd).toBe("number");
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  test("DebateResult has totalCostUsd field", async () => {
    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig(),
    });

    const result = await session.run("test prompt");

    expect("totalCostUsd" in result).toBe(true);
  });
});

// ─── AC12: proposals contain debater identity ────────────────────────────────

describe("DebateSession.run() — proposals structure", () => {
  test("DebateResult.proposals contains one entry per successful debater", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => `output from ${name}`,
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

    const result = await session.run("test prompt");

    expect(result.proposals).toHaveLength(2);
  });

  test("each proposal entry contains debater identity (agent name)", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => `output from ${name}`,
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

    const result = await session.run("test prompt");

    const claudeProposal = result.proposals.find((p) => p.debater.agent === "claude");
    expect(claudeProposal).toBeDefined();
    expect(claudeProposal?.debater.model).toBe("claude-3-5-haiku-20241022");
  });

  test("each proposal entry contains the output from complete()", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async () => `output from ${name}`,
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

    const result = await session.run("test prompt");

    const claudeProposal = result.proposals.find((p) => p.debater.agent === "claude");
    expect(claudeProposal?.output).toBe("output from claude");

    const opencodeProposal = result.proposals.find((p) => p.debater.agent === "opencode");
    expect(opencodeProposal?.output).toBe("output from opencode");
  });

  test("DebateResult includes storyId, stage, and resolverType", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, { completeFn: async () => `{"passed": true}` }),
    );

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({ resolver: { type: "majority-fail-closed" } }),
    });

    const result = await session.run("test prompt");

    expect(result.storyId).toBe("US-002");
    expect(result.stage).toBe("review");
    expect(result.resolverType).toBe("majority-fail-closed");
  });
});
