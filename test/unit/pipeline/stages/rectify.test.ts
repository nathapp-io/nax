// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { rectifyStage, _rectifyDeps } from "@/pipeline";
import type { PipelineContext } from "@/pipeline";
import { DEFAULT_CONFIG } from "@/config";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: { enabled: true, maxRetries: 3, abortOnIncreasingFailures: true, maxFailureSummaryChars: 2000 },
      },
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { ...DEFAULT_CONFIG.quality.commands, test: "bun test" },
      },
    },
    prd: { stories: [] } as any,
    story: { id: "US-001", title: "t", status: "in-progress", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: {},
    ...overrides,
  };
}

function makeVerifyResult(success: boolean) {
  return {
    success,
    status: success ? ("PASS" as const) : ("TEST_FAILURE" as const),
    storyId: "US-001",
    strategy: "scoped" as const,
    passCount: success ? 10 : 8,
    failCount: success ? 0 : 2,
    totalCount: 10,
    failures: [],
    rawOutput: "(fail) foo > bar",
    durationMs: 100,
    countsTowardEscalation: !success,
  };
}

describe("rectifyStage", () => {
  test("disabled when verifyResult is undefined", () => {
    expect(rectifyStage.enabled(makeCtx())).toBe(false);
  });

  test("disabled when verify passed", () => {
    const ctx = makeCtx({ verifyResult: makeVerifyResult(true) });
    expect(rectifyStage.enabled(ctx)).toBe(false);
  });

  test("disabled when rectification config disabled", () => {
    const ctx = makeCtx({
      verifyResult: makeVerifyResult(false),
      config: {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          rectification: { enabled: false, maxRetries: 3, abortOnIncreasingFailures: true, maxFailureSummaryChars: 2000 },
        },
      } as any,
    });
    expect(rectifyStage.enabled(ctx)).toBe(false);
  });

  test("enabled when verify failed and rectification enabled", () => {
    const ctx = makeCtx({ verifyResult: makeVerifyResult(false) });
    expect(rectifyStage.enabled(ctx)).toBe(true);
  });

  test("returns retry when rectification succeeds", async () => {
    const saved = { ..._rectifyDeps };
    _rectifyDeps.runRectificationLoop = async () => ({ succeeded: true, cost: 0, durationMs: 0 });

    const ctx = makeCtx({ verifyResult: makeVerifyResult(false) });
    const result = await rectifyStage.execute(ctx);

    Object.assign(_rectifyDeps, saved);

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.fromStage).toBe("verify");
    // verifyResult should be cleared so verify re-runs fresh
    expect(ctx.verifyResult).toBeUndefined();
  });

  test("returns escalate when rectification exhausted", async () => {
    const saved = { ..._rectifyDeps };
    _rectifyDeps.runRectificationLoop = async () => ({ succeeded: false, cost: 0, durationMs: 0 });

    const ctx = makeCtx({ verifyResult: makeVerifyResult(false) });
    const result = await rectifyStage.execute(ctx);

    Object.assign(_rectifyDeps, saved);

    expect(result.action).toBe("escalate");
  });

  test("escalates immediately when failCount is 0 (environmental failure — nothing for agent to fix)", async () => {
    const saved = { ..._rectifyDeps };
    // Ensure runRectificationLoop is never called for this path
    let loopCalled = false;
    _rectifyDeps.runRectificationLoop = async () => { loopCalled = true; return { succeeded: false, cost: 0, durationMs: 0 }; };

    const envVerifyResult = {
      ...makeVerifyResult(false),
      failCount: 0,
      status: "TEST_FAILURE" as const,
    };
    const ctx = makeCtx({ verifyResult: envVerifyResult });
    const result = await rectifyStage.execute(ctx);

    Object.assign(_rectifyDeps, saved);

    expect(result.action).toBe("escalate");
    expect(loopCalled).toBe(false);
    if (result.action === "escalate") {
      expect(result.reason).toContain("0 test failures");
    }
  });

  test("returns retry with resetRetryCount:true when rectification succeeds", async () => {
    const saved = { ..._rectifyDeps };
    _rectifyDeps.runRectificationLoop = async () => ({ succeeded: true, cost: 0, durationMs: 0 });

    const ctx = makeCtx({ verifyResult: makeVerifyResult(false) });
    const result = await rectifyStage.execute(ctx);

    Object.assign(_rectifyDeps, saved);

    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.fromStage).toBe("verify");
      expect(result.resetRetryCount).toBe(true);
    }
  });
});
