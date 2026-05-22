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
  test("extractApplied stashes declarations; no-op when output has no declarations", () => {
    const ctx = makeMinCtx();
    const [, implementer] = buildAutofixStrategies(ctx, 3);
    const declarations: TestEditDeclaration[] = [{ reason: "prd_contract", file: "test/foo.spec.ts", prdQuote: "fn(x: number): void", testBefore: "fn()", testAfter: "fn(1)" }];
    // biome-ignore lint/suspicious/noExplicitAny: extractApplied only reads output
    implementer.extractApplied?.({ applied: true, testEditDeclarations: declarations }, undefined as any);
    expect(ctx.testEditDeclarations).toEqual(declarations);

    const ctx2 = makeMinCtx();
    const [, implementer2] = buildAutofixStrategies(ctx2, 3);
    // biome-ignore lint/suspicious/noExplicitAny: extractApplied only reads output
    implementer2.extractApplied?.({ applied: true, testEditDeclarations: [] }, undefined as any);
    expect(ctx2.testEditDeclarations).toBeUndefined();
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

  test("no-op on empty declarations; drops declaration whose FILE matches no current finding", () => {
    const story = makeStory();
    const findings: Finding[] = [makeFinding()];
    expect(applyTestEditDeclarations(findings, [], story)).toEqual(findings);

    const story2 = makeStory({ description: "fn(): void" });
    const findings2: Finding[] = [makeFinding({ file: "test/other.spec.ts" })];
    const declarations2: TestEditDeclaration[] = [{ reason: "prd_contract", file: "test/missing.spec.ts", prdQuote: "fn(): void", testBefore: "x", testAfter: "y" }];
    const out = applyTestEditDeclarations(findings2, declarations2, story2);
    expect(out).toHaveLength(1);
    expect(out[0].fixTarget).toBe("source");
  });
});

// ─── runAgentRectificationV2 ──────────────────────────────────────────────────

