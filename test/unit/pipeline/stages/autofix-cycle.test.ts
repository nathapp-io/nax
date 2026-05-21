import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { _cycleDeps } from "@/findings";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import {
  applyTestEditDeclarations,
  autofixCapacityExhausted,
  buildAutofixStrategies,
  runAgentRectificationV2,
} from "../../../../src/pipeline/stages/autofix-cycle";
import type { Iteration } from "@/findings";
import type { Finding } from "@/findings";
import type { TestEditDeclaration } from "@/operations";
import type { PipelineContext } from "@/pipeline/types";
import { toAdversarialReviewFindings } from "../../../../src/review/adversarial-helpers";
import type { ReviewCheckResult } from "@/review/types";
import { makeMockAgentManager, makeMockRuntime, makeNaxConfig, makeStory } from "@test/helpers";

// ─── Minimal context for strategy/declaration unit tests ──────────────────────

function makeMinCtx(): PipelineContext {
  return {
    story: makeStory(),
    config: makeNaxConfig(),
    reviewResult: { success: false, checks: [] },
    workdir: "/tmp",
    agentManager: makeMockAgentManager(),
    // biome-ignore lint/suspicious/noExplicitAny: only fields read by buildAutofixStrategies are populated
  } as any;
}

// ─── Full context for V2 + capacity tests ─────────────────────────────────────

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

// ─── buildAutofixStrategies — implementer strategy ────────────────────────────

describe("buildAutofixStrategies — implementer strategy", () => {
  test("extractApplied stashes declarations on ctx.testEditDeclarations", () => {
    const ctx = makeMinCtx();
    const [, implementer] = buildAutofixStrategies(ctx, 3);

    const declarations: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/foo.spec.ts",
        prdQuote: "fn(x: number): void",
        testBefore: "fn()",
        testAfter: "fn(1)",
      },
    ];

    implementer.extractApplied?.(
      { applied: true, testEditDeclarations: declarations },
      // biome-ignore lint/suspicious/noExplicitAny: extractApplied only reads output
      undefined as any,
    );

    expect(ctx.testEditDeclarations).toEqual(declarations);
  });

  test("extractApplied appends to existing declarations rather than replacing", () => {
    const ctx = makeMinCtx();
    ctx.testEditDeclarations = [
      { reason: "prd_contract", file: "a.spec.ts", prdQuote: "x", testBefore: "x", testAfter: "x" },
    ];
    const [, implementer] = buildAutofixStrategies(ctx, 3);

    implementer.extractApplied?.(
      {
        applied: true,
        testEditDeclarations: [
          { reason: "prd_contract", file: "b.spec.ts", prdQuote: "y", testBefore: "y", testAfter: "y" },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: extractApplied only reads output
      undefined as any,
    );

    expect(ctx.testEditDeclarations).toHaveLength(2);
    expect(ctx.testEditDeclarations?.[0].file).toBe("a.spec.ts");
    expect(ctx.testEditDeclarations?.[1].file).toBe("b.spec.ts");
  });

  test("extractApplied is a no-op when output has no declarations", () => {
    const ctx = makeMinCtx();
    const [, implementer] = buildAutofixStrategies(ctx, 3);
    implementer.extractApplied?.(
      { applied: true, testEditDeclarations: [] },
      // biome-ignore lint/suspicious/noExplicitAny: extractApplied only reads output
      undefined as any,
    );
    expect(ctx.testEditDeclarations).toBeUndefined();
  });

  test("appliesTo returns false for prd_quote_mismatch advisory findings", () => {
    const ctx = makeMinCtx();
    const [, implementer] = buildAutofixStrategies(ctx, 3);
    const advisory: Finding = {
      source: "adversarial-review",
      severity: "warning",
      category: "prd_quote_mismatch",
      message: "PRD_QUOTE not found in story",
      file: "test/foo.spec.ts",
      fixTarget: "source",
    };
    expect(implementer.appliesTo(advisory)).toBe(false);
  });
});

// ─── buildAutofixStrategies — testWriter strategy ─────────────────────────────

describe("buildAutofixStrategies — testWriter strategy", () => {
  test("testWriter has maxAttempts: 2 (allow exactly one re-fire)", () => {
    const ctx = makeMinCtx();
    const [testWriter] = buildAutofixStrategies(ctx, 3);
    expect(testWriter.name).toBe("autofix-test-writer");
    expect(testWriter.maxAttempts).toBe(2);
  });
});

// ─── applyTestEditDeclarations ────────────────────────────────────────────────

