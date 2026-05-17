/**
 * Tests for rectification-gate.ts — session reuse across rectification attempts.
 *
 * Uses injectable _rectificationGateDeps instead of mock.module() to avoid
 * permanent module replacement that contaminates other test files.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { _rectificationGateDeps, runFullSuiteGate } from "../../../src/tdd/rectification-gate";
import { makeMockAgentManager } from "../../helpers/mock-agent-manager";
import { makeStory } from "../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FAILING_OUTPUT = "✗ some test [1ms]\n(fail) some test\nerror: Expected 1\n 34 fail\n 0 pass";

function makeConfig(maxRetries = 2): NaxConfig {
  return {
    models: { claude: { fast: { model: "fast-model" }, balanced: { model: "balanced-model" }, powerful: { model: "powerful-model" } } },
    agent: { default: "claude" },
    execution: {
      rectification: {
        enabled: true,
        maxRetries,
        fullSuiteTimeoutSeconds: 60,
        maxFailureSummaryChars: 1000,
      },
      sessionTimeoutSeconds: 300,
      dangerouslySkipPermissions: true,
    },
    quality: { commands: { test: "bun test" } },
  } as unknown as NaxConfig;
}

function makeRuntime(handleOverrides: Record<string, unknown> = {}) {
  const handle = {
    id: "nax-rectify",
    agentName: "claude",
    ...handleOverrides,
  };
  const sessionManager = {
    openSession: mock(async () => handle),
    closeSession: mock(async () => {}),
    bindHandle: mock(() => {}),
  };
  return {
    sessionManager,
    signal: new AbortController().signal,
    handle,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock injectable deps instead of using mock.module()
// ─────────────────────────────────────────────────────────────────────────────

let mockSuiteResults: Array<{ success: boolean; exitCode: number; output: string }> = [];
let suiteCallCount = 0;

let origDeps: typeof _rectificationGateDeps;

beforeEach(() => {
  suiteCallCount = 0;
  mockSuiteResults = [];

  origDeps = {
    executeWithTimeout: _rectificationGateDeps.executeWithTimeout,
    parseTestOutput: _rectificationGateDeps.parseTestOutput,
    shouldRetryRectification: _rectificationGateDeps.shouldRetryRectification,
    resolveTestCommands: _rectificationGateDeps.resolveTestCommands,
  };

  // Mock via injectable deps
  _rectificationGateDeps.executeWithTimeout = mock(async () => {
    const r = mockSuiteResults[suiteCallCount] ?? { success: false, exitCode: 1, output: FAILING_OUTPUT };
    suiteCallCount++;
    return r;
  }) as any;
  _rectificationGateDeps.parseTestOutput = mock((output: string) => ({
    failed: output.includes("34 fail") ? 34 : 0,
    passed: 0,
    failures: [{ file: "some.test.ts", testName: "some test", error: "Expected 1", stackTrace: [] }],
  })) as any;
  _rectificationGateDeps.shouldRetryRectification = mock(
    (state: { attempt: number; currentFailures: number }, cfg: { maxRetries: number }) =>
      state.attempt < cfg.maxRetries && state.currentFailures > 0,
  ) as any;
});

afterEach(() => {
  Object.assign(_rectificationGateDeps, origDeps);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("rectification session reuse", () => {
  // AC3: runAsSession is invoked; agentManager.run is never called.
  // AC6: closeSession called once in finally after loop exits normally.
  test("uses runtime runAsSession branch so each rectification attempt emits dispatch events", async () => {
    const story = makeStory();
    const config = makeConfig(2);
    const { sessionManager } = makeRuntime({ protocolIds: { recordId: "rec-1", sessionId: "sess-1" } });

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runAsSessionFn: async () => ({
        output: "fixed something",
        tokenUsage: { inputTokens: 1, outputTokens: 2 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      }),
      runFn: async () => {
        throw new Error("legacy run path should not be used when runtime is provided");
      },
    });
    const runtime = {
      sessionManager,
      signal: new AbortController().signal,
    };

    await runFullSuiteGate(
      story,
      config,
      "/tmp/fake-workdir",
      agentManager,
      "balanced",
      true,
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      "my-feature",
      "/tmp/project",
      undefined,
      runtime as any,
    );

    expect(agentManager.runAsSession).toHaveBeenCalledTimes(2);
    expect(agentManager.run).not.toHaveBeenCalled();
    expect(runtime.sessionManager.openSession).toHaveBeenCalledTimes(1);
    expect(runtime.sessionManager.closeSession).toHaveBeenCalledTimes(1);
  });

  // AC3: all runAsSession calls use sessionRole "implementer"; run is never called.
  test("all attempts use the same sessionRole", async () => {
    const story = makeStory();
    const config = makeConfig(2); // maxRetries=2
    const { sessionManager } = makeRuntime();

    // Suite always fails so both rectification attempts run
    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // initial gate
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 1
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 2 (final check)
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runAsSessionFn: async () => ({
        output: "agent done",
        tokenUsage: { inputTokens: 1, outputTokens: 2 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      }),
      runFn: async () => {
        throw new Error("legacy run path should not be invoked");
      },
    });
    const runtime = { sessionManager, signal: new AbortController().signal };

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agentManager, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any, "my-feature", undefined, undefined, runtime as any);

    expect(agentManager.run).not.toHaveBeenCalled();

    const calls = (agentManager.runAsSession as any).mock.calls as Array<[string, unknown, string, { sessionRole?: string }]>;
    expect(calls.length).toBe(2);
    const sessionRoles = calls.map(([, , , opts]) => opts.sessionRole);
    expect(sessionRoles[0]).toBeDefined();
    expect(sessionRoles[0]).toBe(sessionRoles[1]);
  });

  // AC3: consistent sessionRole across 3 attempts.
  test("all attempts use the same sessionRole across retry attempts", async () => {
    const story = makeStory();
    const config = makeConfig(3); // maxRetries=3 — three attempts
    const { sessionManager } = makeRuntime();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // initial gate
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 1
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 2
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 3 (final)
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runAsSessionFn: async () => ({
        output: "agent done",
        tokenUsage: { inputTokens: 1, outputTokens: 2 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      }),
      runFn: async () => {
        throw new Error("legacy run path should not be invoked");
      },
    });
    const runtime = { sessionManager, signal: new AbortController().signal };

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agentManager, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any, "my-feature", undefined, undefined, runtime as any);

    expect(agentManager.run).not.toHaveBeenCalled();

    const calls = (agentManager.runAsSession as any).mock.calls as Array<[string, unknown, string, { sessionRole?: string }]>;
    expect(calls.length).toBe(3);
    const sessionRoles = calls.map(([, , , opts]) => opts.sessionRole);
    expect(sessionRoles[0]).toBeDefined();
    expect(sessionRoles[0]).toBe(sessionRoles[1]);
    expect(sessionRoles[1]).toBe(sessionRoles[2]);
  });

  // Replaces "keepOpen" test: spec behavior is that the held session handle is reused
  // across all attempts (openSession called once; runAsSession called N times with same handle).
  test("held session handle is reused across all rectification attempts (openSession called once)", async () => {
    const story = makeStory();
    const config = makeConfig(3); // maxRetries=3
    const { sessionManager } = makeRuntime();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // initial gate
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 1
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 2
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 3 (final)
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runAsSessionFn: async () => ({
        output: "agent done",
        tokenUsage: { inputTokens: 1, outputTokens: 2 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      }),
      runFn: async () => {
        throw new Error("legacy run path should not be invoked");
      },
    });
    const runtime = { sessionManager, signal: new AbortController().signal };

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agentManager, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any, "my-feature", undefined, undefined, runtime as any);

    // Session opened once and reused across all attempts — this is the spec equivalent
    // of the legacy keepOpen flag. Handle is closed once in the finally at loop exit.
    expect(sessionManager.openSession).toHaveBeenCalledTimes(1);
    expect(agentManager.runAsSession).toHaveBeenCalledTimes(3);
    expect(agentManager.run).not.toHaveBeenCalled();
    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
  });

  // AC3: sessionRole consistency even without featureName.
  test("all attempts use the same sessionRole even without featureName", async () => {
    const story = makeStory({ id: "US-002" });
    const config = makeConfig(2);
    const { sessionManager } = makeRuntime();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runAsSessionFn: async () => ({
        output: "agent done",
        tokenUsage: { inputTokens: 1, outputTokens: 2 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      }),
      runFn: async () => {
        throw new Error("legacy run path should not be invoked");
      },
    });
    const runtime = { sessionManager, signal: new AbortController().signal };

    await runFullSuiteGate(story, config, "/tmp/fake-workdir-2", agentManager, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any, undefined, undefined, undefined, runtime as any); // no featureName

    expect(agentManager.run).not.toHaveBeenCalled();

    const calls = (agentManager.runAsSession as any).mock.calls as Array<[string, unknown, string, { sessionRole?: string }]>;
    expect(calls.length).toBe(2);
    const [role1, role2] = calls.map(([, , , opts]) => opts.sessionRole);
    expect(role1).toBeDefined();
    expect(role1).toBe(role2);
  });

  test("defers unattributable failures to run-level regression instead of rectifying", async () => {
    const story = makeStory({ id: "US-UNMAPPED" });
    const config = makeConfig(1);
    const warn = mock(() => {});
    const unmappedOutput = `
test/example.test.ts:
✓ passing test [0.5ms]
✗ compile failure 1 [1.2ms]
✗ compile failure 2 [1.3ms]

src/foo.ts:12:8 - error TS2304: Cannot find name 'missingSymbol'

3 passed, 2 failed [1.7ms]
    `.trim();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: unmappedOutput },
      { success: false, exitCode: 1, output: unmappedOutput },
    ];

    _rectificationGateDeps.parseTestOutput = mock((_output: string) => ({
      failed: 2,
      passed: 3,
      failures: [],
    })) as any;

    const agentManager = makeMockAgentManager({ getDefaultAgent: "claude" });
    const { sessionManager } = makeRuntime();
    const runtime = { sessionManager, signal: new AbortController().signal };

    const result = await runFullSuiteGate(story, config, "/tmp/fake-workdir", agentManager, "balanced", true, {
      info: () => {},
      warn,
      error: () => {},
      debug: () => {},
    } as any, "my-feature", undefined, undefined, runtime as any);

    expect(result.passed).toBe(true);
    expect(result.fullSuiteGatePassed).toBe(false);
    expect(result.status).toBe("deferred-unattributable");
    // Rectification loop must NOT be entered — neither run nor runAsSession called (AC3).
    expect(agentManager.run).not.toHaveBeenCalled();
    expect(agentManager.runAsSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // AC4: bindHandle is called when sessionId is provided and attempt result includes protocolIds.
  test("calls runtime.sessionManager.bindHandle when sessionId is provided and protocolIds present", async () => {
    const story = makeStory({ id: "US-AC4" });
    const config = makeConfig(1);
    const protocolIds = { recordId: "rec-abc", sessionId: "sess-abc" };
    const { sessionManager } = makeRuntime({ protocolIds });

    // Initial suite fails, rectification attempt runs, then suite passes.
    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: true, exitCode: 0, output: "" },
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runAsSessionFn: async () => ({
        output: "fixed",
        tokenUsage: { inputTokens: 1, outputTokens: 2 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      }),
    });
    const runtime = { sessionManager, signal: new AbortController().signal };

    await runFullSuiteGate(
      story,
      config,
      "/tmp/fake-workdir",
      agentManager,
      "balanced",
      true,
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      "my-feature",
      "/tmp/project",
      "the-session-id", // sessionId provided → bindHandle must be called
      runtime as any,
    );

    expect(sessionManager.bindHandle).toHaveBeenCalledTimes(1);
    expect(sessionManager.bindHandle).toHaveBeenCalledWith(
      "the-session-id",
      expect.any(String),
      protocolIds,
    );
  });

  // AC5: bindHandle is NOT called when sessionId is absent.
  test("does not call runtime.sessionManager.bindHandle when sessionId is absent", async () => {
    const story = makeStory({ id: "US-AC5" });
    const config = makeConfig(1);
    const protocolIds = { recordId: "rec-xyz", sessionId: "sess-xyz" };
    const { sessionManager } = makeRuntime({ protocolIds });

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: true, exitCode: 0, output: "" },
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runAsSessionFn: async () => ({
        output: "fixed",
        tokenUsage: { inputTokens: 1, outputTokens: 2 },
        estimatedCostUsd: 0.01,
        internalRoundTrips: 1,
      }),
    });
    const runtime = { sessionManager, signal: new AbortController().signal };

    await runFullSuiteGate(
      story,
      config,
      "/tmp/fake-workdir",
      agentManager,
      "balanced",
      true,
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      "my-feature",
      "/tmp/project",
      undefined, // no sessionId → bindHandle must NOT be called
      runtime as any,
    );

    expect(sessionManager.bindHandle).not.toHaveBeenCalled();
  });

  // AC7: when a non-retryable error clears heldHandle in the catch block, the finally
  // does NOT call closeSession a second time (no double-close).
  test("does not double-close session when non-retryable error clears heldHandle in catch", async () => {
    const story = makeStory({ id: "US-AC7" });
    const config = makeConfig(1);
    const { sessionManager } = makeRuntime();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runAsSessionFn: async () => {
        throw new Error("non-retryable agent error");
      },
    });
    const runtime = { sessionManager, signal: new AbortController().signal };

    try {
      await runFullSuiteGate(
        story,
        config,
        "/tmp/fake-workdir",
        agentManager,
        "balanced",
        true,
        { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
        "my-feature",
        "/tmp/project",
        undefined,
        runtime as any,
      );
    } catch {
      // Expected: non-retryable error propagates out of runFullSuiteGate.
    }

    // closeSession called exactly once (in the catch error handler) — NOT again in the finally.
    expect(sessionManager.openSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
  });
});
