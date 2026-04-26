import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { CompleteOptions } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
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

let origAgentManager: typeof _debateSessionDeps.agentManager;

beforeEach(() => {
  origAgentManager = _debateSessionDeps.agentManager;
});

afterEach(() => {
  _debateSessionDeps.agentManager = origAgentManager;
  mock.restore();
});

describe("DebateSession.run() — stateful mode uses runAsSession SSOT", () => {
  test("proposal round calls runAsSession for each debater", async () => {
    const runAsSessionCalls: Array<{ agentName: string; prompt: string; handleId: string }> = [];

    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    _debateSessionDeps.agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, handle, prompt) => {
        runAsSessionCalls.push({ agentName, prompt, handleId: handle.id });
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const session = new DebateSession({
      storyId: "US-003",
      stage: "plan",
      stageConfig: makeStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat-a",
      timeoutSeconds: 120,
      sessionManager: mockSM,
    });

    await session.run("test prompt");

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

    _debateSessionDeps.agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, handle, prompt) => {
        handleCallMap[handle.id] = handleCallMap[handle.id] ?? [];
        handleCallMap[handle.id].push(prompt.includes("reviewing proposals") ? "critique" : "proposal");
        return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const session = new DebateSession({
      storyId: "US-004",
      stage: "review",
      stageConfig: makeStageConfig({ rounds: 2 }),
      workdir: "/tmp/work",
      featureName: "feat-b",
      timeoutSeconds: 120,
      sessionManager: mockSM,
    });

    await session.run("review prompt");

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
    _debateSessionDeps.agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, _prompt) => {
        if (agentName === "opencode") throw new Error("opencode failed");
        return { output: `proposal-${agentName}`, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
    });

    const session = new DebateSession({
      storyId: "US-005",
      stage: "review",
      stageConfig: makeStageConfig({ rounds: 2 }),
      workdir: "/tmp/work",
      featureName: "feat-c",
      sessionManager: mockSM,
    });

    const result = await session.run("review prompt");
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

    _debateSessionDeps.agentManager = makeMockAgentManager({
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

    const session = new DebateSession({
      storyId,
      stage: "review",
      stageConfig: makeStageConfig({ resolver: { type: "synthesis" }, rounds: 1 }),
      workdir,
      featureName,
      timeoutSeconds: 60,
      sessionManager: mockSM,
    });

    await session.run("review prompt");

    const synthesisCall = completeCalls.find((c) => c.opts !== undefined);
    expect(synthesisCall).toBeDefined();
    const expectedSessionName = computeAcpHandle(workdir, featureName, storyId, "synthesis");
    expect(synthesisCall?.opts?.sessionName).toBe(expectedSessionName);
  });
});

describe("DebateSession.run() — one-shot mode unchanged", () => {
  test("one-shot does not use runAsSession for proposal path", async () => {
    let runAsSessionCount = 0;
    let completeCount = 0;

    _debateSessionDeps.agentManager = makeMockAgentManager({
      runAsSessionFn: async () => {
        runAsSessionCount += 1;
        return { output: "run-session", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      },
      completeFn: async () => {
        completeCount += 1;
        return { output: '{"passed": true}', costUsd: 0.1, source: "exact" };
      },
    });

    const session = new DebateSession({
      storyId: "US-006",
      stage: "plan",
      stageConfig: makeStageConfig({ sessionMode: "one-shot", rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat-d",
    });

    await session.run("plan prompt");

    expect(runAsSessionCount).toBe(0);
    expect(completeCount).toBeGreaterThan(0);
  });
});
