/**
 * Tests for rectification-gate.ts — session reuse across rectification attempts.
 *
 * Uses injectable _rectificationGateDeps instead of mock.module() to avoid
 * permanent module replacement that contaminates other test files.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult, AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { _rectificationGateDeps, runFullSuiteGate } from "../../../src/tdd/rectification-gate";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FAILING_OUTPUT = "✗ some test [1ms]\n(fail) some test\nerror: Expected 1\n 34 fail\n 0 pass";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Test story",
    description: "Desc",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function makeConfig(maxRetries = 2): NaxConfig {
  return {
    models: { claude: { fast: { model: "fast-model" }, balanced: { model: "balanced-model" }, powerful: { model: "powerful-model" } } },
    autoMode: { defaultAgent: "claude" },
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

function makeAgent(runResults: Partial<AgentResult>[] = []) {
  let callIndex = 0;
  const calls: AgentRunOptions[] = [];
  const run = mock(async (opts: AgentRunOptions): Promise<AgentResult> => {
    calls.push({ ...opts });
    const result = runResults[callIndex] ?? { success: true };
    callIndex++;
    return {
      success: true,
      exitCode: 0,
      output: "agent done",
      rateLimited: false,
      durationMs: 100,
      estimatedCost: 0.01,
      ...result,
    };
  });
  return { run, calls, isInstalled: mock(async () => true), complete: mock(async () => ""), buildCommand: mock(() => []) };
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
  test("all attempts use the same acpSessionName", async () => {
    const story = makeStory();
    const config = makeConfig(2); // maxRetries=2
    const agent = makeAgent();

    // Suite always fails so both rectification attempts run
    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // initial gate
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 1
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 2 (final check)
    ];

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agent as any, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any, "my-feature");

    expect(agent.calls.length).toBe(2); // both attempts ran

    const sessionNames = agent.calls.map((c) => c.acpSessionName);
    // Both attempts must share the same session name
    expect(sessionNames[0]).toBeDefined();
    expect(sessionNames[0]).toBe(sessionNames[1]);
  });

  test("keepSessionOpen=true for all attempts except the last", async () => {
    const story = makeStory();
    const config = makeConfig(3); // maxRetries=3 — three attempts
    const agent = makeAgent();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // initial gate
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 1
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 2
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 3 (final)
    ];

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agent as any, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any, "my-feature");

    expect(agent.calls.length).toBe(3);

    // Attempts 1 and 2 (not last): keepSessionOpen=true
    expect(agent.calls[0]!.keepSessionOpen).toBe(true);
    expect(agent.calls[1]!.keepSessionOpen).toBe(true);
    // Last attempt: keepSessionOpen=false so session closes normally
    expect(agent.calls[2]!.keepSessionOpen).toBe(false);
  });

  test("session closes on the last attempt (keepSessionOpen=false or undefined)", async () => {
    const story = makeStory();
    const config = makeConfig(2);
    const agent = makeAgent();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
    ];

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agent as any, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any);

    expect(agent.calls.length).toBe(2);
    // Last attempt must NOT set keepSessionOpen=true
    expect(agent.calls[1]!.keepSessionOpen).not.toBe(true);
  });

  test("all attempts use the same session name even without featureName", async () => {
    const story = makeStory({ id: "US-002" });
    const config = makeConfig(2);
    const agent = makeAgent();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
    ];

    await runFullSuiteGate(story, config, "/tmp/fake-workdir-2", agent as any, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any); // no featureName

    expect(agent.calls.length).toBe(2);
    const [name1, name2] = agent.calls.map((c) => c.acpSessionName);
    expect(name1).toBeDefined();
    expect(name1).toBe(name2);
  });
});
