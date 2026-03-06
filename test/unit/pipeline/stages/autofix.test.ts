// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { autofixStage, _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";

function makeReviewResult(success: boolean) {
  return { success, checks: [], summary: "" } as any;
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          ...DEFAULT_CONFIG.quality.commands,
          lintFix: "biome check --fix",
          formatFix: "biome format --write",
        },
        autofix: { enabled: true, maxAttempts: 2 },
      },
    } as any,
    prd: { stories: [] } as any,
    story: { id: "US-001", title: "t", status: "in-progress", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp",
    hooks: {},
    ...overrides,
  };
}

describe("autofixStage", () => {
  test("disabled when reviewResult is undefined", () => {
    expect(autofixStage.enabled(makeCtx())).toBe(false);
  });

  test("disabled when review passed", () => {
    expect(autofixStage.enabled(makeCtx({ reviewResult: makeReviewResult(true) }))).toBe(false);
  });

  test("disabled when autofix.enabled = false", () => {
    const ctx = makeCtx({
      reviewResult: makeReviewResult(false),
      config: {
        ...DEFAULT_CONFIG,
        quality: { ...DEFAULT_CONFIG.quality, autofix: { enabled: false } },
      } as any,
    });
    expect(autofixStage.enabled(ctx)).toBe(false);
  });

  test("escalates when no fix commands configured", async () => {
    const ctx = makeCtx({
      reviewResult: makeReviewResult(false),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true },
        },
      } as any,
    });
    const result = await autofixStage.execute(ctx);
    expect(result.action).toBe("escalate");
  });

  test("returns retry when recheck passes", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runCommand = async () => ({ exitCode: 0, output: "" });
    _autofixDeps.recheckReview = async () => true;

    const ctx = makeCtx({ reviewResult: makeReviewResult(false) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.fromStage).toBe("review");
  });

  test("escalates when recheck still fails after max attempts", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runCommand = async () => ({ exitCode: 1, output: "lint error" });
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({ reviewResult: makeReviewResult(false) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
  });
});
