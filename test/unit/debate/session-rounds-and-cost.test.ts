/**
 * Tests for DebateSession — US-002
 *
 * File: session-rounds-and-cost.test.ts
 * Covers:
 * - AC5: critique round sends each debater the others' proposals when rounds === 2
 * - AC6: critique round is skipped when rounds === 1
 * - AC11: DebateResult.totalCostUsd aggregates all complete() call costs
 * - AC12: DebateResult.proposals contains debater identity alongside each output
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CompleteOptions, CompleteResult } from "../../../src/agents/types";
import { makeMockAgentManager } from "../../helpers";

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

// ─── AC5: critique round when rounds === 2 ────────────────────────────────────

describe("DebateSession.run() — critique rounds (rounds === 2)", () => {
  test("each debater is called twice when rounds === 2", async () => {
    const callCounts: Record<string, number> = {};

    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async (name) => {
        callCounts[name] = (callCounts[name] ?? 0) + 1;
        return { output: `proposal from ${name}`, costUsd: 0, source: "fallback" };
      },
    }));

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

    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async (name, prompt) => {
        if (!promptsByAgent[name]) promptsByAgent[name] = [];
        promptsByAgent[name].push(prompt);
        return { output: `proposal from ${name}`, costUsd: 0, source: "fallback" };
      },
    }));

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

    const claudeRound2Prompt = promptsByAgent["claude"]?.[1];
    expect(claudeRound2Prompt).toBeDefined();
    expect(claudeRound2Prompt).toContain("proposal from opencode");
  });

  test("opencode's critique prompt contains claude's proposal", async () => {
    const promptsByAgent: Record<string, string[]> = {};

    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async (name, prompt) => {
        if (!promptsByAgent[name]) promptsByAgent[name] = [];
        promptsByAgent[name].push(prompt);
        return { output: `proposal from ${name}`, costUsd: 0, source: "fallback" };
      },
    }));

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

    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async (name, prompt) => {
        if (!promptsByAgent[name]) promptsByAgent[name] = [];
        promptsByAgent[name].push(prompt);
        return { output: `proposal from ${name}`, costUsd: 0, source: "fallback" };
      },
    }));

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

    const claudeRound2Prompt = promptsByAgent["claude"]?.[1];
    expect(claudeRound2Prompt).not.toContain("proposal from claude");
  });
});

// ─── AC6: critique round skipped when rounds === 1 ────────────────────────────

describe("DebateSession.run() — no critique round (rounds === 1)", () => {
  test("each debater's complete() is called exactly once when rounds === 1", async () => {
    const callCounts: Record<string, number> = {};

    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async (name) => {
        callCounts[name] = (callCounts[name] ?? 0) + 1;
        return { output: `{"passed": true}`, costUsd: 0, source: "fallback" };
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

    await session.run("test prompt");

    expect(callCounts["claude"]).toBe(1);
    expect(callCounts["opencode"]).toBe(1);
  });
});

// ─── AC11: totalCostUsd is aggregated ─────────────────────────────────────────

describe("DebateSession.run() — cost tracking", () => {
  test("DebateResult.totalCostUsd aggregates proposal, critique, and resolver costs", async () => {
    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async () => ({
        output: `{"passed": true}`,
        costUsd: 0.1,
        source: "exact",
      }),
    }));

    const session = new DebateSession({
      storyId: "US-002",
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 2,
        resolver: { type: "synthesis", agent: "claude" },
      }),
    });

    const result = await session.run("test prompt");

    expect(typeof result.totalCostUsd).toBe("number");
    expect(result.totalCostUsd).toBeCloseTo(0.7, 6);
  });

  test("DebateResult has totalCostUsd field", async () => {
    _debateSessionDeps.createManager = mock(() => makeMockAgentManager({
      completeFn: async (name, _p, _o) => ({ output: `output from ${name}`, costUsd: 0.1, source: "fallback" as const }),
    }));

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
    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async (name) => ({ output: `output from ${name}`, costUsd: 0, source: "fallback" }),
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

    const result = await session.run("test prompt");

    expect(result.proposals).toHaveLength(2);
  });

  test("each proposal entry contains debater identity (agent name)", async () => {
    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async (name) => ({ output: `output from ${name}`, costUsd: 0, source: "fallback" }),
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

    const result = await session.run("test prompt");

    const claudeProposal = result.proposals.find((p) => p.debater.agent === "claude");
    expect(claudeProposal).toBeDefined();
    expect(claudeProposal?.debater.model).toBe("claude-3-5-haiku-20241022");
  });

  test("each proposal entry contains the output from completeAs()", async () => {
    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async (name) => ({ output: `output from ${name}`, costUsd: 0, source: "fallback" }),
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

    const result = await session.run("test prompt");

    const claudeProposal = result.proposals.find((p) => p.debater.agent === "claude");
    expect(claudeProposal?.output).toBe("output from claude");

    const opencodeProposal = result.proposals.find((p) => p.debater.agent === "opencode");
    expect(opencodeProposal?.output).toBe("output from opencode");
  });

  test("DebateResult includes storyId, stage, and resolverType", async () => {
    _debateSessionDeps.createManager = mock((_config) => makeMockAgentManager({
      completeFn: async () => ({ output: `{"passed": true}`, costUsd: 0, source: "fallback" }),
    }));

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
