import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { _cycleDeps } from "../../../../src/findings";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import { runAgentRectificationV2 } from "../../../../src/pipeline/stages/autofix-cycle";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../../src/review/types";
import { makeMockAgentManager, makeMockRuntime } from "../../../helpers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function failedCheck(check: ReviewCheckResult["check"], output = `${check} failed`): ReviewCheckResult {
  return { check, success: false, command: "nax review", exitCode: 1, output, durationMs: 1 };
}

function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  const runtime = makeMockRuntime({});
  return {
    config: {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 4 },
      },
    } as PipelineContext["config"],
    prd: { feature: "phase7-test", stories: [] } as unknown as PipelineContext["prd"],
    story: { id: "US-phase7", title: "cycle unit test", status: "in-progress", acceptanceCriteria: [] } as unknown as PipelineContext["story"],
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: {} as unknown as PipelineContext["hooks"],
    runtime,
    agentManager: makeMockAgentManager({}),
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
    reviewResult: {
      success: false,
      checks: [failedCheck("lint", "lint failure")],
    } as unknown as PipelineContext["reviewResult"],
    ...overrides,
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let savedRecheck: typeof _autofixDeps.recheckReview;
let savedCycleCallOp: typeof _cycleDeps.callOp;

beforeEach(() => {
  savedRecheck = _autofixDeps.recheckReview;
  savedCycleCallOp = _cycleDeps.callOp;
});

afterEach(() => {
  _autofixDeps.recheckReview = savedRecheck;
  _cycleDeps.callOp = savedCycleCallOp;
  mock.restore();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runAgentRectificationV2", () => {
  test("returns succeeded=true when cycle resolves", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({ applied: true }));
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });

    const result = await runAgentRectificationV2(makeCtx(), undefined, undefined, "/tmp");

    expect(result.succeeded).toBe(true);
    expect(result.cost).toBe(0);
  });

  test("returns succeeded=false when findings remain after max attempts", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({ applied: true }));
    // recheckReview always returns failing state
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = {
        success: false,
        checks: [failedCheck("lint", "still failing")],
      } as unknown as PipelineContext["reviewResult"];
      return false;
    });

    const result = await runAgentRectificationV2(makeCtx(), undefined, undefined, "/tmp");

    expect(result.succeeded).toBe(false);
  });

  test("implementer strategy fires for source-targeted findings", async () => {
    const capturedOps: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (_ctx: unknown, op: any): Promise<any> => {
      capturedOps.push(op.name as string);
      return { applied: true };
    });
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });

    const ctx = makeCtx();
    // Lint check → synthesized as source-targeted finding
    ctx.reviewResult = {
      success: false,
      checks: [failedCheck("lint", "lint errors")],
    } as unknown as PipelineContext["reviewResult"];

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    expect(capturedOps).toContain("autofix-implementer");
    expect(capturedOps).not.toContain("autofix-test-writer");
  });

  test("test-writer strategy fires when check has test-targeted findings", async () => {
    const capturedOps: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (_ctx: unknown, op: any): Promise<any> => {
      capturedOps.push(op.name as string);
      return { applied: true };
    });
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });

    const ctx = makeCtx();
    ctx.reviewResult = {
      success: false,
      checks: [
        {
          ...failedCheck("adversarial", "test gap found"),
          findings: [{ source: "adversarial-review", severity: "error", category: "test-gap", message: "missing test", fixTarget: "test" }],
        },
      ],
    } as unknown as PipelineContext["reviewResult"];

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    expect(capturedOps).toContain("autofix-test-writer");
  });

  test("buildInput for second iteration uses fresh post-recheck checks", async () => {
    const capturedChecks: ReviewCheckResult[][] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (_ctx: unknown, _op: unknown, input: any): Promise<any> => {
      if (input?.failedChecks) capturedChecks.push([...input.failedChecks]);
      return { applied: true };
    });

    let recheckCount = 0;
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      recheckCount++;
      if (recheckCount === 1) {
        // After first fix: different failure
        ctx.reviewResult = {
          success: false,
          checks: [failedCheck("typecheck", "type error after lint fix")],
        } as unknown as PipelineContext["reviewResult"];
        return false;
      }
      // After second fix: resolved
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });

    const ctx = makeCtx();
    ctx.reviewResult = {
      success: false,
      checks: [failedCheck("lint", "initial lint failure")],
    } as unknown as PipelineContext["reviewResult"];

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    expect(capturedChecks.length).toBeGreaterThanOrEqual(2);
    expect(capturedChecks[0]?.some((c) => c.check === "lint")).toBe(true);
    expect(capturedChecks[1]?.some((c) => c.check === "typecheck")).toBe(true);
    expect(capturedChecks[1]?.some((c) => c.check === "lint")).toBe(false);
  });

  test("persists iterations to autofixPriorIterations on ctx", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({ applied: true }));
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });

    const ctx = makeCtx();
    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    expect(ctx.autofixPriorIterations).toBeDefined();
    expect(ctx.autofixPriorIterations?.length).toBeGreaterThanOrEqual(1);
  });
});
