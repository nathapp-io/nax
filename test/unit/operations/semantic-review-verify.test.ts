/**
 * Tests for semanticReviewOp.verify() — the op-internal filter pipeline.
 *
 * Covers AC1 (semantic half), AC13 (FAIL_OPEN / looksLikeFail short-circuit).
 * Evidence substantiation and AC-grounding behaviour is proven via mocked fs reads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, makeTestRuntime, opSelector, withTempDir } from "@test/helpers";
import type { Iteration } from "@/findings";
import type { SemanticReviewInput, SemanticReviewOutput } from "@/operations/semantic-review";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { NaxRuntime } from "@/runtime";
import type { ResolvedTestPatterns } from "@/test-runners";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const STORY = {
  id: "STORY-V01",
  title: "Verify filter pipeline",
  description: "Tests for verify()",
  acceptanceCriteria: ["AC0: returns 200 on success"],
};

const BASE_INPUT: SemanticReviewInput = {
  workdir: "/tmp/verify-test",
  story: STORY,
  semanticConfig: {
    model: "balanced" as const,
    diffMode: "ref" as const,
    resetRefOnRerun: false,
    rules: [],
    timeoutMs: 600_000,
    substantiation: { requote: true, maxRequotes: 5 },
  },
  mode: "ref",
  blockingThreshold: "error",
};

function makeVerifyCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return {
    packageView: view,
    config: view.select(opSelector(semanticReviewOp.config)),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

function makeOutput(overrides: Partial<SemanticReviewOutput> = {}): SemanticReviewOutput {
  return {
    passed: true,
    findings: [],
    normalizedFindings: [],
    acDropped: [],
    ...overrides,
  };
}

// verify is optional on the op interface (src/operations/types.ts) because ops may omit
// it; this op implements it. Asserting on the method keeps absence failing loudly here
// instead of relying on a compile-only `!`.
async function runVerify(
  parsed: SemanticReviewOutput,
  input: SemanticReviewInput,
  ctx: ReturnType<typeof makeVerifyCtx>,
) {
  const { verify } = semanticReviewOp;
  assertDefined(verify, "semanticReviewOp.verify");
  return verify(parsed, input, ctx);
}

/**
 * The short-circuit branches previously asserted `toBe(parsed)` — reference
 * identity, which encoded a no-mutation guarantee. verify() now stamps
 * blockingThreshold onto every branch, so it necessarily returns a NEW object
 * and identity no longer holds. The guarantee itself still does, so it is
 * asserted directly here rather than dropped: the input is deep-compared
 * against a snapshot taken before the call.
 */
async function runVerifyExpectingNoInputMutation(
  parsed: SemanticReviewOutput,
  input: SemanticReviewInput,
  ctx: ReturnType<typeof makeVerifyCtx>,
) {
  const before = structuredClone(parsed);
  const result = await runVerify(parsed, input, ctx);
  expect(parsed).toEqual(before);
  return result;
}

