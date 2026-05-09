import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { _cycleDeps } from "@/findings";
import { _autofixDeps } from "../../../src/pipeline/stages/autofix";
import { runAgentRectification } from "../../../src/pipeline/stages/autofix-agent";
import type { PipelineContext } from "@/pipeline/types";
import type { ReviewCheckResult } from "@/review/types";
import { makeMockAgentManager, makeMockRuntime } from "@test/helpers";

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
let savedTestWriter: typeof _autofixDeps.runTestWriterRectification;
let savedCycleDepsCallOp: typeof _cycleDeps.callOp;

beforeEach(() => {
  savedRecheck = _autofixDeps.recheckReview;
  savedTestWriter = _autofixDeps.runTestWriterRectification;
  savedCycleDepsCallOp = _cycleDeps.callOp;
  _autofixDeps.runTestWriterRectification = mock(async () => 0);
});

afterEach(() => {
  _autofixDeps.recheckReview = savedRecheck;
  _autofixDeps.runTestWriterRectification = savedTestWriter;
  _cycleDeps.callOp = savedCycleDepsCallOp;
  mock.restore();
});

describe("autofix fresh-failure propagation contract", () => {
  test("implementer receives fresh post-recheck failures in second iteration", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock captures heterogeneous op inputs
    const capturedInputs: { opName: string; failedChecks: ReviewCheckResult[] }[] = [];

    // biome-ignore lint/suspicious/noExplicitAny: test mock captures heterogeneous op inputs
    _cycleDeps.callOp = mock(async (_ctx: unknown, op: any, input: any): Promise<any> => {
      if (input?.failedChecks !== undefined) {
        capturedInputs.push({ opName: op.name as string, failedChecks: input.failedChecks as ReviewCheckResult[] });
      }
      return { applied: true };
    });

    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = {
        success: false,
        checks: [failedCheck("adversarial", "adversarial failure output")],
      } as unknown as PipelineContext["reviewResult"];
      return false;
    });

    await runAgentRectification(makeCtx(makeMockAgentManager({})), undefined, undefined, "/tmp");

    // Iteration 1: only implementer fires (build finding, fixTarget=source, not adversarial)
    const implementerInvocations = capturedInputs.filter((i) => i.opName === "autofix-implementer");
    expect(implementerInvocations.length).toBeGreaterThanOrEqual(2);
    expect(implementerInvocations[0]?.failedChecks.some((c) => c.check === "build")).toBe(true);

    // Iteration 2: after recheckReview, implementer must see only the fresh adversarial check
    expect(implementerInvocations[1]?.failedChecks.some((c) => c.check === "adversarial")).toBe(true);
    expect(implementerInvocations[1]?.failedChecks.some((c) => c.check === "build")).toBe(false);
  });

  test("test-writer does not receive build findings after recheckReview returns adversarial", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock captures heterogeneous op inputs
    const capturedInputs: { opName: string; failedChecks: ReviewCheckResult[] }[] = [];

    // biome-ignore lint/suspicious/noExplicitAny: test mock captures heterogeneous op inputs
    _cycleDeps.callOp = mock(async (_ctx: unknown, op: any, input: any): Promise<any> => {
      if (input?.failedChecks !== undefined) {
        capturedInputs.push({ opName: op.name as string, failedChecks: input.failedChecks as ReviewCheckResult[] });
      }
      return { applied: true };
    });

    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = {
        success: false,
        checks: [failedCheck("adversarial", "adversarial failure output")],
      } as unknown as PipelineContext["reviewResult"];
      return false;
    });

    await runAgentRectification(makeCtx(makeMockAgentManager({})), undefined, undefined, "/tmp");

    // test-writer should never see a build check (only applies to test-targeted or adversarial findings)
    const testWriterInvocations = capturedInputs.filter((i) => i.opName === "autofix-test-writer");
    for (const inv of testWriterInvocations) {
      expect(inv.failedChecks.some((c) => c.check === "build")).toBe(false);
    }
  });
});
