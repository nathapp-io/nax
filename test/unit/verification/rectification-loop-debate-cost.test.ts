/**
 * Tests for US-005: debate cost tracking in rectification loop
 *
 * Covers:
 * - _rectificationDeps.runDebate is injectable (AC5)
 * - Debate cost is accumulated into story.routing.estimatedCost when totalCostUsd > 0
 * - story.routing.estimatedCost is unchanged when debate returns totalCostUsd === 0
 * - Loop completes without error when debate succeeds with cost
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

describe("runRectificationLoop — debate cost included in story total", () => {
  const origGetAgent = _rectificationDeps.getAgent;
  const origRunVerification = _rectificationDeps.runVerification;
  const origRunDebate = _rectificationDeps.runDebate;

  afterEach(() => {
    _rectificationDeps.getAgent = origGetAgent;
    _rectificationDeps.runVerification = origRunVerification;
    _rectificationDeps.runDebate = origRunDebate;
    mock.restore();
  });

  test("_rectificationDeps exposes runDebate for cost tracking", () => {
    expect(_rectificationDeps).toBeDefined();
    expect(typeof (_rectificationDeps as Record<string, unknown>).runDebate).toBe("function");
  });

  test("debate cost is accumulated into story.routing.estimatedCost when totalCostUsd > 0", async () => {
    const mockAgent = makeAgent({
      run: mock(async (_opts: AgentRunOptions) => ({
        success: true,
        exitCode: 0,
        output: "done",
        rateLimited: false,
        durationMs: 10,
        estimatedCost: 0,
      })),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));
    _rectificationDeps.runDebate = mock(async () => ({
      output: "Root cause: incorrect state mutation.",
      totalCostUsd: 0.05,
    }));

    const story = makeStory({ routing: { modelTier: "balanced", estimatedCost: 0.10 } });

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story,
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(story.routing?.estimatedCost).toBeCloseTo(0.15, 5);
  });

  test("story.routing.estimatedCost is not modified when debate returns totalCostUsd === 0", async () => {
    const mockAgent = makeAgent({
      run: mock(async (_opts: AgentRunOptions) => ({
        success: true,
        exitCode: 0,
        output: "done",
        rateLimited: false,
        durationMs: 10,
        estimatedCost: 0,
      })),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));
    _rectificationDeps.runDebate = mock(async () => ({
      output: "Root cause analysis output.",
      totalCostUsd: 0,
    }));

    const story = makeStory({ routing: { modelTier: "balanced", estimatedCost: 0.10 } });

    await runRectificationLoop({
      config: makeConfig(true),
      workdir: "/tmp/test",
      story,
      testCommand: "bun test",
      timeoutSeconds: 30,
      testOutput: FAILING_TEST_OUTPUT,
    });

    expect(story.routing?.estimatedCost).toBeCloseTo(0.10, 5);
  });

  test("debate cost is tracked and loop completes without error when debate succeeds", async () => {
    const mockAgent = makeAgent({
      run: mock(async (_opts: AgentRunOptions) => ({
        success: true,
        exitCode: 0,
        output: "done",
        rateLimited: false,
        durationMs: 10,
        estimatedCost: 0.01,
      })),
    });

    _rectificationDeps.getAgent = mock(() => mockAgent as unknown as import("../../../src/agents/types").AgentAdapter);
    _rectificationDeps.runVerification = mock(async () => ({ success: true, output: "1 pass" }));
    _rectificationDeps.runDebate = mock(async () => ({
      output: "Root cause: incorrect state mutation.",
      totalCostUsd: 0.03,
    }));

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