describe("semanticReviewOp.verify() — short-circuits (AC13)", () => {
  // verify() now stamps blockingThreshold onto all three short-circuit
  // branches (mirroring adversarialReviewOp — see US-003 AC8), so it returns
  // a new object rather than the same `parsed` reference. Assertions are
  // content supersets (toMatchObject) plus an explicit no-mutation check,
  // together covering what the old `toBe(parsed)` identity assertion did.
  test("FAIL_OPEN short-circuits verify — returns parsed content unchanged", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ failOpen: true, passed: true, findings: [], normalizedFindings: [] });
    const result = await runVerifyExpectingNoInputMutation(parsed, BASE_INPUT, ctx);
    expect(result).toMatchObject(parsed);
  });

  test("looksLikeFail short-circuits verify — returns parsed content unchanged", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ looksLikeFail: true, passed: false, findings: [], normalizedFindings: [] });
    const result = await runVerifyExpectingNoInputMutation(parsed, BASE_INPUT, ctx);
    expect(result).toMatchObject(parsed);
  });

  test("empty findings short-circuits verify — returns parsed content unchanged", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ passed: true, findings: [], normalizedFindings: [] });
    const result = await runVerifyExpectingNoInputMutation(parsed, BASE_INPUT, ctx);
    expect(result).toMatchObject(parsed);
  });

  // blockingThreshold was previously only stamped on the main return path — the
  // empty-findings branch (47.2% of August semantic reviews) and the
  // failOpen/looksLikeFail give-ups silently dropped it. All three now persist it.
  test("verify() persists blockingThreshold from input onto output on the FAIL_OPEN path", async () => {
    const ctx = makeVerifyCtx();
    const input: SemanticReviewInput = { ...BASE_INPUT, blockingThreshold: "warning" };
    const parsed = makeOutput({ failOpen: true, passed: true, findings: [], normalizedFindings: [] });
    const result = await runVerify(parsed, input, ctx);
    assertDefined(result, "verify() result");
    expect(result.blockingThreshold).toBe("warning");
  });

  test("verify() persists blockingThreshold from input onto output on the looksLikeFail path", async () => {
    const ctx = makeVerifyCtx();
    const input: SemanticReviewInput = { ...BASE_INPUT, blockingThreshold: "info" };
    const parsed = makeOutput({ looksLikeFail: true, passed: false, findings: [], normalizedFindings: [] });
    const result = await runVerify(parsed, input, ctx);
    assertDefined(result, "verify() result");
    expect(result.blockingThreshold).toBe("info");
  });

  // Critical branch — 47.2% of August semantic reviews hit the empty-findings
  // short-circuit. Missing blockingThreshold here alone would make the fix look
  // like it worked while the majority of real records stayed null.
  test("verify() persists blockingThreshold from input onto output on the empty-findings path", async () => {
    const ctx = makeVerifyCtx();
    const input: SemanticReviewInput = { ...BASE_INPUT, blockingThreshold: "warning" };
    const parsed = makeOutput({ passed: true, findings: [], normalizedFindings: [] });
    const result = await runVerify(parsed, input, ctx);
    assertDefined(result, "verify() result");
    expect(result.blockingThreshold).toBe("warning");
  });

  test("verify() defaults blockingThreshold to error when input omits it", async () => {
    const ctx = makeVerifyCtx();
    const { blockingThreshold: _omit, ...inputWithoutThreshold } = BASE_INPUT;
    const parsed = makeOutput({ passed: true, findings: [], normalizedFindings: [] });
    const result = await runVerify(parsed, inputWithoutThreshold, ctx);
    assertDefined(result, "verify() result");
    expect(result.blockingThreshold).toBe("error");
  });
});

describe("semanticReviewOp.verify() — acDropped (AC2/AC3)", () => {
  test("routes findings in configured test files to the test lane", async () => {
    const ctx = makeVerifyCtx();
    const result = await runVerify(
      makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "test/unit/auth.test.ts",
            line: 1,
            issue: "Test is incomplete",
            suggestion: "cover the error path",
            acIndex: 1,
          },
        ],
      }),
      {
        ...BASE_INPUT,
        mode: "embedded",
        resolvedTestPatterns: {
          globs: ["test/**/*.test.ts"],
          pathspec: [":!test/**"],
          regex: [/^test\//],
          testDirs: ["test"],
          resolution: "fallback",
        } satisfies ResolvedTestPatterns,
      },
      ctx,
    );
    assertDefined(result, "verify() result");
    expect(result.normalizedFindings[0]?.fixTarget).toBe("test");
  });

  test("acDropped is empty array when no blocking findings are dropped", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "Valid finding",
            suggestion: "Fix it",
            acIndex: 1, // valid, will survive filter
          },
        ],
        normalizedFindings: [],
      });
      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      expect(result.acDropped).toHaveLength(0);
    });
  });

  test("blocking finding without acIndex is dropped to acDropped with missing_ac_index", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "No AC attribution",
            suggestion: "Fix it",
            // no acIndex → dropped with missing_ac_index
          },
        ],
        normalizedFindings: [],
      });
      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      expect(result.acDropped).toHaveLength(1);
      expect(result.acDropped[0].code).toBe("missing_ac_index");
      expect(result.acDropped[0].finding.issue).toBe("No AC attribution");
    });
  });

  test("blocking finding with out-of-range acIndex is dropped to acDropped with ac_index_out_of_range", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "Out of range AC",
            suggestion: "Fix it",
            acIndex: 99, // out of range for story with 1 AC
          },
        ],
        normalizedFindings: [],
      });
      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      expect(result.acDropped).toHaveLength(1);
      expect(result.acDropped[0].code).toBe("ac_index_out_of_range");
      expect(result.acDropped[0].finding.issue).toBe("Out of range AC");
    });
  });
});

