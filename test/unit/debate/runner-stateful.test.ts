import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager({
    runAsSessionFn: async (_name, _handle, _prompt) => ({
      output: "stateful-output",
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
      internalRoundTrips: 1,
    }),
  });
  return {
    runtime: {
      agentManager,
      sessionManager: makeSessionManager({
        openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
        closeSession: mock(async () => {}),
      }),
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-010",
    featureName: "feat-stateful",
    ...overrides,
  };
}

function makeStatefulStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "stateful",
    mode: "panel",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "fast" },
    ],
    ...overrides,
  };
}

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

describe("DebateRunner.run() — stateful mode", () => {
  test("stateful mode calls sessionManager.openSession per debater", async () => {
    const openSessionCalls: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => {
        openSessionCalls.push(name);
        return { id: name, agentName: "claude" };
      }),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, _handle, _prompt) => ({
        output: "proposal-output",
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        internalRoundTrips: 1,
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
      stage: "review",
      stageConfig: makeStatefulStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    await runner.run("stateful prompt");

    // Both debaters should get sessions opened
    expect(openSessionCalls.length).toBe(2);
  });

  test("stateful mode calls agentManager.runAsSession (not completeAs) for debaters", async () => {
    const runAsSessionCalls: string[] = [];
    const completeAsCalls: string[] = [];

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, _prompt) => {
        runAsSessionCalls.push(agentName);
        return {
          output: "session-output",
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          internalRoundTrips: 1,
        };
      },
      completeAsFn: async (name) => {
        completeAsCalls.push(name);
        return { output: "complete-output", costUsd: 0, source: "primary" as const };
      },
    });

    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
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
      stage: "review",
      stageConfig: makeStatefulStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    await runner.run("stateful prompt");

    expect(runAsSessionCalls.length).toBeGreaterThan(0);
    // completeAs should NOT be called for debater proposals in stateful mode
    expect(completeAsCalls.length).toBe(0);
  });

  test("both debaters succeed → outcome resolved", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, _handle, _prompt) => ({
        // JSON with passed:true so majority resolver returns "passed"
        output: '{"passed":true}',
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        internalRoundTrips: 1,
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
      stage: "review",
      stageConfig: makeStatefulStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    const result = await runner.run("stateful prompt");

    expect(result.outcome).toBe("passed");
    expect(result.stage).toBe("review");
    expect(result.storyId).toBe("US-010");
  });

  test("single debater fallback when one session fails → outcome passed", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    let callCount = 0;
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, _prompt) => {
        callCount++;
        if (agentName === "opencode") {
          throw new Error("opencode session failed");
        }
        return {
          output: `proposal from ${agentName}`,
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          internalRoundTrips: 1,
        };
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
      stage: "review",
      stageConfig: makeStatefulStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    const result = await runner.run("stateful prompt");

    // Should still succeed with the one passing debater
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toHaveLength(1);
    expect(result.debaters[0]).toBe("claude");
  });
});
