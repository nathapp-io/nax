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
import { makeMockAgentManager } from "../../helpers";
import { _rectificationDeps, runRectificationLoop } from "../../../src/verification/rectification-loop";
import {
  FAILING_TEST_OUTPUT,
  makeConfig,
  makeStory,
} from "./_rectification-debate-helpers";

const SUCCESS_VERIFICATION = {
  success: true,
  status: "SUCCESS" as const,
  output: "1 pass",
  countsTowardEscalation: false,
};

describe("runRectificationLoop — debate cost included in story total", () => {
  const origCreateManager = _rectificationDeps.createManager;
  const origRunVerification = _rectificationDeps.runVerification;
  const origRunDebate = _rectificationDeps.runDebate;

  afterEach(() => {
    _rectificationDeps.createManager = origCreateManager;
    _rectificationDeps.runVerification = origRunVerification;
    _rectificationDeps.runDebate = origRunDebate;
    mock.restore();
  });

  test("_rectificationDeps exposes runDebate for cost tracking", () => {
    expect(_rectificationDeps).toBeDefined();
    expect(typeof (_rectificationDeps as Record<string, unknown>).runDebate).toBe("function");
  });

  test("debate cost is accumulated into story.routing.estimatedCost when totalCostUsd > 0", async () => {
    _rectificationDeps.createManager = mock(() => makeMockAgentManager());
    _rectificationDeps.runVerification = mock(async () => SUCCESS_VERIFICATION);
    _rectificationDeps.runDebate = mock(async () => ({
      output: "Root cause: incorrect state mutation.",
      totalCostUsd: 0.05,
    }));

    const story = makeStory({ routing: { modelTier: "balanced", estimatedCost: 0.10 } as never });

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
    _rectificationDeps.createManager = mock(() => makeMockAgentManager());
    _rectificationDeps.runVerification = mock(async () => SUCCESS_VERIFICATION);
    _rectificationDeps.runDebate = mock(async () => ({
      output: "Root cause analysis output.",
      totalCostUsd: 0,
    }));

    const story = makeStory({ routing: { modelTier: "balanced", estimatedCost: 0.10 } as never });

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
    _rectificationDeps.createManager = mock(() => makeMockAgentManager());
    _rectificationDeps.runVerification = mock(async () => SUCCESS_VERIFICATION);
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
