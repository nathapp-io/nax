import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { CompleteOptions } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { computeAcpHandle } from "../../../src/agents/acp/adapter";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

test("SuccessfulProposal type carries optional handle field (compile-time check)", () => {
  const proposal: import("../../../src/debate/session-helpers").SuccessfulProposal = {
    debater: { agent: "claude", model: "fast" },
    agentName: "claude",
    output: "test",
    cost: 0,
    handle: { id: "sess-001", agentName: "claude" },
  };
  expect(proposal.handle?.id).toBe("sess-001");
});

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "stateful",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "balanced" },
    ],
    ...overrides,
  };
}

function makeCallCtx(
  storyId: string,
  agentManager: ReturnType<typeof makeMockAgentManager>,
  sessionManager: ReturnType<typeof makeSessionManager>,
  workdir = "/tmp/work",
): CallContext {
  return {
    runtime: {
      agentManager,
      sessionManager,
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: workdir,
    agentName: "claude",
    storyId,
    featureName: "test",
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

describe("DebateRunner.run() — stateful mode uses runAsSession SSOT", () => {
  test("proposal round calls runAsSession for each debater", async () => {
    const runAsSessionCalls: Array<{ agentName: string; prompt: string; handleId: string }> = [];

    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, handle, prompt) => {
        runAsSessionCalls.push({ agentName, prompt, handleId: handle.id });
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-003", agentManager, mockSM),
      stage: "plan",
      stageConfig: makeStageConfig({ rounds: 1 }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-a",
      timeoutSeconds: 120,
      sessionManager: mockSM,
    });

    await runner.run("test prompt");

    expect(runAsSessionCalls.length).toBe(2);
    expect(runAsSessionCalls[0].agentName).toBe("claude");
    expect(runAsSessionCalls[1].agentName).toBe("opencode");
  });

  test("rounds > 1: critique runs on same session handle as proposal", async () => {
    const handleCallMap: Record<string, string[]> = {};
    const closedHandles: string[] = [];

    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async (handle) => { closedHandles.push(handle.id); }),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, handle, prompt) => {
        handleCallMap[handle.id] = handleCallMap[handle.id] ?? [];
        handleCallMap[handle.id].push(prompt.includes("reviewing proposals") ? "critique" : "proposal");
        return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-004", agentManager, mockSM),
      stage: "review",
      stageConfig: makeStageConfig({ rounds: 2 }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-b",
      timeoutSeconds: 120,
      sessionManager: mockSM,
    });

    await runner.run("review prompt");

    for (const calls of Object.values(handleCallMap)) {
      expect(calls).toContain("proposal");
      expect(calls).toContain("critique");
    }
    expect(closedHandles.length).toBe(2);
  });

  test("falls back to single-agent passed when only one proposal run succeeds", async () => {
    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: name.includes("opencode") ? "opencode" : "claude" })),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, _prompt) => {
        if (agentName === "opencode") throw new Error("opencode failed");
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-005", agentManager, mockSM),
      stage: "review",
      stageConfig: makeStageConfig({ rounds: 2 }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-c",
      sessionManager: mockSM,
    });

    const result = await runner.run("review prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
  });
});

describe("runStateful() — resolveOutcome receives workdir and featureName (US-004 AC4)", () => {
  test("synthesis resolver receives sessionName built from ctx.workdir and ctx.featureName", async () => {
    const completeCalls: { opts?: CompleteOptions }[] = [];

    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: '{"passed": true}',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      }),
      completeFn: async (_agentName: string, _prompt: string, opts?: CompleteOptions) => {
        completeCalls.push({ opts });
        return { output: "synthesis resolved", costUsd: 0.01, source: "exact" as const };
      },
    });

    const workdir = "/tmp/stateful-work";
    const featureName = "stateful-feature";
    const storyId = "US-004-stateful";

    const runner = new DebateRunner({
      ctx: makeCallCtx(storyId, agentManager, mockSM, workdir),
      stage: "review",
      stageConfig: makeStageConfig({ resolver: { type: "synthesis" }, rounds: 1 }),
      config: DEFAULT_CONFIG,
      workdir,
      featureName,
      timeoutSeconds: 60,
      sessionManager: mockSM,
    });

    await runner.run("review prompt");

    const synthesisCall = completeCalls.find((c) => c.opts !== undefined);
    expect(synthesisCall).toBeDefined();
    const expectedSessionName = computeAcpHandle(workdir, featureName, storyId, "synthesis");
    expect(synthesisCall?.opts?.sessionName).toBe(expectedSessionName);
  });
});

describe("DebateRunner.run() — one-shot mode unchanged", () => {
  test("one-shot does not use runAsSession for proposal path", async () => {
    let runAsSessionCount = 0;
    let completeCount = 0;

    const mockSM = makeSessionManager();
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => {
        runAsSessionCount += 1;
        return { output: "run-session", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
      completeFn: async () => {
        completeCount += 1;
        return { output: '{"passed": true}', costUsd: 0.1, source: "exact" as const };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-006", agentManager, mockSM),
      stage: "plan",
      stageConfig: makeStageConfig({ sessionMode: "one-shot", rounds: 1 }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-d",
    });

    await runner.run("plan prompt");

    expect(runAsSessionCount).toBe(0);
    expect(completeCount).toBeGreaterThan(0);
  });
});
