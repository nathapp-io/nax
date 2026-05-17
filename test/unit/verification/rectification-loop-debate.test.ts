/**
 * Tests for US-005: Integrate debate into rectification diagnosis
 *
 * Covers:
 * - When debate.stages.rectification.enabled is true, runs DebateSession before building rectification prompt
 * - Diagnosis output is prepended to rectification prompt as '## Root Cause Analysis' section
 * - When debate.stages.rectification.enabled is false (default), loop is unchanged
 * - When diagnosis debate fails (all debaters error), proceeds without diagnosis and logs 'fallback'
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _rectificationDeps, runRectificationLoop } from "../../../src/verification/rectification-loop";
import {
  FAILING_TEST_OUTPUT,
  makeConfig,
  makeStory,
} from "./_rectification-debate-helpers";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// debate integration — debate.stages.rectification.enabled = false (default)
// ─────────────────────────────────────────────────────────────────────────────

describe("runRectificationLoop — debate disabled (default)", () => {
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;

  afterEach(() => {
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    mock.restore();
  });

  test("does not call DebateSession when debate.stages.rectification.enabled is false", async () => {
    const capturedPrompts: string[] = [];

    const mockManager = makeMockAgentManager({
      runAsSessionFn: mock(async (_agentName: string, _handle: any, prompt: string, _opts: any) => {
        capturedPrompts.push(prompt);
        return { output: "done", estimatedCostUsd: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }),
    });

    _rectificationDeps.agentManager = mockManager;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    const runtime = {
      sessionManager: makeSessionManager(),
      signal: undefined as any,
    } as any;

    await runRectificationLoop({
      config: makeConfig(false),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockManager,
      runtime,
    });

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).not.toContain("## Root Cause Analysis");
  });

  test("prompt does not contain Root Cause Analysis section when debate is disabled", async () => {
    const capturedPrompts: string[] = [];

    const mockManager = makeMockAgentManager({
      runAsSessionFn: mock(async (_agentName: string, _handle: any, prompt: string, _opts: any) => {
        capturedPrompts.push(prompt);
        return { output: "done", estimatedCostUsd: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }),
    });

    _rectificationDeps.agentManager = mockManager;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    const runtime = {
      sessionManager: makeSessionManager(),
      signal: undefined as any,
    } as any;

    await runRectificationLoop({
      config: makeConfig(false),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockManager,
      runtime,
    });

    for (const p of capturedPrompts) {
      expect(p).not.toContain("## Root Cause Analysis");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// debate integration — debate.stages.rectification.enabled = true
// ─────────────────────────────────────────────────────────────────────────────

describe("runRectificationLoop — debate enabled", () => {
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;

  afterEach(() => {
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    mock.restore();
  });

  test("runs DebateSession before building rectification prompt when debate.stages.rectification.enabled is true", async () => {
    let completeCalls = 0;

    const mockManager = makeMockAgentManager({
      runAsSessionFn: mock(async () => ({
        output: "done",
        estimatedCostUsd: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })),
      completeFn: mock(async () => {
        completeCalls++;
        return { output: "The root cause is a missing null check.", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      }),
    });

    _rectificationDeps.agentManager = mockManager;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    const runtime = {
      sessionManager: makeSessionManager(),
      signal: undefined as any,
    } as any;

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockManager,
      runtime,
    });

    expect(completeCalls).toBeGreaterThan(0);
  });

  test("prepends diagnosis output as '## Root Cause Analysis' section to rectification prompt", async () => {
    const capturedPrompts: string[] = [];
    const diagnosisOutput = "The root cause is a missing null check in the handler.";

    const mockManager = makeMockAgentManager({
      runAsSessionFn: mock(async (_agentName: string, _handle: any, prompt: string, _opts: any) => {
        capturedPrompts.push(prompt);
        return { output: "done", estimatedCostUsd: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }),
      completeFn: mock(async () => ({ output: diagnosisOutput, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 })),
    });

    _rectificationDeps.agentManager = mockManager;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    const runtime = {
      sessionManager: makeSessionManager(),
      signal: undefined as any,
    } as any;

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockManager,
      runtime,
    });

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain("## Root Cause Analysis");
  });

  test("diagnosis section appears before the rectification prompt body", async () => {
    const capturedPrompts: string[] = [];
    const diagnosisOutput = "Root cause: missing validation.";

    const mockManager = makeMockAgentManager({
      runAsSessionFn: mock(async (_agentName: string, _handle: any, prompt: string, _opts: any) => {
        capturedPrompts.push(prompt);
        return { output: "done", estimatedCostUsd: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }),
      completeAsFn: async () => ({ output: diagnosisOutput, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
    });

    _rectificationDeps.agentManager = mockManager;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    const runtime = {
      sessionManager: makeSessionManager(),
      signal: undefined as any,
    } as any;

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockManager,
      runtime,
    });

    expect(capturedPrompts).toHaveLength(1);
    const rcaIndex = capturedPrompts[0].indexOf("## Root Cause Analysis");
    const rectificationIndex = capturedPrompts[0].indexOf("# Rectification Required");
    expect(rcaIndex).toBeGreaterThanOrEqual(0);
    expect(rectificationIndex).toBeGreaterThan(rcaIndex);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// debate fallback — all debaters fail
// ─────────────────────────────────────────────────────────────────────────────

describe("runRectificationLoop — debate fallback when all debaters fail", () => {
  const origAgentManager = _rectificationDeps.agentManager;
  const origRunVerification = _rectificationDeps.runVerification;

  afterEach(() => {
    _rectificationDeps.agentManager = origAgentManager;
    _rectificationDeps.runVerification = origRunVerification;
    mock.restore();
  });

  test("proceeds without diagnosis section when debate fails (all debaters error)", async () => {
    const capturedPrompts: string[] = [];

    const mockManager = makeMockAgentManager({
      runAsSessionFn: mock(async (_agentName: string, _handle: any, prompt: string, _opts: any) => {
        capturedPrompts.push(prompt);
        return { output: "done", estimatedCostUsd: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }),
      completeAsFn: async () => {
        throw new Error("Debate agent failed");
      },
    });

    _rectificationDeps.agentManager = mockManager;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    const runtime = {
      sessionManager: makeSessionManager(),
      signal: undefined as any,
    } as any;

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockManager,
      runtime,
    });

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).not.toContain("## Root Cause Analysis");
  });

  test("rectification still runs and returns result even when debate fails", async () => {
    const mockManager = makeMockAgentManager({
      runAsSessionFn: mock(async () => ({
        output: "done",
        estimatedCostUsd: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      })),
      completeAsFn: async () => {
        throw new Error("All debaters failed");
      },
    });

    _rectificationDeps.agentManager = mockManager;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    const runtime = {
      sessionManager: makeSessionManager(),
      signal: undefined as any,
    } as any;

    const result = await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
      agentManager: mockManager,
      runtime,
    });

    expect(result.succeeded).toBe(true);
  });
});
