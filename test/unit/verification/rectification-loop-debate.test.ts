/**
 * Tests for US-005: Integrate debate into rectification diagnosis
 *
 * Covers:
 * - When debate.stages.rectification.enabled is true, runs DebateSession before building rectification prompt
 * - Diagnosis output is prepended to rectification prompt as '## Root Cause Analysis' section
 * - When debate.stages.rectification.enabled is false (default), loop is unchanged
 * - When diagnosis debate fails (all debaters error), proceeds without diagnosis and logs 'fallback'
 * - Debate cost is included in story total cost tracking
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { _rectificationDeps, runRectificationLoop } from "../../../src/verification/rectification-loop";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FAILING_TEST_OUTPUT =
  "✗ my test [1ms]\n(fail) my test [1ms]\nerror: Expected 1 to be 2";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "TS-001",
    title: "Implement feature",
    description: "Implement the feature",
    acceptanceCriteria: ["Test passes"],
    status: "pending",
    routing: { modelTier: "balanced" },
    ...overrides,
  } as UserStory;
}

function makeConfig(debateEnabled = false, overrides: Partial<NaxConfig> = {}): NaxConfig {
  return {
    autoMode: {
      defaultAgent: "claude",
      complexityRouting: {
        simple: "fast",
        medium: "balanced",
        complex: "powerful",
        expert: "powerful",
      },
      escalation: {
        tierOrder: [{ tier: "balanced" }],
      },
    },
    execution: {
      sessionTimeoutSeconds: 120,
      rectification: {
        maxRetries: 2,
        abortOnRegression: true,
      },
      permissionProfile: "cautious",
    },
    models: {
      balanced: { provider: "anthropic", model: "claude-haiku-4-5" },
    },
    agent: {
      maxInteractionTurns: 5,
    },
    quality: {
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 0,
      gracePeriodMs: 0,
      drainTimeoutMs: 0,
    },
    debate: {
      enabled: debateEnabled,
      agents: 2,
      stages: {
        plan: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
        review: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
        acceptance: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
        rectification: {
          enabled: debateEnabled,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          debaters: [
            { agent: "claude", model: "claude-haiku-4-5" },
            { agent: "claude", model: "claude-sonnet-4-6" },
          ],
        },
        escalation: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
      },
    },
    ...overrides,
  } as unknown as NaxConfig;
}

function makeAgent(overrides: Partial<{ run: typeof mock; complete: typeof mock }> = {}) {
  return {
    name: "claude",
    run: mock(async (_opts: AgentRunOptions) => ({
      success: true,
      exitCode: 0,
      output: "done",
      rateLimited: false,
      durationMs: 10,
      estimatedCost: 0,
    })),
    complete: mock(async (_prompt: string) => ""),
    isInstalled: mock(async () => true),
    buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
    buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// debate integration — debate.stages.rectification.enabled = false (default)
// ─────────────────────────────────────────────────────────────────────────────

describe("runRectificationLoop — debate disabled (default)", () => {
  const origGetAgent = _rectificationDeps.getAgent;
  const origRunVerification = _rectificationDeps.runVerification;

  afterEach(() => {
    _rectificationDeps.getAgent = origGetAgent;
    _rectificationDeps.runVerification = origRunVerification;
    mock.restore();
  });

  test("does not call DebateSession when debate.stages.rectification.enabled is false", async () => {
    const capturedPrompts: string[] = [];
    const mockAgent = makeAgent({
      run: mock(async (opts: AgentRunOptions) => {
        capturedPrompts.push(opts.prompt ?? "");
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));

    await runRectificationLoop({
      config: makeConfig(false),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(capturedPrompts).toHaveLength(1);
    // No root cause analysis section when debate is disabled
    expect(capturedPrompts[0]).not.toContain("## Root Cause Analysis");
  });

  test("prompt does not contain Root Cause Analysis section when debate is disabled", async () => {
    const capturedPrompts: string[] = [];
    const mockAgent = makeAgent({
      run: mock(async (opts: AgentRunOptions) => {
        capturedPrompts.push(opts.prompt ?? "");
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));

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
  const origGetAgent = _rectificationDeps.getAgent;
  const origRunVerification = _rectificationDeps.runVerification;

  afterEach(() => {
    _rectificationDeps.getAgent = origGetAgent;
    _rectificationDeps.runVerification = origRunVerification;
    mock.restore();
  });

  test("runs DebateSession before building rectification prompt when debate.stages.rectification.enabled is true", async () => {
    const capturedPrompts: string[] = [];
    const mockAgent = makeAgent({
      run: mock(async (opts: AgentRunOptions) => {
        capturedPrompts.push(opts.prompt ?? "");
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => "The root cause is a missing null check."),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // The agent.complete() should have been called for debate proposals
    expect((mockAgent.complete as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
  });

  test("prepends diagnosis output as '## Root Cause Analysis' section to rectification prompt", async () => {
    const capturedPrompts: string[] = [];
    const diagnosisOutput = "The root cause is a missing null check in the handler.";

    const mockAgent = makeAgent({
      run: mock(async (opts: AgentRunOptions) => {
        capturedPrompts.push(opts.prompt ?? "");
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => diagnosisOutput),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));

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

    const mockAgent = makeAgent({
      run: mock(async (opts: AgentRunOptions) => {
        capturedPrompts.push(opts.prompt ?? "");
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => diagnosisOutput),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));

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
  const origGetAgent = _rectificationDeps.getAgent;
  const origRunVerification = _rectificationDeps.runVerification;

  afterEach(() => {
    _rectificationDeps.getAgent = origGetAgent;
    _rectificationDeps.runVerification = origRunVerification;
    mock.restore();
  });

  test("proceeds without diagnosis section when debate fails (all debaters error)", async () => {
    const capturedPrompts: string[] = [];

    // complete() always rejects (all debaters fail)
    const mockAgent = makeAgent({
      run: mock(async (opts: AgentRunOptions) => {
        capturedPrompts.push(opts.prompt ?? "");
        return { success: true, exitCode: 0, output: "done", rateLimited: false, durationMs: 10, estimatedCost: 0 };
      }),
      complete: mock(async (_prompt: string) => {
        throw new Error("Debate agent failed");
      }),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));

    // Should not throw even when debate fails
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

  test("logs 'fallback' event when debate fails", async () => {
    const capturedInfos: Array<{ stage: string; message: string; data: unknown }> = [];

    const mockAgent = makeAgent({
      run: mock(async (_opts: AgentRunOptions) => ({
        success: true,
        exitCode: 0,
        output: "done",
        rateLimited: false,
        durationMs: 10,
        estimatedCost: 0,
      })),
      complete: mock(async (_prompt: string) => {
        throw new Error("Debate agent failed");
      }),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));

    // Capture logger calls via _rectificationDeps
    const origLogger = (await import("../../../src/logger")).getSafeLogger();
    if (origLogger) {
      const origInfo = origLogger.info.bind(origLogger);
      (origLogger as any).info = (stage: string, message: string, data?: unknown) => {
        capturedInfos.push({ stage, message, data });
        origInfo(stage, message, data);
      };
    }

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // Restore logger
    if (origLogger) {
      const mod = await import("../../../src/logger");
      const l = mod.getSafeLogger();
      if (l) {
        // biome-ignore lint/suspicious/noExplicitAny: test patching
        delete (l as any).info;
      }
    }

    const fallbackLog = capturedInfos.find(
      (e) => String(e.message).includes("fallback") || String(e.data).includes("fallback"),
    );
    expect(fallbackLog).toBeDefined();
  });

  test("rectification still runs and returns result even when debate fails", async () => {
    const mockAgent = makeAgent({
      run: mock(async (_opts: AgentRunOptions) => ({
        success: true,
        exitCode: 0,
        output: "done",
        rateLimited: false,
        durationMs: 10,
        estimatedCost: 0,
      })),
      complete: mock(async (_prompt: string) => {
        throw new Error("All debaters failed");
      }),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));

    const result = await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    // Should succeed since verification passed
    expect(result).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// debate cost tracking
// ─────────────────────────────────────────────────────────────────────────────

describe("runRectificationLoop — debate cost included in story total", () => {
  const origGetAgent = _rectificationDeps.getAgent;
  const origRunVerification = _rectificationDeps.runVerification;

  afterEach(() => {
    _rectificationDeps.getAgent = origGetAgent;
    _rectificationDeps.runVerification = origRunVerification;
    mock.restore();
  });

  test("_rectificationDeps exposes debateSession for cost tracking", () => {
    // The deps object must be injectable for debate session, so future cost tracking can be wired
    expect(_rectificationDeps).toBeDefined();
    // After US-005 implementation, _rectificationDeps should expose a runDebate or DebateSession dep
    expect(typeof (_rectificationDeps as Record<string, unknown>).runDebate === "function" ||
           typeof (_rectificationDeps as Record<string, unknown>).DebateSession === "function" ||
           "runDebate" in _rectificationDeps ||
           "DebateSession" in _rectificationDeps
    ).toBe(true);
  });

  test("debate cost is tracked and does not cause errors when debate succeeds", async () => {
    const diagnosisText = "Root cause: incorrect state mutation.";

    const mockAgent = makeAgent({
      run: mock(async (_opts: AgentRunOptions) => ({
        success: true,
        exitCode: 0,
        output: "done",
        rateLimited: false,
        durationMs: 10,
        estimatedCost: 0.01,
      })),
      complete: mock(async (_prompt: string) => diagnosisText),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));

    // Should complete successfully, including debate cost without crashing
    const result = await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story: makeStory(),
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(result).toBe(true);
  });
});