describe("applyTestEditDeclarations", () => {
  function makeFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      source: "adversarial-review",
      severity: "error",
      category: "convention",
      message: "uses unsafe cast",
      file: "src/foo.ts",
      fixTarget: "source",
      ...overrides,
    };
  }

  test("re-tags matching source findings to fixTarget=test on valid prd_contract", () => {
    const story = makeStory({
      description: "fnA(x: number): void must be exposed",
    });
    const findings: Finding[] = [
      makeFinding({ file: "test/foo.spec.ts", message: "test calls fnA() without arg" }),
      makeFinding({ file: "src/bar.ts", message: "unrelated" }),
    ];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/foo.spec.ts",
        prdQuote: "fnA(x: number): void",
        testBefore: "fnA()",
        testAfter: "fnA(1)",
      },
    ];

    const out = applyTestEditDeclarations(findings, declarations, story);

    expect(out).toHaveLength(2);
    expect(out[0].fixTarget).toBe("test");
    expect(out[0].file).toBe("test/foo.spec.ts");
    expect(out[1].fixTarget).toBe("source");
  });

  test("emits a prd_quote_mismatch finding when quote is not in story", () => {
    const story = makeStory({ description: "Real story text" });
    const findings: Finding[] = [
      makeFinding({ file: "test/foo.spec.ts" }),
    ];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/foo.spec.ts",
        prdQuote: "fabricated(x): void",
        testBefore: "x",
        testAfter: "y",
      },
    ];

    const out = applyTestEditDeclarations(findings, declarations, story);

    // Original finding is left source-tagged
    expect(out[0].fixTarget).toBe("source");
    // A new advisory finding is appended
    const mismatch = out.find((f) => f.category === "prd_quote_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe("warning");
    expect(mismatch?.source).toBe("adversarial-review");
    expect(mismatch?.message).toContain("fabricated(x): void");
  });

  test("ignores lint_only and sibling_scope declarations (no re-tagging)", () => {
    const story = makeStory();
    const findings: Finding[] = [makeFinding({ file: "test/foo.spec.ts" })];
    const declarations: TestEditDeclaration[] = [
      { reason: "lint_only", file: "test/foo.spec.ts", finding: "no-x" },
      { reason: "sibling_scope", file: "test/foo.spec.ts", finding: "TS2304" },
    ];

    const out = applyTestEditDeclarations(findings, declarations, story);

    expect(out).toHaveLength(1);
    expect(out[0].fixTarget).toBe("source");
  });

  test("no-op on empty declarations", () => {
    const story = makeStory();
    const findings: Finding[] = [makeFinding()];
    expect(applyTestEditDeclarations(findings, [], story)).toEqual(findings);
  });

  test("drops a prd_contract declaration whose FILE matches no current finding", () => {
    const story = makeStory({ description: "fn(): void" });
    const findings: Finding[] = [makeFinding({ file: "test/other.spec.ts" })];
    const declarations: TestEditDeclaration[] = [
      {
        reason: "prd_contract",
        file: "test/missing.spec.ts",
        prdQuote: "fn(): void",
        testBefore: "x",
        testAfter: "y",
      },
    ];

    const out = applyTestEditDeclarations(findings, declarations, story);

    // No re-tagging, no mismatch finding
    expect(out).toHaveLength(1);
    expect(out[0].fixTarget).toBe("source");
  });
});

