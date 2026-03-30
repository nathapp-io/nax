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
import type { AgentRunOptions } from "../../../src/agents/types";
import { _rectificationDeps, runRectificationLoop } from "../../../src/verification/rectification-loop";
import {
  FAILING_TEST_OUTPUT,
  makeAgent,
  makeConfig,
  makeStory,
} from "./_rectification-debate-helpers";

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

    const origLogger = (await import("../../../src/logger")).getSafeLogger();
    if (origLogger) {
      const origInfo = origLogger.info.bind(origLogger);
      // biome-ignore lint/suspicious/noExplicitAny: test patching
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

    expect(result).toBe(true);
  });
});