describe("semanticReviewOp.verify() — filter pipeline (AC1 semantic)", () => {
  test("verify() is defined on the op", () => {
    expect(typeof semanticReviewOp.verify).toBe("function");
  });

  test("advisory findings below blockingThreshold are excluded from normalizedFindings", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login() { return true; }\n");

      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded", // embedded mode skips substantiation
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "Missing input validation",
            suggestion: "Validate input",
            acIndex: 1, // 1-based; story has 1 AC so this is valid
          },
          {
            severity: "warning",
            file: "src/auth.ts",
            line: 1,
            issue: "Consider logging",
            suggestion: "Add a log",
            acIndex: 1, // non-blocking findings pass through regardless
          },
        ],
        normalizedFindings: [],
      });
      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      // error finding should appear in normalizedFindings; warning should not
      expect(result.normalizedFindings.some((f) => f.message?.includes("Missing input validation"))).toBe(true);
      expect(result.normalizedFindings.some((f) => f.message?.includes("Consider logging"))).toBe(false);
    });
  });

  test("warning finding at threshold error reaches advisoryFindings; error finding does not (#1865)", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login() { return true; }\n");

      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded", // embedded mode skips substantiation
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "Missing input validation",
            suggestion: "Validate input",
            acIndex: 1,
          },
          {
            severity: "warning",
            file: "src/auth.ts",
            line: 1,
            issue: "Consider logging",
            suggestion: "Add a log",
            acIndex: 1,
          },
        ],
        normalizedFindings: [],
      });
      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      assertDefined(result.advisoryFindings, "advisoryFindings");
      // The fix under #1865: the sub-threshold warning must now surface in
      // advisoryFindings instead of being silently dropped by the old
      // `subThreshold.filter((f) => isBlockingSeverity(...))` intersection-with-its-
      // own-complement bug.
      expect(result.advisoryFindings.some((f) => f.message?.includes("Consider logging"))).toBe(true);
      // The blocking error finding must NOT appear in advisoryFindings — this is the
      // other side of the regression test: it proves the fix forwards only the
      // sub-threshold bucket, not everything indiscriminately.
      expect(result.advisoryFindings.some((f) => f.message?.includes("Missing input validation"))).toBe(false);
      // ...and it must still reach normalizedFindings, unaffected by this change.
      expect(result.normalizedFindings.some((f) => f.message?.includes("Missing input validation"))).toBe(true);
    });
  });

  test("finding without valid acIndex is dropped from accepted (AC-grounding filter)", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "No AC attribution",
            suggestion: "Fix it",
            acIndex: 99, // out of range
          },
        ],
        normalizedFindings: [],
      });
      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      expect(result.findings).toHaveLength(0);
      expect(result.normalizedFindings).toHaveLength(0);
    });
  });

  test("#1347: advisory-only findings pass the verdict even when the model reports passed:false", async () => {
    // Regression for nax#1347. When the model emits only sub-threshold (advisory)
    // findings but sets passed:false, the verdict must honour blockingThreshold —
    // there are no blocking findings, so the review passes. The advisory findings
    // are still surfaced (they are not silently dropped), just non-blocking.
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "warning",
            file: "src/auth.ts",
            line: 1,
            issue: "Advisory only",
            suggestion: "Consider X",
            acIndex: 1, // non-blocking; passes through regardless of acIndex validity
          },
        ],
        normalizedFindings: [],
      });
      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      expect(result.passed).toBe(true); // no blocking findings → pass
      expect(result.findings).toHaveLength(1); // advisory finding still surfaced
      expect(result.normalizedFindings).toHaveLength(0); // but not blocking
    });
  });

  test("#1347: fail-closed guard preserved — model passed:false with all findings dropped stays failing", async () => {
    // The advisory-pass fix must NOT weaken the fail-closed guard: when the model
    // claims failure but every finding is dropped as ungrounded (accepted empty),
    // the verdict stays false so an ungrounded-but-real blocker can't slip through.
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "Ungrounded blocker",
            suggestion: "Fix it",
            acIndex: 99, // out of range → dropped from accepted
          },
        ],
        normalizedFindings: [],
      });
      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      expect(result.findings).toHaveLength(0); // all dropped
      expect(result.passed).toBe(false); // fail-closed preserved
    });
  });

  test("blocking error finding with valid acIndex survives filter pipeline", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.query(u, p); }\n");

      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection risk",
            suggestion: "Use parameterized query",
            acIndex: 1, // 1-based; story has 1 AC so this is valid
          },
        ],
        normalizedFindings: [],
      });
      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      expect(result.findings).toHaveLength(1);
      expect(result.normalizedFindings).toHaveLength(1);
      expect(result.passed).toBe(false);
    });
  });
});

