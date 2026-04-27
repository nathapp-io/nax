import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { DebateRunnerOptions } from "../../../src/debate/runner";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager({
    runAsSessionFn: async (agentName) => ({
      output: `proposal-${agentName}`,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    }),
  });
  const sessionManager = makeSessionManager({
    openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
    closeSession: mock(async () => {}),
    nameFor: mock((req) => req.role ?? ""),
  });
  return {
    runtime: {
      agentManager,
      sessionManager,
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-test",
    featureName: "feat-hybrid",
    ...overrides,
  };
}

function makeRunner(
  ctxOverrides: Partial<CallContext> = {},
  stageConfigOverrides: Partial<DebateStageConfig> = {},
  extraOpts: Partial<DebateRunnerOptions> = {},
): DebateRunner {
  const ctx = makeCallCtx(ctxOverrides);
  const sm = (ctx.runtime as any).sessionManager;
  return new DebateRunner({
    ctx,
    stage: "run",
    stageConfig: makeHybridStageConfig(stageConfigOverrides),
    config: DEFAULT_CONFIG,
    workdir: "/tmp/work",
    featureName: "feat-hybrid",
    timeoutSeconds: 60,
    sessionManager: sm,
    ...extraOpts,
  });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }));
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

// ─── AC1: sessionRole is 'debate-hybrid-{debaterIndex}' ──────────────────────

describe("DebateRunner hybrid mode — handle IDs correspond to sessionRole (AC1)", () => {
  test("debater 0 gets handle 'debate-hybrid-0' and debater 1 gets 'debate-hybrid-1'", async () => {
    const openedNames: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => { openedNames.push(name); return { id: name, agentName: "claude" }; }),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(openedNames).toContain("debate-hybrid-0");
    expect(openedNames).toContain("debate-hybrid-1");
  });

  test("sessionRole index matches debater position in the debaters array (3 debaters)", async () => {
    const openedNames: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => { openedNames.push(name); return { id: name, agentName: "claude" }; }),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig({
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-hybrid",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(openedNames).toContain("debate-hybrid-0");
    expect(openedNames).toContain("debate-hybrid-1");
    expect(openedNames).toContain("debate-hybrid-2");
  });
});

// ─── AC2: parallel via allSettledBounded ─────────────────────────────────────

describe("DebateRunner hybrid mode — parallel proposals via allSettledBounded (AC2)", () => {
  test("all debaters are invoked in the proposal round", async () => {
    const invoked: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => {
        invoked.push(agentName);
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig({
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(invoked).toContain("claude");
    expect(invoked).toContain("opencode");
    expect(invoked).toContain("gemini");
  });

  test("maxConcurrentDebaters: 1 still runs all proposals (sequentially)", async () => {
    const proposalInvoked: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, prompt) => {
        // Only count proposal calls (not rebuttals)
        if (!prompt.includes("## Your Task")) proposalInvoked.push(agentName);
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: { ...DEFAULT_CONFIG, debate: { maxConcurrentDebaters: 1 } } as any,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(proposalInvoked.length).toBe(2);
  });
});

// ─── AC3: pre-opened sessions per debater ────────────────────────────────────

describe("DebateRunner hybrid mode — pre-opened sessions per debater (AC3)", () => {
  test("opens one session per debater before proposal round", async () => {
    const openCalls: string[] = [];
    const runAsSessionCalls: number[] = [];
    const closeCalls: number[] = [];

    const sm = makeSessionManager({
      openSession: mock(async (name: string) => { openCalls.push(name); return { id: "h-" + openCalls.length, agentName: "claude" }; }),
      closeSession: mock(async () => { closeCalls.push(1); }),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => {
        runAsSessionCalls.push(1);
        return { output: "proposal", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });

    await runner.run("prompt");

    // 2 debaters → 2 open, 2 close
    expect(openCalls.length).toBe(2);
    expect(closeCalls.length).toBe(2);
    // runAsSession is called for both proposals AND rebuttals (rounds=1 → 2+2=4 total)
    expect(runAsSessionCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── AC4: fallback when fewer than 2 proposals succeed ───────────────────────

describe("DebateRunner hybrid mode — single-agent fallback when fewer than 2 proposals succeed (AC4)", () => {
  test("returns outcome=passed with single debater when exactly 1 proposal succeeds", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => {
        if (agentName === "opencode") throw new Error("opencode failed");
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
    expect(result.rounds).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].output).toBe("proposal-claude");
  });

  test("returns outcome=failed when 0 proposals succeed and fallback retry also fails", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => { throw new Error("all failed"); },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("failed");
    expect(result.debaters).toEqual([]);
  });
});

// ─── AC5: successful proposal outputs collected ───────────────────────────────

describe("DebateRunner hybrid mode — successful proposal outputs collected (AC5)", () => {
  test("both proposal outputs appear in result.proposals when 2 proposals succeed", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName) => ({
        output: `proposal-from-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    const result = await runner.run("test prompt");
    expect(result.proposals).toHaveLength(2);
    const outputs = result.proposals.map((p) => p.output);
    expect(outputs).toContain("proposal-from-claude");
    expect(outputs).toContain("proposal-from-opencode");
  });
});

// ─── AC6: adapters resolved via getAgent ─────────────────────────────────────

describe("DebateRunner hybrid mode — adapter resolution via getAgent (AC6)", () => {
  test("manager.getAgent is called for each debater to resolve adapters", async () => {
    const agentCalls: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      getAgentFn: (name: string) => {
        agentCalls.push(name);
        return {} as any;
      },
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    await runner.run("test prompt");
    expect(agentCalls).toContain("claude");
    expect(agentCalls).toContain("opencode");
  });

  test("debater is skipped when manager.getAgent returns undefined — triggers single-agent fallback", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
      nameFor: mock((req) => req.role ?? ""),
    });
    const agentManager = makeMockAgentManager({
      unavailableAgents: new Set(["opencode"]),
      runAsSessionFn: async (agentName) => ({
        output: `proposal-${agentName}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({
      ctx,
      stage: "run",
      stageConfig: makeHybridStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      timeoutSeconds: 60,
      sessionManager: sm,
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
  });
});
