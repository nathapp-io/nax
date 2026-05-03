import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config";
import { _cycleDeps } from "../../../src/findings";
import { _autofixDeps } from "../../../src/pipeline/stages/autofix";
import { runAgentRectification } from "../../../src/pipeline/stages/autofix-agent";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../src/review/types";
import { makeMockAgentManager, makeMockRuntime } from "../../helpers";

function failedCheck(check: ReviewCheckResult["check"], output = `${check} failed`): ReviewCheckResult {
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
      title: "fresh failure propagation contract",
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
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
    reviewResult: {
      success: false,
      checks: [failedCheck("build", "build failure output")],
    } as unknown as PipelineContext["reviewResult"],
  };
}

let savedRecheck: typeof _autofixDeps.recheckReview;
let savedTreeChange: typeof _autofixDeps.hasWorkingTreeChange;
let savedTestWriter: typeof _autofixDeps.runTestWriterRectification;
let savedCycleDepsCallOp: typeof _cycleDeps.callOp;

beforeEach(() => {
  savedRecheck = _autofixDeps.recheckReview;
  savedTreeChange = _autofixDeps.hasWorkingTreeChange;
  savedTestWriter = _autofixDeps.runTestWriterRectification;
  savedCycleDepsCallOp = _cycleDeps.callOp;
  _autofixDeps.runTestWriterRectification = mock(async () => 0);
});

afterEach(() => {
  _autofixDeps.recheckReview = savedRecheck;
  _autofixDeps.hasWorkingTreeChange = savedTreeChange;
  _autofixDeps.runTestWriterRectification = savedTestWriter;
  _cycleDeps.callOp = savedCycleDepsCallOp;
  mock.restore();
});

describe("autofix fresh-failure propagation contract", () => {
  test("legacy runAgentRectification forwards post-recheck failures to next prompt", async () => {
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

    await runAgentRectification(makeCtx(manager), undefined, undefined, "/tmp");

    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[1]).toContain("adversarial failure output");
    expect(prompts[1]).not.toContain("build failure output");
  });

  test("V2 runAgentRectification path forwards post-recheck findings to next buildInput", async () => {
    const capturedChecks: ReviewCheckResult[][] = [];

    // Mock cycle callOp to capture what each strategy invocation receives
    // biome-ignore lint/suspicious/noExplicitAny: test mock captures heterogeneous op inputs
    _cycleDeps.callOp = mock(async (_ctx: unknown, _op: unknown, input: any): Promise<any> => {
      if (input?.failedChecks) {
        capturedChecks.push(input.failedChecks as ReviewCheckResult[]);
      }
      return { applied: true };
    });

    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      // Mutate ctx.reviewResult to adversarial failure (fresh state after first fix attempt)
      ctx.reviewResult = {
        success: false,
        checks: [failedCheck("adversarial", "adversarial failure output")],
      } as unknown as PipelineContext["reviewResult"];
      return false;
    });

    const manager = makeMockAgentManager({});
    const ctx = makeCtx(manager);
    ctx.config = {
      ...ctx.config,
      quality: {
        ...ctx.config.quality,
        autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 10, cycleV2: true },
      },
    } as PipelineContext["config"];

    await runAgentRectification(ctx, undefined, undefined, "/tmp");

    // V2 should have run at least 2 iterations (build → adversarial)
    expect(capturedChecks.length).toBeGreaterThanOrEqual(2);
    // First invocation: original build failure
    expect(capturedChecks[0]?.some((c) => c.check === "build")).toBe(true);
    // Second invocation: fresh adversarial failure (not the original build)
    expect(capturedChecks[1]?.some((c) => c.check === "adversarial")).toBe(true);
    expect(capturedChecks[1]?.some((c) => c.check === "build")).toBe(false);
  });
});