/**
 * Recurrence-demotion for semantic review (F1b). Opt-in: default disabled.
 *
 * The coverageGap assertion is the load-bearing one — `llmFindingToFinding`
 * rebuilds `meta` from scratch, so tagging before the LLMFinding -> Finding
 * conversion would silently drop the tag and the review-audit record would
 * show a plain advisory.
 */
describe("semanticReviewOp.verify() — recurrence demotion", () => {
  const RECURRING = "AC0 is not implemented — the handler returns 500";

  function priorSemanticRound(n: number, message: string): Iteration {
    return {
      iterationNum: n,
      findingsBefore: [],
      fixesApplied: [],
      findingsAfter: [
        { source: "semantic-review", severity: "error", category: "", file: "src/h.ts", message, meta: { acIndex: 1 } },
      ],
      outcome: "unchanged",
      startedAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:01.000Z",
    };
  }

  const finding = {
    severity: "error",
    file: "src/h.ts",
    line: 1,
    issue: "AC0 still unimplemented — reworded entirely this round",
    suggestion: "implement it",
    acIndex: 1,
  };

  async function verifyWithDemotion(enabled: boolean) {
    const input: SemanticReviewInput = {
      ...BASE_INPUT,
      mode: "embedded", // skip evidence substantiation (ref-mode only)
      semanticConfig: { ...BASE_INPUT.semanticConfig, recurrenceDemotion: { enabled, maxBlockingRounds: 2 } },
      priorSemanticIterations: [priorSemanticRound(1, RECURRING), priorSemanticRound(2, `${RECURRING} again`)],
    };
    const parsed = makeOutput({ passed: false, findings: [finding], normalizedFindings: [], acDropped: [] });
    const result = await semanticReviewOp.verify(parsed, input, makeVerifyCtx());
    assertDefined(result);
    return result;
  }

  test("demotes a third-round recurrence to advisory and lets the story pass", async () => {
    const out = await verifyWithDemotion(true);
    expect(out.normalizedFindings).toHaveLength(0);
    expect(out.passed).toBe(true);
  });

  test("tags the demoted finding coverageGap so the audit record can distinguish it", async () => {
    const out = await verifyWithDemotion(true);
    expect(out.advisoryFindings).toHaveLength(1);
    expect(out.advisoryFindings?.[0].meta?.coverageGap).toBe(true);
  });

  test("keeps the finding blocking when demotion is disabled (the default)", async () => {
    const out = await verifyWithDemotion(false);
    expect(out.normalizedFindings).toHaveLength(1);
    expect(out.passed).toBe(false);
  });
});
