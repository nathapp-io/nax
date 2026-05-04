import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { _cycleDeps } from "../../../../src/findings";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import { runAgentRectificationV2 } from "../../../../src/pipeline/stages/autofix-cycle";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { toAdversarialReviewFindings } from "../../../../src/review/adversarial-helpers";
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

  test("test-writer strategy fires for real adversarial test-gap adapter output", async () => {
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
          findings: toAdversarialReviewFindings([
            {
              severity: "error",
              category: "test-gap",
              file: "src/foo.ts",
              line: 1,
              issue: "missing behavioral test",
              suggestion: "add coverage",
            },
          ]),
        },
      ],
    } as unknown as PipelineContext["reviewResult"];

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    expect(capturedOps).toContain("autofix-test-writer");
    expect(capturedOps).not.toContain("autofix-implementer");
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

  // D2 — TDD inversion: test-writer runs before implementer (#897)
  test("test-writer runs before implementer within the same iteration", async () => {
    const opOrder: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (_ctx: unknown, op: any): Promise<any> => {
      opOrder.push(op.name as string);
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
          ...failedCheck("adversarial", "mixed"),
          findings: [
            { source: "adversarial-review", severity: "error", category: "source-bug", message: "source bug", fixTarget: "source" as const },
            { source: "adversarial-review", severity: "error", category: "test-gap", message: "missing test", fixTarget: "test" as const },
          ],
        },
      ],
    } as unknown as PipelineContext["reviewResult"];

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    const testWriterIdx = opOrder.indexOf("autofix-test-writer");
    const implementerIdx = opOrder.indexOf("autofix-implementer");
    expect(testWriterIdx).toBeGreaterThanOrEqual(0);
    expect(implementerIdx).toBeGreaterThanOrEqual(0);
    expect(testWriterIdx).toBeLessThan(implementerIdx);
  });

  // D6 — escalation digest when cap exhausted (#897)
  test("returns escalationDigest describing remaining findings when cycle exhausts attempts", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({ applied: true }));
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = {
        success: false,
        checks: [
          {
            ...failedCheck("adversarial", "still failing"),
            findings: [
              {
                source: "adversarial-review",
                severity: "error",
                category: "error-path",
                message: "bug persists",
                fixTarget: "source" as const,
                file: "src/foo.ts",
              },
            ],
          },
        ],
      } as unknown as PipelineContext["reviewResult"];
      return false;
    });

    // maxAttempts: 2 so the first fix runs validate, which updates ctx to adversarial findings.
    // The second fix then hits the cap and skips validate, using the adversarial findings as finalFindings.
    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 4 },
        },
      } as PipelineContext["config"],
    });
    // Initial review has an adversarial finding with a file path in the finding list
    ctx.reviewResult = {
      success: false,
      checks: [
        {
          ...failedCheck("adversarial", "still failing"),
          findings: [
            {
              source: "adversarial-review",
              severity: "error",
              category: "error-path",
              message: "bug remains",
              fixTarget: "source" as const,
              file: "src/foo.ts",
            },
          ],
        },
      ],
    } as unknown as PipelineContext["reviewResult"];

    const result = await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    expect(result.succeeded).toBe(false);
    expect(result.escalationDigest).toBeDefined();
    expect(result.escalationDigest).toContain("remain");
    expect(result.escalationDigest).toContain("src/foo.ts");
  });

  // D4 — UNRESOLVED bail before validate (#897)
  test("returns unresolvedReason when implementer op signals UNRESOLVED via extractApplied", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({
      unresolvedReason: "conflicting requirements — test asserts wrong identifier space",
    }));
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = {
        success: false,
        checks: [failedCheck("adversarial", "still failing")],
      } as unknown as PipelineContext["reviewResult"];
      return false;
    });

    const result = await runAgentRectificationV2(makeCtx(), undefined, undefined, "/tmp");

    expect(result.succeeded).toBe(false);
    expect(result.unresolvedReason).toBe("conflicting requirements — test asserts wrong identifier space");
  });

  // D3 — collectTestTargetedChecks finding leak (#897)
  // When a check has test-targeted findings mixed with non-adversarial source findings,
  // the fix-test-files path must only pass test-targeted findings to the test-writer.
  test("test-writer receives only test-targeted findings in fix-test-files mode (semantic + mixed check)", async () => {
    const capturedTestWriterChecks: ReviewCheckResult[][] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (_ctx: unknown, op: any, input: any): Promise<any> => {
      if (op.name === "autofix-test-writer") capturedTestWriterChecks.push(input?.failedChecks ?? []);
      return { applied: true };
    });
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });

    const ctx = makeCtx();
    // Semantic check (not adversarial) with mixed findings — only test-targeted should reach the test-writer
    ctx.reviewResult = {
      success: false,
      checks: [
        {
          ...failedCheck("semantic", "mixed findings"),
          findings: [
            { source: "semantic-review", severity: "error", category: "logic", message: "source bug", fixTarget: "source" as const },
            { source: "semantic-review", severity: "error", category: "test-gap", message: "missing test", fixTarget: "test" as const },
          ],
        },
      ],
    } as unknown as PipelineContext["reviewResult"];

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    expect(capturedTestWriterChecks.length).toBeGreaterThan(0);
    const receivedFindings = capturedTestWriterChecks[0]?.[0]?.findings ?? [];
    expect(receivedFindings).toHaveLength(1);
    expect(receivedFindings[0]?.fixTarget).toBe("test");
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
