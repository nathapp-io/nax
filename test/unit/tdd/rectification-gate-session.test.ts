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

function makeAgent(runResults: Partial<AgentResult>[] = []) {
  let callIndex = 0;
  const calls: AgentRunOptions[] = [];
  const run = async (_opts: AgentRunOptions): Promise<AgentResult> => {
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
  };
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
  test("all attempts use the same sessionRole", async () => {
    const story = makeStory();
    const config = makeConfig(2); // maxRetries=2
    const agent = makeAgent();

    // Suite always fails so both rectification attempts run
    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // initial gate
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 1
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 2 (final check)
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: (_name: string) => agent as any,
      runFn: async (_agentName: string, opts: AgentRunOptions) => {
        agent.calls.push(opts);
        const result = await agent.run(opts);
        return { success: result.success, exitCode: result.exitCode, output: result.output, rateLimited: result.rateLimited, durationMs: result.durationMs, estimatedCost: result.estimatedCost, agentFallbacks: [] };
      },
    });

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agentManager, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any, "my-feature");

    expect(agent.calls.length).toBe(2); // both attempts ran

    // The adapter auto-derives session handle from featureName + storyId + sessionRole.
    // Both attempts must share the same sessionRole so the adapter uses the same session.
    const sessionRoles = agent.calls.map((c) => c.sessionRole);
    expect(sessionRoles[0]).toBeDefined();
    expect(sessionRoles[0]).toBe(sessionRoles[1]);
  });

  test("keepOpen=true for all attempts except the last", async () => {
    const story = makeStory();
    const config = makeConfig(3); // maxRetries=3 — three attempts
    const agent = makeAgent();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // initial gate
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 1
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 2
      { success: false, exitCode: 1, output: FAILING_OUTPUT }, // after attempt 3 (final)
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: (_name: string) => agent as any,
      runFn: async (_agentName: string, opts: AgentRunOptions) => {
        agent.calls.push(opts);
        const result = await agent.run(opts);
        return { success: result.success, exitCode: result.exitCode, output: result.output, rateLimited: result.rateLimited, durationMs: result.durationMs, estimatedCost: result.estimatedCost, agentFallbacks: [] };
      },
    });

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agentManager, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any, "my-feature");

    expect(agent.calls.length).toBe(3);

    // Attempts 1 and 2 (not last): keepOpen=true
    expect(agent.calls[0]!.keepOpen).toBe(true);
    expect(agent.calls[1]!.keepOpen).toBe(true);
    // Last attempt: keepOpen=false so session closes normally
    expect(agent.calls[2]!.keepOpen).toBe(false);
  });

  test("session closes on the last attempt (keepOpen=false or undefined)", async () => {
    const story = makeStory();
    const config = makeConfig(2);
    const agent = makeAgent();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: (_name: string) => agent as any,
      runFn: async (_agentName: string, opts: AgentRunOptions) => {
        agent.calls.push(opts);
        const result = await agent.run(opts);
        return { success: result.success, exitCode: result.exitCode, output: result.output, rateLimited: result.rateLimited, durationMs: result.durationMs, estimatedCost: result.estimatedCost, agentFallbacks: [] };
      },
    });

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agentManager, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any);

    expect(agent.calls.length).toBe(2);
    // Last attempt must NOT set keepOpen=true
    expect(agent.calls[1]!.keepOpen).not.toBe(true);
  });

  test("all attempts use the same sessionRole even without featureName", async () => {
    const story = makeStory({ id: "US-002" });
    const config = makeConfig(2);
    const agent = makeAgent();

    mockSuiteResults = [
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
      { success: false, exitCode: 1, output: FAILING_OUTPUT },
    ];

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: (_name: string) => agent as any,
      runFn: async (_agentName: string, opts: AgentRunOptions) => {
        agent.calls.push(opts);
        const result = await agent.run(opts);
        return { success: result.success, exitCode: result.exitCode, output: result.output, rateLimited: result.rateLimited, durationMs: result.durationMs, estimatedCost: result.estimatedCost, agentFallbacks: [] };
      },
    });

    await runFullSuiteGate(story, config, "/tmp/fake-workdir-2", agentManager, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any); // no featureName

    expect(agent.calls.length).toBe(2);
    const [role1, role2] = agent.calls.map((c) => c.sessionRole);
    expect(role1).toBeDefined();
    expect(role1).toBe(role2);
  });

  test("includes raw test output in the TDD rectification prompt when failures are unmapped", async () => {
    const story = makeStory({ id: "US-UNMAPPED" });
    const config = makeConfig(1);
    const agent = makeAgent();
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

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: (_name: string) => agent as any,
      runFn: async (_agentName: string, opts: AgentRunOptions) => {
        agent.calls.push(opts);
        const result = await agent.run(opts);
        return { success: result.success, exitCode: result.exitCode, output: result.output, rateLimited: result.rateLimited, durationMs: result.durationMs, estimatedCost: result.estimatedCost, agentFallbacks: [] };
      },
    });

    await runFullSuiteGate(story, config, "/tmp/fake-workdir", agentManager, "balanced", true, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any, "my-feature");

    expect(agent.calls.length).toBe(1);
    expect(agent.calls[0]?.prompt).toContain("Unmapped test failures (2 detected)");
    expect(agent.calls[0]?.prompt).toContain("Structured test failure parsing returned no failure records");
    expect(agent.calls[0]?.prompt).toContain("Cannot find name 'missingSymbol'");
  });
});