// ─── runAgentRectificationV2 ──────────────────────────────────────────────────

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
        ctx.reviewResult = {
          success: false,
          checks: [failedCheck("typecheck", "type error after lint fix")],
        } as unknown as PipelineContext["reviewResult"];
        return false;
      }
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

  test("test-writer runs before implementer within the same iteration (TDD order)", async () => {
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

    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 4 },
        },
      } as PipelineContext["config"],
    });
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

  test("returns unresolvedReason when implementer op signals UNRESOLVED", async () => {
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

  test("test-writer receives only test-targeted findings in fix-test-files mode", async () => {
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

  test("preserves testEditDeclarations when no findings present (validate never fires)", async () => {
    const ctx: PipelineContext = {
      ...makeCtx(),
      prd: { feature: "f" } as any,
    };
    ctx.testEditDeclarations = [
      { reason: "prd_contract", file: "test/foo.spec.ts", prdQuote: "x", testBefore: "y", testAfter: "z" },
    ];
    // No findings → cycle exits immediately; validate() is never called, so
    // the side-channel is NOT cleared (consumed on next pipeline retry).
    ctx.reviewResult = { success: false, checks: [] } as unknown as PipelineContext["reviewResult"];
    const saved = { ..._autofixDeps };
    _autofixDeps.recheckReview = async () => false;
    try {
      await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");
    } finally {
      Object.assign(_autofixDeps, saved);
    }

    expect(ctx.autofixPriorIterations).toBeDefined();
    // Side-channel still present — validate() never ran to consume it.
    expect(ctx.testEditDeclarations).toHaveLength(1);
  });

  test("validate closure forwards lite: false when mode is full (normal path)", async () => {
    const capturedRecheckCalls: Array<{ ctx: PipelineContext; opts?: { lite?: boolean } }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({ applied: true }));
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext, opts?: { lite?: boolean }) => {
      capturedRecheckCalls.push({ ctx, opts });
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });

    const ctx = makeCtx();
    ctx.reviewResult = {
      success: false,
      checks: [failedCheck("lint", "lint failure")],
    } as unknown as PipelineContext["reviewResult"];

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    // In normal (full) path, validate is called with mode: "full"
    // This should result in lite: false being passed to recheckReview — and never lite: true.
    expect(capturedRecheckCalls.length).toBeGreaterThan(0);
    const normalPathCall = capturedRecheckCalls.find((call) => call.opts?.lite === false);
    expect(normalPathCall).toBeDefined();
    expect(capturedRecheckCalls.every((call) => call.opts?.lite !== true)).toBe(true);
  });

  test("validate closure passes lite: true when autofix-implementer is exhausted (AC#4)", async () => {
    const capturedRecheckCalls: Array<{ opts?: { lite?: boolean } }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({ applied: true }));
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext, opts?: { lite?: boolean }) => {
      capturedRecheckCalls.push({ opts });
      // Keep findings present so the cycle exits with max-attempts-per-strategy, not resolved
      ctx.reviewResult = {
        success: false,
        checks: [failedCheck("lint", "still failing")],
      } as unknown as PipelineContext["reviewResult"];
      return false;
    });

    // maxAttempts: 1 exhausts the implementer after one iteration, which forces the
    // allExhausted branch in runFixCycle to call validate(ctx, { mode: "lite" })
    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          autofix: { enabled: true, maxAttempts: 1, maxTotalAttempts: 4 },
        },
      } as PipelineContext["config"],
    });
    ctx.reviewResult = {
      success: false,
      checks: [failedCheck("lint", "lint failure")],
    } as unknown as PipelineContext["reviewResult"];

    await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");

    // The exhausted-cycle path calls validate(ctx, { mode: "lite" }), which must
    // forward lite: true to recheckReview. A regression swapping === "lite" to === "full"
    // would break this assertion.
    const liteCall = capturedRecheckCalls.find((call) => call.opts?.lite === true);
    expect(liteCall).toBeDefined();
  });
});

// ─── autofixCapacityExhausted ─────────────────────────────────────────────────

function priorIteration(strategyNames: string[]): Iteration {
  return {
    iterationNum: 1,
    findingsBefore: [],
    fixesApplied: strategyNames.map((name) => ({
      strategyName: name,
      op: name,
      targetFiles: [],
      summary: "",
    })),
    findingsAfter: [],
    outcome: "unchanged",
    startedAt: "2026-05-07T00:00:00.000Z",
    finishedAt: "2026-05-07T00:00:01.000Z",
  };
}

describe("autofixCapacityExhausted", () => {
  test("false when there are no failing findings", () => {
    const ctx = makeCtx({
      reviewResult: { success: true, checks: [] } as unknown as PipelineContext["reviewResult"],
    });
    expect(autofixCapacityExhausted(ctx)).toBe(false);
  });


  test("true when an active strategy has reached its per-strategy cap", () => {
    const ctx = makeCtx({
      reviewResult: {
        success: false,
        checks: [
          {
            ...failedCheck("adversarial", "blocking"),
            findings: toAdversarialReviewFindings([
              {
                severity: "error",
                category: "assumption",
                file: "src/x.ts",
                line: 1,
                issue: "bug",
                suggestion: "fix",
              },
            ]),
          },
        ],
      } as unknown as PipelineContext["reviewResult"],
    });
    // test-writer has maxAttempts:2; two prior uses = exhausted
    ctx.autofixPriorIterations = [
      priorIteration(["autofix-test-writer", "autofix-implementer"]),
      priorIteration(["autofix-test-writer", "autofix-implementer"]),
    ];
    expect(autofixCapacityExhausted(ctx)).toBe(true);
  });

  test("true when total prior fixesApplied reaches maxTotalAttempts", () => {
    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          autofix: { enabled: true, maxAttempts: 5, maxTotalAttempts: 2 },
        },
      } as PipelineContext["config"],
    });
    ctx.autofixPriorIterations = [
      priorIteration(["autofix-implementer", "autofix-implementer"]),
    ];
    expect(autofixCapacityExhausted(ctx)).toBe(true);
  });

  test.each([
    ["no prior iterations", []],
    ["only implementer used once (cap not reached)", [priorIteration(["autofix-implementer"])]],
  ] as const)("false when %s", (_label, priorIterations) => {
    const ctx = makeCtx();
    ctx.autofixPriorIterations = priorIterations as any;
    expect(autofixCapacityExhausted(ctx)).toBe(false);
  });
});
