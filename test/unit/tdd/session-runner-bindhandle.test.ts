/**
 * Tests for session-runner.ts — #541: TDD session binds protocolIds to the
 * pre-created session descriptor so the audit trail is not left with null IDs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentRunRequest, IAgentManager } from "../../../src/agents/manager-types";
import type { UserStory } from "../../../src/prd";
import type { ISessionManager, SessionDescriptor } from "../../../src/session/types";
import { _sessionRunnerDeps, runTddSession } from "../../../src/tdd/session-runner";
import { makeAgentAdapter, makeMockAgentManager, makeNaxConfig } from "../../helpers";
import { fakeAgentManager } from "../../helpers/fake-agent-manager";

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Impl story",
    description: "Do the thing",
    acceptanceCriteria: ["AC-1"],
    status: "pending",
  } as unknown as UserStory;
}

function makeConfig() {
  return makeNaxConfig({
    models: {
      claude: {
        fast: "fast-model",
        balanced: "balanced-model",
        powerful: "powerful-model",
      },
    },
    agent: { default: "claude" },
    execution: {
      rectification: { enabled: false },
      sessionTimeoutSeconds: 300,
    },
    quality: { commands: { test: "bun test" } },
    tdd: { testWriterAllowedPaths: [] },
  });
}

function makeAgent() {
  return makeAgentAdapter({
    name: "claude",
    openSession: mock(async () => ({ id: "mock-session", agentName: "claude" })),
    sendTurn: mock(async () => ({
      output: "done",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 1,
    })),
    closeSession: mock(async () => {}),
  });
}

function makeSessionManager() {
  const descriptor: SessionDescriptor = {
    id: "sess-test",
    role: "implementer",
    state: "CREATED",
    agent: "claude",
    workdir: "/tmp/fake",
    featureName: "feat",
    storyId: "US-001",
    protocolIds: { recordId: null, sessionId: null },
    scratchDir: "/tmp/fake/scratch",
    completedStages: [],
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
  const bindHandle = mock(
    (_id: string, _handle: string, ids: { recordId: string | null; sessionId: string | null }) => {
      descriptor.protocolIds = ids;
      return descriptor;
    },
  );
  const get = mock((id: string) => (id === "sess-test" ? descriptor : undefined));
  const transition = mock((_id: string, to: string) => {
    descriptor.state = to as SessionDescriptor["state"];
    return descriptor;
  });
  const nameFor = mock((_req: { featureName?: string; storyId?: string; role?: string; workdir: string }) =>
    ["nax", "abc12345", _req.featureName, _req.storyId, _req.role]
      .filter(Boolean)
      .join("-"),
  );
  // Stub runInSession that delegates to agentManager.run() and applies bindHandle
  // the same way the real implementation does (ADR-013 Phase 1 signature).
  const runInSession = mock(async (id: string, agentMgr: IAgentManager, request: AgentRunRequest) => {
    transition(id, "RUNNING");
    const result = await agentMgr.run(request);
    if (result.protocolIds && descriptor.handle) {
      bindHandle(id, descriptor.handle, result.protocolIds);
    }
    transition(id, result.success ? "COMPLETED" : "FAILED");
    return result;
  });
  return {
    manager: { get, bindHandle, transition, runInSession, nameFor } as unknown as ISessionManager,
    bindHandle,
    descriptor,
  };
}

let origDeps: Record<string, unknown>;

beforeEach(() => {
  origDeps = {
    autoCommitIfDirty: _sessionRunnerDeps.autoCommitIfDirty,
    getChangedFiles: _sessionRunnerDeps.getChangedFiles,
    verifyTestWriterIsolation: _sessionRunnerDeps.verifyTestWriterIsolation,
    verifyImplementerIsolation: _sessionRunnerDeps.verifyImplementerIsolation,
    captureGitRef: _sessionRunnerDeps.captureGitRef,
    cleanupProcessTree: _sessionRunnerDeps.cleanupProcessTree,
    buildPrompt: _sessionRunnerDeps.buildPrompt,
  };
  _sessionRunnerDeps.autoCommitIfDirty = mock(async () => {});
  _sessionRunnerDeps.getChangedFiles = mock(async () => []);
  _sessionRunnerDeps.verifyTestWriterIsolation = mock(async () => ({
    passed: true,
    violations: [],
    softViolations: [],
    description: "",
  }));
  _sessionRunnerDeps.verifyImplementerIsolation = mock(async () => ({
    passed: true,
    violations: [],
    description: "",
  }));
  _sessionRunnerDeps.captureGitRef = mock(async () => "abc");
  _sessionRunnerDeps.cleanupProcessTree = mock(async () => {});
  _sessionRunnerDeps.buildPrompt = mock(async () => "mock prompt");
});

afterEach(() => {
  Object.assign(_sessionRunnerDeps, origDeps);
});

describe("session-runner bindHandle (#541)", () => {
  test("calls sessionManager.bindHandle with protocolIds when binding is provided", async () => {
    const agent = makeAgent();
    const { manager, bindHandle, descriptor } = makeSessionManager();
    const protocolIds = { recordId: "rec-abc", sessionId: "acp-xyz" };
    // Assign to variable first to avoid excess-property-check on the typed function param.
    const resultWithProtocolIds = {
      success: true,
      exitCode: 0,
      output: "done",
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: 0,
      agentFallbacks: [] as unknown[],
      protocolIds,
    };

    await runTddSession(
      "implementer",
      agent as never,
      fakeAgentManager(agent),
      makeStory(),
      makeConfig(),
      "/tmp/fake",
      "balanced",
      "HEAD",
      undefined,
      false,
      false,
      undefined,
      "feat",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        sessionManager: manager,
        sessionId: "sess-test",
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => ({ result: resultWithProtocolIds, fallbacks: [] }),
        }),
      },
    );

    expect(bindHandle).toHaveBeenCalledTimes(1);
    expect(bindHandle.mock.calls[0]?.[0]).toBe("sess-test");
    expect(bindHandle.mock.calls[0]?.[2]).toEqual({ recordId: "rec-abc", sessionId: "acp-xyz" });
    expect(descriptor.protocolIds).toEqual({ recordId: "rec-abc", sessionId: "acp-xyz" });
  });

  test("skips bindHandle when agent returns no protocolIds", async () => {
    const agent = makeAgent();
    const { manager, bindHandle } = makeSessionManager();

    await runTddSession(
      "test-writer",
      agent as never,
      fakeAgentManager(agent),
      makeStory(),
      makeConfig(),
      "/tmp/fake",
      "balanced",
      "HEAD",
      undefined,
      false,
      false,
      undefined,
      "feat",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        sessionManager: manager,
        sessionId: "sess-test",
        agentManager: makeMockAgentManager(),
      },
    );

    expect(bindHandle).not.toHaveBeenCalled();
  });

  test("skips bindHandle when no binding is provided (backward compat)", async () => {
    const agent = makeAgent();

    // No throw — sessionBinding defaults to undefined.
    const result = await runTddSession(
      "verifier",
      agent as never,
      fakeAgentManager(agent),
      makeStory(),
      makeConfig(),
      "/tmp/fake",
      "balanced",
      "HEAD",
    );
    expect(result.success).toBe(true);
  });
});
