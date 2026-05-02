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
import { makeMockAgentManager } from "../../helpers";

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

    const runFn = mock(async (agentName: string, opts: any) => {
      if (opts?.prompt) {
        capturedPrompts.push(opts.prompt);
      }
      return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
    });
    const mockManager = makeMockAgentManager({
      runFn,
      runAs: mock(async (agentName: string, req: any) => {
        if (req.runOptions?.prompt) {
          capturedPrompts.push(req.runOptions.prompt);
        }
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
      }),
      completeWithFallbackFn: mock(async () => ({ result: { output: "", estimatedCostUsd: 0 }, fallbacks: [] })),
    });

    _rectificationDeps.agentManager = mockManager as any;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    await runRectificationLoop({
      config: makeConfig(false),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).not.toContain("## Root Cause Analysis");
  });

  test("prompt does not contain Root Cause Analysis section when debate is disabled", async () => {
    const capturedPrompts: string[] = [];

    const runFn = mock(async (agentName: string, opts: any) => {
      if (opts?.prompt) {
        capturedPrompts.push(opts.prompt);
      }
      return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
    });
    const mockManager = makeMockAgentManager({
      runFn,
      runAs: mock(async (agentName: string, req: any) => {
        if (req.runOptions?.prompt) {
          capturedPrompts.push(req.runOptions.prompt);
        }
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
      }),
      completeWithFallbackFn: mock(async () => ({ result: { output: "", estimatedCostUsd: 0 }, fallbacks: [] })),
    });

    _rectificationDeps.agentManager = mockManager as any;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    await runRectificationLoop({
      config: makeConfig(false),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
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
    const capturedPrompts: string[] = [];
    let completeCalls = 0;

    const runFn = mock(async (agentName: string, opts: any) => {
      if (opts?.prompt) {
        capturedPrompts.push(opts.prompt);
      }
      return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
    });
    const mockManager = makeMockAgentManager({
      runFn,
      runAs: mock(async (agentName: string, req: any) => {
        if (req.runOptions?.prompt) {
          capturedPrompts.push(req.runOptions.prompt);
        }
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
      }),
      completeFn: mock(async () => {
        completeCalls++;
        return { output: "The root cause is a missing null check.", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      }),
    });

    _rectificationDeps.agentManager = mockManager as any;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(completeCalls).toBeGreaterThan(0);
  });

  test("prepends diagnosis output as '## Root Cause Analysis' section to rectification prompt", async () => {
    const capturedPrompts: string[] = [];
    const diagnosisOutput = "The root cause is a missing null check in the handler.";

    const runFn = mock(async (agentName: string, opts: any) => {
      if (opts?.prompt) {
        capturedPrompts.push(opts.prompt);
      }
      return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
    });
    const mockManager = makeMockAgentManager({
      runFn,
      runAs: mock(async (agentName: string, req: any) => {
        if (req.runOptions?.prompt) {
          capturedPrompts.push(req.runOptions.prompt);
        }
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
      }),
      completeFn: mock(async () => ({ output: diagnosisOutput, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 })),
    });

    _rectificationDeps.agentManager = mockManager as any;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain("## Root Cause Analysis");
  });

  test("diagnosis section appears before the rectification prompt body", async () => {
    const capturedPrompts: string[] = [];
    const diagnosisOutput = "Root cause: missing validation.";

    const mockManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: (name: string) => (name === "claude" ? {} as any : null),
      runFn: async (_agentName: string, opts: any) => {
        if (opts?.prompt) {
          capturedPrompts.push(opts.prompt);
        }
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
      },
      completeAsFn: async () => ({ result: { output: diagnosisOutput, estimatedCostUsd: 0 }, fallbacks: [] }),
    });

    _rectificationDeps.agentManager = mockManager as any;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
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
      getDefaultAgent: "claude",
      getAgentFn: (name: string) => (name === "claude" ? {} as any : null),
      runFn: async (_agentName: string, opts: any) => {
        if (opts?.prompt) {
          capturedPrompts.push(opts.prompt);
        }
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCostUsd: 0, agentFallbacks: [] };
      },
      completeAsFn: async () => {
        throw new Error("Debate agent failed");
      },
    });

    _rectificationDeps.agentManager = mockManager as any;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).not.toContain("## Root Cause Analysis");
  });

  test("rectification still runs and returns result even when debate fails", async () => {
    const mockManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: (name: string) => (name === "claude" ? {} as any : null),
      runFn: async () => ({
        success: true,
        exitCode: 0,
        output: "done",
        rateLimited: false,
        durationMs: 10,
        estimatedCostUsd: 0,
        agentFallbacks: [] as unknown[],
      }),
      completeAsFn: async () => {
        throw new Error("All debaters failed");
      },
    });

    _rectificationDeps.agentManager = mockManager as any;
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass", status: "SUCCESS" as const, countsTowardEscalation: true }));

    const result = await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(result.succeeded).toBe(true);
  });
});