describe("runAgentRectificationV2", () => {
  test("returns succeeded=true when cycle resolves; succeeded=false when findings remain", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({ applied: true }));
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });
    const resolved = await runAgentRectificationV2(makeCtx(), undefined, undefined, "/tmp");
    expect(resolved.succeeded).toBe(true);
    expect(resolved.cost).toBe(0);

    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: false, checks: [failedCheck("lint", "still failing")] } as unknown as PipelineContext["reviewResult"];
      return false;
    });
    const failed = await runAgentRectificationV2(makeCtx(), undefined, undefined, "/tmp");
    expect(failed.succeeded).toBe(false);
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

  test("test-writer fires for test-targeted findings (inline and adapter output)", async () => {
    const makeOpsCapture = () => {
      const capturedOps: string[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      _cycleDeps.callOp = mock(async (_ctx: unknown, op: any): Promise<any> => { capturedOps.push(op.name as string); return { applied: true }; });
      _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => { ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"]; return true; });
      return capturedOps;
    };

    // inline finding with fixTarget: "test"
    const ops1 = makeOpsCapture();
    const ctx1 = makeCtx();
    ctx1.reviewResult = { success: false, checks: [{ ...failedCheck("adversarial", "test gap found"), findings: [{ source: "adversarial-review", severity: "error", category: "test-gap", message: "missing test", fixTarget: "test" }] }] } as unknown as PipelineContext["reviewResult"];
    await runAgentRectificationV2(ctx1, undefined, undefined, "/tmp");
    expect(ops1).toContain("autofix-test-writer");

    // real adversarial adapter output
    const ops2 = makeOpsCapture();
    const ctx2 = makeCtx();
    ctx2.reviewResult = { success: false, checks: [{ ...failedCheck("adversarial", "test gap found"), findings: toAdversarialReviewFindings([{ severity: "error", category: "test-gap", file: "src/foo.ts", line: 1, issue: "missing behavioral test", suggestion: "add coverage" }]) }] } as unknown as PipelineContext["reviewResult"];
    await runAgentRectificationV2(ctx2, undefined, undefined, "/tmp");
    expect(ops2).toContain("autofix-test-writer");
    expect(ops2).not.toContain("autofix-implementer");
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

  test("persists iterations to autofixPriorIterations on ctx; preserves testEditDeclarations when no findings present", async () => {
    // Sub-scenario 1: persists iterations
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({ applied: true }));
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext) => {
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });
    const ctx1 = makeCtx();
    await runAgentRectificationV2(ctx1, undefined, undefined, "/tmp");
    expect(ctx1.autofixPriorIterations).toBeDefined();
    expect(ctx1.autofixPriorIterations?.length).toBeGreaterThanOrEqual(1);

    // Sub-scenario 2: no findings → cycle exits immediately; validate() never runs; testEditDeclarations preserved
    _cycleDeps.callOp = savedCycleCallOp;
    _autofixDeps.recheckReview = async () => false;
    const ctx2: PipelineContext = { ...makeCtx(), prd: { feature: "f" } as any };
    ctx2.testEditDeclarations = [{ reason: "prd_contract", file: "test/foo.spec.ts", prdQuote: "x", testBefore: "y", testAfter: "z" }];
    ctx2.reviewResult = { success: false, checks: [] } as unknown as PipelineContext["reviewResult"];
    await runAgentRectificationV2(ctx2, undefined, undefined, "/tmp");
    expect(ctx2.autofixPriorIterations).toBeDefined();
    expect(ctx2.testEditDeclarations).toHaveLength(1);
  });

  test("validate closure: lite=false on normal path; lite=true when implementer exhausted (AC#4)", async () => {
    // Normal path: validate called with mode "full" → lite: false
    const fullCalls: Array<{ ctx: PipelineContext; opts?: { lite?: boolean } }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    _cycleDeps.callOp = mock(async (): Promise<any> => ({ applied: true }));
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext, opts?: { lite?: boolean }) => {
      fullCalls.push({ ctx, opts });
      ctx.reviewResult = { success: true, checks: [] } as unknown as PipelineContext["reviewResult"];
      return true;
    });
    const ctxFull = makeCtx();
    ctxFull.reviewResult = { success: false, checks: [failedCheck("lint", "lint failure")] } as unknown as PipelineContext["reviewResult"];
    await runAgentRectificationV2(ctxFull, undefined, undefined, "/tmp");
    expect(fullCalls.length).toBeGreaterThan(0);
    expect(fullCalls.find((c) => c.opts?.lite === false)).toBeDefined();
    expect(fullCalls.every((c) => c.opts?.lite !== true)).toBe(true);

    // Exhausted path: maxAttempts: 1 exhausts implementer → allExhausted calls validate(ctx, { mode: "lite" })
    const liteCalls: Array<{ opts?: { lite?: boolean } }> = [];
    _autofixDeps.recheckReview = mock(async (ctx: PipelineContext, opts?: { lite?: boolean }) => {
      liteCalls.push({ opts });
      ctx.reviewResult = { success: false, checks: [failedCheck("lint", "still failing")] } as unknown as PipelineContext["reviewResult"];
      return false;
    });
    const ctxExhausted = makeCtx({ config: { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, autofix: { enabled: true, maxAttempts: 1, maxTotalAttempts: 4 } } } as PipelineContext["config"] });
    ctxExhausted.reviewResult = { success: false, checks: [failedCheck("lint", "lint failure")] } as unknown as PipelineContext["reviewResult"];
    await runAgentRectificationV2(ctxExhausted, undefined, undefined, "/tmp");
    expect(liteCalls.find((c) => c.opts?.lite === true)).toBeDefined();
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


  test("true when per-strategy cap reached or total fixesApplied reaches maxTotalAttempts", () => {
    // Per-strategy cap: test-writer has maxAttempts:2; two prior uses = exhausted
    const ctx1 = makeCtx({
      reviewResult: {
        success: false,
        checks: [{ ...failedCheck("adversarial", "blocking"), findings: toAdversarialReviewFindings([{ severity: "error", category: "assumption", file: "src/x.ts", line: 1, issue: "bug", suggestion: "fix" }]) }],
      } as unknown as PipelineContext["reviewResult"],
    });
    ctx1.autofixPriorIterations = [
      priorIteration(["autofix-test-writer", "autofix-implementer"]),
      priorIteration(["autofix-test-writer", "autofix-implementer"]),
    ];
    expect(autofixCapacityExhausted(ctx1)).toBe(true);

    // Total attempts cap
    const ctx2 = makeCtx({
      config: { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, autofix: { enabled: true, maxAttempts: 5, maxTotalAttempts: 2 } } } as PipelineContext["config"],
    });
    ctx2.autofixPriorIterations = [priorIteration(["autofix-implementer", "autofix-implementer"])];
    expect(autofixCapacityExhausted(ctx2)).toBe(true);
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
