import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config";
import { _autofixDeps } from "../../../src/pipeline/stages/autofix";
import { autofixStage } from "../../../src/pipeline/stages/autofix";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../src/review/types";
import { makeMockAgentManager, makeMockRuntime } from "../../helpers";

function failedCheck(check: ReviewCheckResult["check"], output = `${check} failure output`): ReviewCheckResult {
  return {
    check,
    success: false,
    command: "nax review",
    exitCode: 1,
    output,
    durationMs: 1,
  };
}

function makeCtx(agentManager: PipelineContext["agentManager"]): PipelineContext {
  const runtime = makeMockRuntime({});
  return {
    config: {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { ...DEFAULT_CONFIG.quality.commands },
        autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 10 },
      },
    } as PipelineContext["config"],
    prd: { feature: "issue-808", stories: [] } as unknown as PipelineContext["prd"],
    story: {
      id: "US-808",
      title: "stale failure carry-forward integration",
      status: "in-progress",
      acceptanceCriteria: [],
    } as unknown as PipelineContext["story"],
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: {} as unknown as PipelineContext["hooks"],
    runtime,
    agentManager,
    reviewResult: {
      success: false,
      checks: [failedCheck("build", "build failure output")],
    } as unknown as PipelineContext["reviewResult"],
  };
}

let savedRecheck: typeof _autofixDeps.recheckReview;
let savedTreeChange: typeof _autofixDeps.hasWorkingTreeChange;
let savedTestWriter: typeof _autofixDeps.runTestWriterRectification;

beforeEach(() => {
  savedRecheck = _autofixDeps.recheckReview;
  savedTreeChange = _autofixDeps.hasWorkingTreeChange;
  savedTestWriter = _autofixDeps.runTestWriterRectification;
  _autofixDeps.runTestWriterRectification = mock(async () => 0);
});

afterEach(() => {
  _autofixDeps.recheckReview = savedRecheck;
  _autofixDeps.hasWorkingTreeChange = savedTreeChange;
  _autofixDeps.runTestWriterRectification = savedTestWriter;
  mock.restore();
});

describe("issue #808 stale failure carry-forward", () => {
  test("autofix stage uses fresh post-recheck failures and returns partial-progress retry", async () => {
    const prompts: string[] = [];
    const manager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, _handle, prompt) => {
        prompts.push(prompt);
        return {
          output: "attempt output",
          estimatedCostUsd: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      },
    });

    _autofixDeps.hasWorkingTreeChange = mock(async () => false);
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = {
        success: false,
        checks: [failedCheck("adversarial", "adversarial failure output")],
      } as unknown as PipelineContext["reviewResult"];
      return false;
    });

    const ctx = makeCtx(manager);
    const result = await autofixStage.execute(ctx);

    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[1]).toContain("adversarial failure output");
    expect(prompts[1]).not.toContain("build failure output");
    expect(result.action).toBe("retry");
    expect(ctx.retrySkipChecks?.has("build")).toBe(true);
    expect(ctx.retrySkipChecks?.has("adversarial")).toBe(false);
  });
});
