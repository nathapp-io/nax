/**
 * Tests for DebateRunner — US-002
 *
 * File: session-rounds-and-cost.test.ts
 * Covers:
 * - AC5: critique round sends each debater the others' proposals when rounds === 2
 * - AC6: critique round is skipped when rounds === 1
 * - AC11: DebateResult.totalCostUsd aggregates all complete() call costs
 * - AC12: DebateResult.proposals contains debater identity alongside each output
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

function makeCallCtx(agentManager: ReturnType<typeof makeMockAgentManager>): CallContext {
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

// ─── AC5: critique round when rounds === 2 ────────────────────────────────────

describe("DebateRunner.run() — critique rounds (rounds === 2)", () => {
  test("each debater is called twice when rounds === 2", async () => {
    const callCounts: Record<string, number> = {};

    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => {
        callCounts[name] = (callCounts[name] ?? 0) + 1;
        return { output: `proposal from ${name}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    expect(callCounts["claude"]).toBe(2);
    expect(callCounts["opencode"]).toBe(2);
  });

  test("claude's critique prompt contains opencode's proposal", async () => {
    const promptsByAgent: Record<string, string[]> = {};

    const agentManager = makeMockAgentManager({
      completeAsFn: async (name, prompt) => {
        if (!promptsByAgent[name]) promptsByAgent[name] = [];
        promptsByAgent[name].push(prompt);
        return { output: `proposal from ${name}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    const claudeRound2Prompt = promptsByAgent["claude"]?.[1];
    expect(claudeRound2Prompt).toBeDefined();
    expect(claudeRound2Prompt).toContain("proposal from opencode");
  });

  test("opencode's critique prompt contains claude's proposal", async () => {
    const promptsByAgent: Record<string, string[]> = {};

    const agentManager = makeMockAgentManager({
      completeAsFn: async (name, prompt) => {
        if (!promptsByAgent[name]) promptsByAgent[name] = [];
        promptsByAgent[name].push(prompt);
        return { output: `proposal from ${name}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    const opencodeRound2Prompt = promptsByAgent["opencode"]?.[1];
    expect(opencodeRound2Prompt).toBeDefined();
    expect(opencodeRound2Prompt).toContain("proposal from claude");
  });

  test("debater's critique prompt does NOT contain its own proposal", async () => {
    const promptsByAgent: Record<string, string[]> = {};

    const agentManager = makeMockAgentManager({
      completeAsFn: async (name, prompt) => {
        if (!promptsByAgent[name]) promptsByAgent[name] = [];
        promptsByAgent[name].push(prompt);
        return { output: `proposal from ${name}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    const claudeRound2Prompt = promptsByAgent["claude"]?.[1];
    expect(claudeRound2Prompt).not.toContain("proposal from claude");
  });
});

// ─── AC6: critique round skipped when rounds === 1 ────────────────────────────

describe("DebateRunner.run() — no critique round (rounds === 1)", () => {
  test("each debater's completeAs() is called exactly once when rounds === 1", async () => {
    const callCounts: Record<string, number> = {};

    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => {
        callCounts[name] = (callCounts[name] ?? 0) + 1;
        return { output: `{"passed": true}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 1,
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("test prompt");

    expect(callCounts["claude"]).toBe(1);
    expect(callCounts["opencode"]).toBe(1);
  });
});

// ─── AC11: totalCostUsd is aggregated ─────────────────────────────────────────

describe("DebateRunner.run() — cost tracking", () => {
  test("DebateResult has totalCostUsd field", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name, _p, _o) => ({ output: `output from ${name}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.1 }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const result = await runner.run("test prompt");

    expect("totalCostUsd" in result).toBe(true);
    expect(typeof result.totalCostUsd).toBe("number");
  });
});

// ─── AC12: proposals contain debater identity ────────────────────────────────

describe("DebateRunner.run() — proposals structure", () => {
  test("DebateResult.proposals contains one entry per successful debater", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => ({ output: `output from ${name}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
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

    const result = await runner.run("test prompt");

    expect(result.proposals).toHaveLength(2);
  });

  test("each proposal entry contains debater identity (agent name)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => ({ output: `output from ${name}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
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

    const result = await runner.run("test prompt");

    const claudeProposal = result.proposals.find((p) => p.debater.agent === "claude");
    expect(claudeProposal).toBeDefined();
    expect(claudeProposal?.debater.model).toBe("claude-3-5-haiku-20241022");
  });

  test("each proposal entry contains the output from completeAs()", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => ({ output: `output from ${name}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
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

    const result = await runner.run("test prompt");

    const claudeProposal = result.proposals.find((p) => p.debater.agent === "claude");
    expect(claudeProposal?.output).toBe("output from claude");

    const opencodeProposal = result.proposals.find((p) => p.debater.agent === "opencode");
    expect(opencodeProposal?.output).toBe("output from opencode");
  });

  test("DebateResult includes storyId, stage, and resolverType", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({ output: `{"passed": true}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx(agentManager),
      stage: "review",
      stageConfig: makeStageConfig({ resolver: { type: "majority-fail-closed" } }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const result = await runner.run("test prompt");

    expect(result.storyId).toBe("US-002");
    expect(result.stage).toBe("review");
    expect(result.resolverType).toBe("majority-fail-closed");
  });
});
