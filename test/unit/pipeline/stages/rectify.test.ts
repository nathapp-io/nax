// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rectifyStage, _rectifyDeps } from "@/pipeline";
import type { PipelineContext } from "@/pipeline";
import { DEFAULT_CONFIG } from "@/config";
import type { FixCycleResult, Finding } from "@/findings";
import { makeMockRuntime } from "@test/helpers";

function makeFixCycleResult(succeeded: boolean, costUsd = 0): FixCycleResult<Finding> {
  if (succeeded) {
    return {
      iterations: [{ iterationNum: 1, findingsBefore: [], fixesApplied: [], findingsAfter: [], outcome: "resolved", startedAt: "", finishedAt: "" }],
      finalFindings: [],
      exitReason: "resolved",
      costUsd,
    };
  }
  return {
    iterations: [{ iterationNum: 1, findingsBefore: [], fixesApplied: [], findingsAfter: [{ source: "test-runner", severity: "error", category: "failed-test", rule: "t", message: "fail", fixTarget: "source" }], outcome: "unchanged", startedAt: "", finishedAt: "" }],
    finalFindings: [{ source: "test-runner", severity: "error", category: "failed-test", rule: "t", message: "fail", fixTarget: "source" }],
    exitReason: "max-attempts-per-strategy",
    costUsd,
  };
}

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
    prd: { feature: "test-feature", stories: [] } as any,
    story: { id: "US-001", title: "t", status: "in-progress", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: {},
    runtime: makeMockRuntime(),
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

// Save/restore pattern — no mock.module() to avoid Bun 1.x global leaks
let savedDeps: typeof _rectifyDeps;
beforeEach(() => {
  savedDeps = { ..._rectifyDeps };
});
afterEach(() => {
  Object.assign(_rectifyDeps, savedDeps);
});

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
    _rectifyDeps.runFixCycle = mock(async () => makeFixCycleResult(true));

    const ctx = makeCtx({ verifyResult: makeVerifyResult(false) });
    const result = await rectifyStage.execute(ctx);

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.fromStage).toBe("verify");
    // verifyResult should be cleared so verify re-runs fresh
    expect(ctx.verifyResult).toBeUndefined();
  });

  test("returns escalate when rectification exhausted", async () => {
    _rectifyDeps.runFixCycle = mock(async () => makeFixCycleResult(false));

    const ctx = makeCtx({ verifyResult: makeVerifyResult(false) });
    const result = await rectifyStage.execute(ctx);

    expect(result.action).toBe("escalate");
  });

  test("escalates immediately when failCount is 0 (environmental failure — nothing for agent to fix)", async () => {
    let loopCalled = false;
    _rectifyDeps.runFixCycle = mock(async () => { loopCalled = true; return makeFixCycleResult(false); });

    const envVerifyResult = {
      ...makeVerifyResult(false),
      failCount: 0,
      status: "TEST_FAILURE" as const,
    };
    const ctx = makeCtx({ verifyResult: envVerifyResult });
    const result = await rectifyStage.execute(ctx);

    expect(result.action).toBe("escalate");
    expect(loopCalled).toBe(false);
    if (result.action === "escalate") {
      expect(result.reason).toContain("0 test failures");
    }
  });

  test("returns retry with resetRetryCount:true when rectification succeeds", async () => {
    _rectifyDeps.runFixCycle = mock(async () => makeFixCycleResult(true));

    const ctx = makeCtx({ verifyResult: makeVerifyResult(false) });
    const result = await rectifyStage.execute(ctx);

    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.fromStage).toBe("verify");
      expect(result.resetRetryCount).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime threading — AC1 and AC2
// ─────────────────────────────────────────────────────────────────────────────

describe("rectifyStage — runtime threading", () => {
  test("AC1: runFixCycle receives ctx.runtime (runtime threading)", async () => {
    let capturedRuntime: unknown;
    _rectifyDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      capturedRuntime = cycleCtx.runtime;
      return makeFixCycleResult(true);
    });

    const specificRuntime = makeMockRuntime();
    const ctx = makeCtx({
      runtime: specificRuntime,
      verifyResult: makeVerifyResult(false),
    });

    await rectifyStage.execute(ctx);

    expect(capturedRuntime).toBe(specificRuntime);
  });

  test("AC2: cycleCtx.storyId matches ctx.story.id (context threading)", async () => {
    let capturedStoryId: string | undefined;
    _rectifyDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      capturedStoryId = cycleCtx.storyId;
      return makeFixCycleResult(false);
    });

    const ctx = makeCtx({
      verifyResult: makeVerifyResult(false),
    });

    await rectifyStage.execute(ctx);

    expect(capturedStoryId).toBe("US-001");
  });
});
