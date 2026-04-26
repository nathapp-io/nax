/**
 * Tests for runHybrid() sequential rebuttal loop, session cleanup, and result assembly.
 * Covers ACs 1-10 for the rebuttal loop (ADR-019 §4 session pattern).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _debateSessionDeps } from "../../../src/debate/session";
import type { HybridCtx } from "../../../src/debate/session-hybrid";
import type { DebateStageConfig } from "../../../src/debate/types";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRebuttalPrompt(prompt: string): boolean {
  return prompt.includes("## Your Task") && prompt.includes("You are debater");
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

function makeHybridCtx(overrides: Partial<HybridCtx> = {}): HybridCtx {
  return {
    storyId: "US-test",
    stage: "run",
    stageConfig: makeHybridStageConfig(),
    config: {} as any,
    workdir: "/tmp/work",
    featureName: "feat",
    timeoutSeconds: 60,
    agentManager: makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, prompt) => ({
        output: isRebuttalPrompt(prompt) ? `rebuttal-${agentName}` : `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    }),
    sessionManager: makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    }),
    ...overrides,
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let origAgentManager: typeof _debateSessionDeps.agentManager;
let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origAgentManager = _debateSessionDeps.agentManager;
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => null) as unknown as typeof _debateSessionDeps.getSafeLogger;
});

afterEach(() => {
  _debateSessionDeps.agentManager = origAgentManager;
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

// ─── AC1: 2 debaters, rounds=1 → exactly 2 sequential rebuttal calls ─────────

describe("runHybrid() — sequential rebuttal call count with 2 debaters (AC1)", () => {
  test("with 2 debaters and rounds=1, rebuttal runAsSession is called exactly 2 times", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const rebuttalCalls: string[] = [];
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName, _handle, prompt) => {
          if (isRebuttalPrompt(prompt)) rebuttalCalls.push(agentName);
          return { output: `output-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(rebuttalCalls).toHaveLength(2);
  });

  test("with 2 debaters and rounds=1, rebuttal calls happen in sequential debater order (0 then 1)", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const rebuttalOrder: string[] = [];
    const ctx = makeHybridCtx({
      sessionManager: makeSessionManager({
        openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
        closeSession: mock(async () => {}),
        nameFor: mock((req) => req.role ?? ""),
      }),
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName, handle, prompt) => {
          if (isRebuttalPrompt(prompt)) rebuttalOrder.push(handle.id);
          return { output: `output-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(rebuttalOrder).toHaveLength(2);
    expect(rebuttalOrder[0]).toBe("debate-hybrid-0");
    expect(rebuttalOrder[1]).toBe("debate-hybrid-1");
  });
});

// ─── AC2: 3 debaters, rounds=2 → exactly 6 rebuttal calls ────────────────────

describe("runHybrid() — rebuttal call count with 3 debaters and 2 rounds (AC2)", () => {
  test("with 3 debaters and rounds=2, rebuttal runAsSession is called exactly 6 times", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const rebuttalCalls: string[] = [];
    const ctx = makeHybridCtx({
      stageConfig: makeHybridStageConfig({
        rounds: 2,
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName, _handle, prompt) => {
          if (isRebuttalPrompt(prompt)) rebuttalCalls.push(agentName);
          return { output: `output-${agentName}-${rebuttalCalls.length}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(rebuttalCalls).toHaveLength(6);
  });
});

// ─── AC3: each rebuttal prompt includes all successful proposal outputs ────────

describe("runHybrid() — rebuttal prompts include proposal outputs (AC3)", () => {
  test("each rebuttal turn prompt contains all successful proposal outputs", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const rebuttalPrompts: string[] = [];
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName, _handle, prompt) => {
          if (isRebuttalPrompt(prompt)) rebuttalPrompts.push(prompt);
          return { output: `proposal-output-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(rebuttalPrompts).toHaveLength(2);
    for (const prompt of rebuttalPrompts) {
      expect(prompt).toContain("proposal-output-claude");
      expect(prompt).toContain("proposal-output-opencode");
    }
  });
});

// ─── AC4: round 2 prompts include round 1 rebuttal outputs ───────────────────

describe("runHybrid() — round 2 rebuttal prompts include round 1 outputs (AC4)", () => {
  test("round 2 rebuttal prompts contain all round 1 rebuttal outputs in previous-rebuttals section", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    let roundTracker = 0;
    const round1RebuttalOutputs: string[] = [];
    const round2Prompts: string[] = [];

    const ctx = makeHybridCtx({
      stageConfig: makeHybridStageConfig({ rounds: 2 }),
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName, _handle, prompt) => {
          if (isRebuttalPrompt(prompt)) {
            roundTracker++;
            const output = `rebuttal-${agentName}-round-${roundTracker <= 2 ? 1 : 2}`;
            if (roundTracker <= 2) round1RebuttalOutputs.push(output);
            else round2Prompts.push(prompt);
            return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
          }
          return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(round2Prompts).toHaveLength(2);
    for (const prompt of round2Prompts) {
      for (const r1output of round1RebuttalOutputs) {
        expect(prompt).toContain(r1output);
      }
    }
  });
});

// ─── AC5: failed rebuttal turn is skipped with warning ───────────────────────

describe("runHybrid() — failed rebuttal turn is skipped with warning (AC5)", () => {
  test("when one rebuttal turn throws, a warning is logged and the loop continues", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const warnMessages: string[] = [];
    const mockLogger = {
      warn: (_stage: string, msg: string) => { warnMessages.push(msg); },
      info: () => {},
      debug: () => {},
      error: () => {},
    };
    _debateSessionDeps.getSafeLogger = mock(() => mockLogger) as unknown as typeof _debateSessionDeps.getSafeLogger;

    let rebuttalCallCount = 0;
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName, _handle, prompt) => {
          if (isRebuttalPrompt(prompt)) {
            rebuttalCallCount++;
            if (agentName === "claude") throw new Error("rebuttal failed for claude");
          }
          return { output: `output-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    const result = await runHybrid(ctx, "test prompt");
    expect(rebuttalCallCount).toBe(2);
    expect(warnMessages.some((m) => m.includes("rebuttal") || m.includes("failed") || m.includes("debate"))).toBe(true);
    expect(result.outcome).not.toBe("failed");
  });
});

// ─── AC6: rebuttal calls use same handle as proposal ─────────────────────────

describe("runHybrid() — rebuttal calls use same handle as proposal (AC6)", () => {
  test("each rebuttal runAsSession call uses the same handle as the proposal for that debater", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const handleCallCount: Record<string, number> = {};

    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (_agentName, handle, _prompt) => {
          handleCallCount[handle.id] = (handleCallCount[handle.id] ?? 0) + 1;
          return { output: "output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    await runHybrid(ctx, "test prompt");

    // Each handle should have been used for both proposal (1) and rebuttal (1) = 2 calls
    for (const count of Object.values(handleCallCount)) {
      expect(count).toBe(2);
    }
  });
});

// ─── AC7: sessionManager.closeSession called once per debater ────────────────

describe("runHybrid() — sessionManager.closeSession called after normal rebuttal loop (AC7)", () => {
  test("after the rebuttal loop completes normally, closeSession is called once per opened debater session", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const closedHandleIds: string[] = [];
    const ctx = makeHybridCtx({
      sessionManager: makeSessionManager({
        openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
        closeSession: mock(async (handle) => { closedHandleIds.push(handle.id); }),
        nameFor: mock((req) => req.role ?? ""),
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(closedHandleIds).toHaveLength(2);
    expect(closedHandleIds).toContain("debate-hybrid-0");
    expect(closedHandleIds).toContain("debate-hybrid-1");
  });
});

// ─── AC8: closeSession called even when all rebuttal turns fail ───────────────

describe("runHybrid() — closeSession called when rebuttal turns fail (AC8)", () => {
  test("when all rebuttal turns fail, closeSession is still called for all opened sessions", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const closedHandleIds: string[] = [];
    const ctx = makeHybridCtx({
      sessionManager: makeSessionManager({
        openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
        closeSession: mock(async (handle) => { closedHandleIds.push(handle.id); }),
        nameFor: mock((req) => req.role ?? ""),
      }),
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (_agentName, _handle, prompt) => {
          if (isRebuttalPrompt(prompt)) throw new Error("rebuttal failed");
          return { output: "proposal", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(closedHandleIds).toHaveLength(2);
  });
});

// ─── AC9: per-turn rebuttal costs summed into totalCostUsd ───────────────────

describe("runHybrid() — rebuttal costs accumulated in totalCostUsd (AC9)", () => {
  test("per-turn rebuttal costs are summed and reflected in totalCostUsd", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (_agentName, _handle, prompt) => {
          const cost = isRebuttalPrompt(prompt) ? 0.05 : 0.1;
          return { output: "output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0, cost: { total: cost } };
        },
      }),
    });
    const result = await runHybrid(ctx, "test prompt");
    // 2 proposals × 0.10 + 2 rebuttals × 0.05 = 0.30
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0.29);
  });
});

// ─── AC10: DebateResult.rebuttals populated ───────────────────────────────────

describe("runHybrid() — DebateResult.rebuttals populated and debug event emitted (AC10)", () => {
  test("DebateResult.rebuttals contains one entry per successful rebuttal", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName, _handle, prompt) => ({
          output: isRebuttalPrompt(prompt) ? `rebuttal-output-${agentName}` : `proposal-${agentName}`,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        }),
      }),
    });
    const result = await runHybrid(ctx, "test prompt");
    expect(result.rebuttals).toBeDefined();
    expect(result.rebuttals).toHaveLength(2);
    const outputs = (result.rebuttals ?? []).map((r) => r.output);
    expect(outputs).toContain("rebuttal-output-claude");
    expect(outputs).toContain("rebuttal-output-opencode");
    for (const rebuttal of result.rebuttals ?? []) {
      expect(rebuttal.round).toBe(1);
      expect(typeof rebuttal.debater).toBe("object");
    }
  });

  test("debate:rebuttal-start info event is emitted before each rebuttal turn", async () => {
    const { runHybrid } = await import("../../../src/debate/session-hybrid");
    const infoEvents: Array<{ stage: string; event: string; data?: unknown }> = [];
    const mockLogger = {
      warn: () => {},
      info: (stage: string, event: string, data?: unknown) => { infoEvents.push({ stage, event, data }); },
      debug: () => {},
      error: () => {},
    };
    _debateSessionDeps.getSafeLogger = mock(() => mockLogger) as unknown as typeof _debateSessionDeps.getSafeLogger;

    const ctx = makeHybridCtx();
    await runHybrid(ctx, "test prompt");

    const rebuttalStartEvents = infoEvents.filter((e) => e.stage === "debate:rebuttal-start");
    expect(rebuttalStartEvents).toHaveLength(2);
    for (const evt of rebuttalStartEvents) {
      expect((evt.data as Record<string, unknown>)?.round).toBeDefined();
      expect((evt.data as Record<string, unknown>)?.debaterIndex).toBeDefined();
    }
  });
});
