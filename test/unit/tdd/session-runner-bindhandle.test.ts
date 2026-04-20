/**
 * Tests for session-runner.ts — #541: TDD session binds protocolIds to the
 * pre-created session descriptor so the audit trail is not left with null IDs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult, AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import type { ISessionManager, SessionDescriptor } from "../../../src/session/types";
import { _sessionRunnerDeps, runTddSession } from "../../../src/tdd/session-runner";

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Impl story",
    description: "Do the thing",
    acceptanceCriteria: ["AC-1"],
    status: "pending",
  } as unknown as UserStory;
}

function makeConfig(): NaxConfig {
  return {
    models: {
      claude: {
        fast: { model: "fast-model" },
        balanced: { model: "balanced-model" },
        powerful: { model: "powerful-model" },
      },
    },
    agent: { default: "claude" },
    execution: {
      rectification: { enabled: false },
      sessionTimeoutSeconds: 300,
      dangerouslySkipPermissions: true,
    },
    quality: { commands: { test: "bun test" } },
    tdd: { testWriterAllowedPaths: [] },
  } as unknown as NaxConfig;
}

function makeAgent(protocolIds: { recordId: string | null; sessionId: string | null } | undefined) {
  const run = mock(
    async (_opts: AgentRunOptions): Promise<AgentResult> => ({
      success: true,
      exitCode: 0,
      output: "done",
      rateLimited: false,
      durationMs: 100,
      estimatedCost: 0,
      ...(protocolIds ? { protocolIds } : {}),
    }),
  );
  return {
    run,
    isInstalled: mock(async () => true),
    complete: mock(async () => ""),
    buildCommand: mock(() => []),
    deriveSessionName: mock((_d: SessionDescriptor) => "nax-abc12345-feat-US-001-implementer"),
  };
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
  // Phase 2: stub runInSession that delegates to the runner and applies bindHandle
  // the same way the real implementation does. Required so runTddSession's
  // sessionBinding path works against the test mock.
  const runInSession = mock(async (id: string, runner: (opts: unknown) => Promise<AgentResult>, opts: unknown) => {
    transition(id, "RUNNING");
    const result = await runner(opts);
    if (result.protocolIds && descriptor.handle) {
      bindHandle(id, descriptor.handle, result.protocolIds);
    }
    transition(id, result.success ? "COMPLETED" : "FAILED");
    return result;
  });
  return {
    manager: { get, bindHandle, transition, runInSession } as unknown as ISessionManager,
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
    const agent = makeAgent({ recordId: "rec-abc", sessionId: "acp-xyz" });
    const { manager, bindHandle, descriptor } = makeSessionManager();

    await runTddSession(
      "implementer",
      agent as never,
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
      { sessionManager: manager, sessionId: "sess-test" },
    );

    expect(bindHandle).toHaveBeenCalledTimes(1);
    expect(bindHandle.mock.calls[0]?.[0]).toBe("sess-test");
    expect(bindHandle.mock.calls[0]?.[2]).toEqual({ recordId: "rec-abc", sessionId: "acp-xyz" });
    expect(descriptor.protocolIds).toEqual({ recordId: "rec-abc", sessionId: "acp-xyz" });
  });

  test("skips bindHandle when agent returns no protocolIds", async () => {
    const agent = makeAgent(undefined);
    const { manager, bindHandle } = makeSessionManager();

    await runTddSession(
      "test-writer",
      agent as never,
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
      { sessionManager: manager, sessionId: "sess-test" },
    );

    expect(bindHandle).not.toHaveBeenCalled();
  });

  test("skips bindHandle when no binding is provided (backward compat)", async () => {
    const agent = makeAgent({ recordId: "rec-abc", sessionId: "acp-xyz" });

    // No throw — sessionBinding defaults to undefined.
    const result = await runTddSession(
      "verifier",
      agent as never,
      makeStory(),
      makeConfig(),
      "/tmp/fake",
      "balanced",
      "HEAD",
    );
    expect(result.success).toBe(true);
  });
});
