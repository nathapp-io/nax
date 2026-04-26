import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { HybridCtx } from "../../../src/debate/runner-hybrid";
import type { DebateStageConfig } from "../../../src/debate/types";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

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
    featureName: "feat-hybrid",
    timeoutSeconds: 60,
    agentManager: makeMockAgentManager({
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    }),
    sessionManager: makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    }),
    ...overrides,
  };
}

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

// ─── AC1: sessionRole is 'debate-hybrid-{debaterIndex}' ──────────────────────

describe("runHybrid() — handle IDs correspond to sessionRole (AC1)", () => {
  test("debater 0 gets handle 'debate-hybrid-0' and debater 1 gets 'debate-hybrid-1'", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const openedNames: string[] = [];
    const ctx = makeHybridCtx({
      sessionManager: makeSessionManager({
        openSession: mock(async (name: string) => { openedNames.push(name); return { id: name, agentName: "claude" }; }),
        closeSession: mock(async () => {}),
        nameFor: mock((req) => req.role ?? ""),
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(openedNames).toContain("debate-hybrid-0");
    expect(openedNames).toContain("debate-hybrid-1");
  });

  test("sessionRole index matches debater position in the debaters array (3 debaters)", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const openedNames: string[] = [];
    const ctx = makeHybridCtx({
      stageConfig: makeHybridStageConfig({
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
      sessionManager: makeSessionManager({
        openSession: mock(async (name: string) => { openedNames.push(name); return { id: name, agentName: "claude" }; }),
        closeSession: mock(async () => {}),
        nameFor: mock((req) => req.role ?? ""),
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(openedNames).toContain("debate-hybrid-0");
    expect(openedNames).toContain("debate-hybrid-1");
    expect(openedNames).toContain("debate-hybrid-2");
  });
});

// ─── AC2: parallel via allSettledBounded ─────────────────────────────────────

describe("runHybrid() — parallel proposals via allSettledBounded (AC2)", () => {
  test("all debaters are invoked in the proposal round", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const invoked: string[] = [];
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName) => {
          invoked.push(agentName);
          return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
      stageConfig: makeHybridStageConfig({
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(invoked).toContain("claude");
    expect(invoked).toContain("opencode");
    expect(invoked).toContain("gemini");
  });

  test("maxConcurrentDebaters: 1 still runs all proposals (sequentially)", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const proposalInvoked: string[] = [];
    const ctx = makeHybridCtx({
      config: { debate: { maxConcurrentDebaters: 1 } } as any,
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName, _handle, prompt) => {
          // Only count proposal calls (not rebuttals)
          if (!prompt.includes("## Your Task")) proposalInvoked.push(agentName);
          return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(proposalInvoked.length).toBe(2);
  });
});

// ─── AC3: pre-opened sessions per debater ────────────────────────────────────

describe("runHybrid() — pre-opened sessions per debater (AC3)", () => {
  test("opens one session per debater before proposal round", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const openCalls: string[] = [];
    const runAsSessionCalls: number[] = [];
    const closeCalls: number[] = [];

    const ctx = makeHybridCtx({
      sessionManager: makeSessionManager({
        openSession: mock(async (name: string) => { openCalls.push(name); return { id: "h-" + openCalls.length, agentName: "claude" }; }),
        closeSession: mock(async () => { closeCalls.push(1); }),
        nameFor: mock((req) => req.role ?? ""),
      }),
      agentManager: makeMockAgentManager({
        runAsSessionFn: async () => {
          runAsSessionCalls.push(1);
          return { output: "proposal", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });

    await runHybrid(ctx, "prompt");

    // 2 debaters → 2 open, 2 close
    expect(openCalls.length).toBe(2);
    expect(closeCalls.length).toBe(2);
    // runAsSession is called for both proposals AND rebuttals (rounds=1 → 2+2=4 total)
    expect(runAsSessionCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── AC4: fallback when fewer than 2 proposals succeed ───────────────────────

describe("runHybrid() — single-agent fallback when fewer than 2 proposals succeed (AC4)", () => {
  test("returns outcome=passed with single debater when exactly 1 proposal succeeds", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName) => {
          if (agentName === "opencode") throw new Error("opencode failed");
          return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        },
      }),
    });
    const result = await runHybrid(ctx, "test prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
    expect(result.rounds).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].output).toBe("proposal-claude");
  });

  test("returns outcome=failed when 0 proposals succeed and fallback retry also fails", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async () => { throw new Error("all failed"); },
      }),
    });
    const result = await runHybrid(ctx, "test prompt");
    expect(result.outcome).toBe("failed");
    expect(result.debaters).toEqual([]);
  });
});

// ─── AC5: successful proposal outputs collected ───────────────────────────────

describe("runHybrid() — successful proposal outputs collected (AC5)", () => {
  test("both proposal outputs appear in result.proposals when 2 proposals succeed", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async (agentName) => ({
          output: `proposal-from-${agentName}`,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        }),
      }),
    });
    const result = await runHybrid(ctx, "test prompt");
    expect(result.proposals).toHaveLength(2);
    const outputs = result.proposals.map((p) => p.output);
    expect(outputs).toContain("proposal-from-claude");
    expect(outputs).toContain("proposal-from-opencode");
  });
});

// ─── AC6: adapters resolved via getAgent ─────────────────────────────────────

describe("runHybrid() — adapter resolution via getAgent (AC6)", () => {
  test("manager.getAgent is called for each debater to resolve adapters", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const agentCalls: string[] = [];
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        getAgentFn: (name: string) => {
          agentCalls.push(name);
          return {} as any;
        },
        runAsSessionFn: async (agentName) => ({
          output: `proposal-${agentName}`,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        }),
      }),
    });
    await runHybrid(ctx, "test prompt");
    expect(agentCalls).toContain("claude");
    expect(agentCalls).toContain("opencode");
  });

  test("debater is skipped when manager.getAgent returns undefined — triggers single-agent fallback", async () => {
    const { runHybrid } = await import("../../../src/debate/runner-hybrid");
    const ctx = makeHybridCtx({
      agentManager: makeMockAgentManager({
        unavailableAgents: new Set(["opencode"]),
        runAsSessionFn: async (agentName) => ({
          output: `proposal-${agentName}`,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        }),
      }),
    });
    const result = await runHybrid(ctx, "test prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
  });
});
