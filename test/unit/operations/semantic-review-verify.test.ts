/**
 * Tests for semanticReviewOp.verify() — the op-internal filter pipeline.
 *
 * Covers AC1 (semantic half), AC13 (FAIL_OPEN / looksLikeFail short-circuit).
 * Evidence substantiation and AC-grounding behaviour is proven via mocked fs reads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { SemanticReviewInput, SemanticReviewOutput } from "@/operations/semantic-review";
import { makeTestRuntime, withTempDir } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";

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
    config: view.select(semanticReviewOp.config),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

function makeOutput(overrides: Partial<SemanticReviewOutput> = {}): SemanticReviewOutput {
  return {
    passed: true,
    findings: [],
    normalizedFindings: [],
    ...overrides,
  };
}

describe("semanticReviewOp.verify() — short-circuits (AC13)", () => {
  test("FAIL_OPEN short-circuits verify — returns parsed unchanged", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ failOpen: true, passed: true, findings: [], normalizedFindings: [] });
    const result = await semanticReviewOp.verify!(parsed, BASE_INPUT, ctx);
    expect(result).toBe(parsed); // exact reference equality — no mutation
  });

  test("looksLikeFail short-circuits verify — returns parsed unchanged", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ looksLikeFail: true, passed: false, findings: [], normalizedFindings: [] });
    const result = await semanticReviewOp.verify!(parsed, BASE_INPUT, ctx);
    expect(result).toBe(parsed);
  });

  test("empty findings short-circuits verify — returns parsed unchanged", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ passed: true, findings: [], normalizedFindings: [] });
    const result = await semanticReviewOp.verify!(parsed, BASE_INPUT, ctx);
    expect(result).toBe(parsed);
  });
});

describe("semanticReviewOp.verify() — acDropped (AC2/AC3)", () => {
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
      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.acDropped).toBeDefined();
      expect(result!.acDropped).toHaveLength(0);
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
      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.acDropped).toBeDefined();
      expect(result!.acDropped).toHaveLength(1);
      expect(result!.acDropped[0].code).toBe("missing_ac_index");
      expect(result!.acDropped[0].finding.issue).toBe("No AC attribution");
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
      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.acDropped).toBeDefined();
      expect(result!.acDropped).toHaveLength(1);
      expect(result!.acDropped[0].code).toBe("ac_index_out_of_range");
      expect(result!.acDropped[0].finding.issue).toBe("Out of range AC");
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
      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      // error finding should appear in normalizedFindings; warning should not
      expect(result!.normalizedFindings.some((f) => f.message?.includes("Missing input validation"))).toBe(true);
      expect(result!.normalizedFindings.some((f) => f.message?.includes("Consider logging"))).toBe(false);
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
      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.findings).toHaveLength(0);
      expect(result!.normalizedFindings).toHaveLength(0);
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
      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.passed).toBe(true); // no blocking findings → pass
      expect(result!.findings).toHaveLength(1); // advisory finding still surfaced
      expect(result!.normalizedFindings).toHaveLength(0); // but not blocking
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
      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.findings).toHaveLength(0); // all dropped
      expect(result!.passed).toBe(false); // fail-closed preserved
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
      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.findings).toHaveLength(1);
      expect(result!.normalizedFindings).toHaveLength(1);
      expect(result!.passed).toBe(false);
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

  function priorSemanticRound(n: number, message: string) {
    return {
      iterationNum: n,
      findingsBefore: [],
      fixesApplied: [],
      findingsAfter: [
        { source: "semantic-review", severity: "error", category: "", file: "src/h.ts", message, meta: { acIndex: 1 } },
      ],
      outcome: "fixes-applied",
      startedAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:01.000Z",
      // biome-ignore lint/suspicious/noExplicitAny: minimal Iteration shape
    } as any;
  }

  const finding = {
    severity: "error",
    file: "src/h.ts",
    line: 1,
    issue: "AC0 still unimplemented — reworded entirely this round",
    suggestion: "implement it",
    acIndex: 1,
  };

  async function runVerify(enabled: boolean) {
    const input: SemanticReviewInput = {
      ...BASE_INPUT,
      mode: "embedded", // skip evidence substantiation (ref-mode only)
      semanticConfig: { ...BASE_INPUT.semanticConfig, recurrenceDemotion: { enabled, maxBlockingRounds: 2 } },
      priorSemanticIterations: [priorSemanticRound(1, RECURRING), priorSemanticRound(2, `${RECURRING} again`)],
    };
    const parsed = { passed: false, findings: [finding], normalizedFindings: [], acDropped: [] };
    // biome-ignore lint/suspicious/noExplicitAny: verify ctx is unused on this path
    return (await semanticReviewOp.verify!(parsed as any, input, {} as any)) as SemanticReviewOutput;
  }

  test("demotes a third-round recurrence to advisory and lets the story pass", async () => {
    const out = await runVerify(true);
    expect(out.normalizedFindings).toHaveLength(0);
    expect(out.passed).toBe(true);
  });

  test("tags the demoted finding coverageGap so the audit record can distinguish it", async () => {
    const out = await runVerify(true);
    expect(out.advisoryFindings).toHaveLength(1);
    expect(out.advisoryFindings?.[0].meta?.coverageGap).toBe(true);
  });

  test("keeps the finding blocking when demotion is disabled (the default)", async () => {
    const out = await runVerify(false);
    expect(out.normalizedFindings).toHaveLength(1);
    expect(out.passed).toBe(false);
  });
});
