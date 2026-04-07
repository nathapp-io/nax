// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { regressionStage, _regressionStageDeps } from "../../../../src/pipeline/stages/regression";
import { makePassResult, makeFailResult } from "../../../../src/verification/orchestrator-types";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";

function makeCtx(mode: "deferred" | "per-story" | "disabled" = "per-story"): PipelineContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        regressionGate: { enabled: true, mode, timeoutSeconds: 60, acceptOnTimeout: true },
      },
      quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" } },
    } as any,
    prd: { stories: [] } as any,
    story: { id: "US-001", title: "t", status: "in-progress", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: {},
  };
}

describe("regressionStage", () => {
  test("disabled when mode is deferred", () => {
    expect(regressionStage.enabled(makeCtx("deferred"))).toBe(false);
  });

  test("disabled when mode is disabled", () => {
    expect(regressionStage.enabled(makeCtx("disabled"))).toBe(false);
  });

  test("enabled when mode is per-story", () => {
    expect(regressionStage.enabled(makeCtx("per-story"))).toBe(true);
  });

  test("disabled when verifyResult is a failure", () => {
    const ctx = makeCtx("per-story");
    ctx.verifyResult = makeFailResult("US-001", "scoped", "TEST_FAILURE");
    expect(regressionStage.enabled(ctx)).toBe(false);
  });

  test("returns continue when regression passes", async () => {
    const saved = { ..._regressionStageDeps };
    _regressionStageDeps.verifyRegression = async () => makePassResult("US-001", "regression");

    const result = await regressionStage.execute(makeCtx("per-story"));

    Object.assign(_regressionStageDeps, saved);

    expect(result.action).toBe("continue");
  });

  test("returns escalate when regression fails", async () => {
    const saved = { ..._regressionStageDeps };
    _regressionStageDeps.verifyRegression = async () =>
      makeFailResult("US-001", "regression", "TEST_FAILURE", { failCount: 3 });

    const result = await regressionStage.execute(makeCtx("per-story"));

    Object.assign(_regressionStageDeps, saved);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toContain("3 test");
  });
});
