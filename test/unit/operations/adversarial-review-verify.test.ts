/**
 * Tests for adversarialReviewOp.verify() — the op-internal filter pipeline (AC2, AC13).
 *
 * Covers AC2 (adversarial half), AC13 (FAIL_OPEN / looksLikeFail short-circuit).
 * Evidence substantiation and AC-grounding behaviour is proven via mocked fs reads.
 *
 * Run RED first (verify() is undefined), then implement in Task 10.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { adversarialReviewOp } from "../../../src/operations/adversarial-review";
import type { AdversarialReviewInput, AdversarialReviewOutput } from "../../../src/operations/adversarial-review";
import { makeTestRuntime, withTempDir } from "../../helpers";
import type { NaxRuntime } from "../../../src/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const STORY = {
  id: "STORY-AV01",
  title: "Adversarial verify pipeline",
  description: "Tests for adversarialReviewOp.verify()",
  // ACs include locus keywords so filterByAcQuote can validate acQuote-locus grounding.
  // "auth" is extracted from file "src/auth.ts"; must appear in both AC text and acQuote.
  acceptanceCriteria: [
    "AC1: auth login security must not allow SQL injection attacks",
    "AC2: handler must not throw unhandled exceptions",
  ],
};

const BASE_INPUT: AdversarialReviewInput = {
  workdir: "/tmp/adversarial-verify-test",
  story: STORY,
  adversarialConfig: {
    model: "balanced" as const,
    diffMode: "ref" as const,
    rules: [],
    timeoutMs: 600_000,
    parallel: false,
    maxConcurrentSessions: 2,
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
    config: view.select(adversarialReviewOp.config),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

function makeOutput(overrides: Partial<AdversarialReviewOutput> = {}): AdversarialReviewOutput {
  return {
    passed: true,
    findings: [],
    normalizedFindings: [],
    acDropped: [],
    ...overrides,
  };
}

describe("adversarialReviewOp.verify() — short-circuits (AC13)", () => {
  test("FAIL_OPEN short-circuits verify — returns parsed unchanged", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ failOpen: true, passed: true, findings: [], normalizedFindings: [] });
    const result = await adversarialReviewOp.verify!(parsed, BASE_INPUT, ctx);
    expect(result).toBe(parsed);
  });

  test("looksLikeFail short-circuits verify — returns parsed unchanged", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ looksLikeFail: true, passed: false, findings: [], normalizedFindings: [] });
    const result = await adversarialReviewOp.verify!(parsed, BASE_INPUT, ctx);
    expect(result).toBe(parsed);
  });

  test("empty findings short-circuits verify — returns parsed unchanged", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ passed: true, findings: [], normalizedFindings: [] });
    const result = await adversarialReviewOp.verify!(parsed, BASE_INPUT, ctx);
    expect(result).toBe(parsed);
  });
});

describe("adversarialReviewOp.verify() — filter pipeline (AC2 adversarial)", () => {
  test("verify() is defined on the op", () => {
    expect(typeof adversarialReviewOp.verify).toBe("function");
  });

  test("advisory findings below blockingThreshold excluded from normalizedFindings", async () => {
    return withTempDir(async (workdir) => {
      const FILE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), FILE_CONTENT);

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "ref",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection",
            suggestion: "Use parameterized queries",
            acIndex: 1,
            acQuote: "auth login security must not allow SQL injection",
            // verifiedBy.observed must match file content for substantiation to pass
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
          },
          {
            severity: "warning",
            category: "quality",
            file: "src/auth.ts",
            line: 1,
            issue: "Logging missing",
            suggestion: "Add logging",
            // non-blocking — substantiation and filterByAcQuote both skip non-blocking
          },
        ],
        normalizedFindings: [],
      });
      const result = await adversarialReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      // error finding should be in normalizedFindings; warning should not
      expect(result!.normalizedFindings.some((f) => f.message?.includes("SQL injection"))).toBe(true);
      expect(result!.normalizedFindings.some((f) => f.message?.includes("Logging missing"))).toBe(false);
    });
  });

  test("blocking finding without valid acQuote is dropped from accepted (AC-grounding filter)", async () => {
    return withTempDir(async (workdir) => {
      const FILE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), FILE_CONTENT);

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "ref",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "No AC attribution",
            suggestion: "Fix it",
            acIndex: 1,
            // verifiedBy passes substantiation, but no acQuote → filterByAcQuote drops this
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
          },
        ],
        normalizedFindings: [],
      });
      const result = await adversarialReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.findings).toHaveLength(0);
      expect(result!.normalizedFindings).toHaveLength(0);
    });
  });

  test("blocking/advisory split preserves passed:false when only advisory findings remain", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "ref",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "warning",
            category: "quality",
            file: "src/auth.ts",
            line: 1,
            issue: "Advisory only",
            suggestion: "Consider X",
            // non-blocking — filterByAcQuote and substantiation both skip non-blocking
          },
        ],
        normalizedFindings: [],
      });
      const result = await adversarialReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.passed).toBe(false);
      expect(result!.normalizedFindings).toHaveLength(0);
    });
  });

  test("blocking error finding with valid acQuote survives filter pipeline", async () => {
    return withTempDir(async (workdir) => {
      const FILE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), FILE_CONTENT);

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "ref",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection risk",
            suggestion: "Use parameterized query",
            acIndex: 1,
            // "auth" from file basename appears in AC text → locus-constrained ✓
            acQuote: "auth login security must not allow SQL injection",
            // verifiedBy.observed is a substring of the actual file content
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
          },
        ],
        normalizedFindings: [],
      });
      const result = await adversarialReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.findings).toHaveLength(1);
      expect(result!.normalizedFindings).toHaveLength(1);
      expect(result!.passed).toBe(false);
    });
  });

  test("recurrence: an error finding recurring beyond maxBlockingRounds demotes to advisory (passes)", async () => {
    // acQuote must be a substring of the indexed AC and contain a locus keyword
    // (file basename or an issue token) per validateAcQuote's locus check.
    const AC_TEXT = "store window expiry must be handled atomically";
    const OBSERVED = "db.rawQuery";
    const finding = {
      severity: "error",
      category: "assumption",
      file: "lib/store.ts",
      line: 1,
      issue: "window expiry non-atomic",
      suggestion: "x",
      acQuote: AC_TEXT,
      acIndex: 1,
      verifiedBy: { file: "lib/store.ts", observed: OBSERVED },
    };
    const priors = Array.from({ length: 2 }, (_v, i) => ({
      iterationNum: i + 1,
      findingsBefore: [],
      fixesApplied: [],
      outcome: "fixes-applied",
      startedAt: "2026-07-17T00:00:00.000Z",
      finishedAt: "2026-07-17T00:00:01.000Z",
      findingsAfter: [
        {
          source: "adversarial-review",
          severity: "error",
          category: "assumption",
          file: "lib/store.ts",
          message: "window expiry non-atomic",
        },
      ],
    }));
    const ctx = makeVerifyCtx();
    const input: AdversarialReviewInput = {
      ...BASE_INPUT,
      story: { ...STORY, acceptanceCriteria: [AC_TEXT] },
      priorAdversarialIterations: priors as any,
      resolvedTestPatterns: { regex: [/\.spec\.ts$/] } as any,
    };
    const parsed = makeOutput({ passed: false, findings: [finding], normalizedFindings: [], acDropped: [] });
    const out = await adversarialReviewOp.verify!(parsed, input, ctx);
    expect(out.passed).toBe(true);
    expect(out.normalizedFindings.length).toBe(0);
    expect((out.advisoryFindings ?? []).length).toBe(1);
    // Fix (design §7): recurrence-demoted findings are tagged so the run-end
    // summary / review-audit JSON can distinguish them from ordinary advisories.
    expect(out.advisoryFindings?.[0]?.meta?.coverageGap).toBe(true);
  });

  test("oscillation: an error finding whose prior sighting was a warning is suppressed to advisory and the story passes", async () => {
    // acQuote must be a substring of the indexed AC and contain a locus keyword
    // (file basename or an issue token) per validateAcQuote's locus check.
    const AC_TEXT = "store window expiry must be handled atomically";
    const OBSERVED = "db.rawQuery";
    const finding = {
      severity: "error",
      category: "assumption",
      file: "lib/store.ts",
      line: 1,
      issue: "window expiry non-atomic",
      suggestion: "x",
      acQuote: AC_TEXT,
      acIndex: 1,
      verifiedBy: { file: "lib/store.ts", observed: OBSERVED },
    };
    // exactly ONE prior round, where the same fingerprint appeared as a WARNING
    const priors = [
      {
        iterationNum: 1,
        findingsBefore: [],
        fixesApplied: [],
        outcome: "fixes-applied",
        startedAt: "2026-07-17T00:00:00.000Z",
        finishedAt: "2026-07-17T00:00:01.000Z",
        findingsAfter: [
          {
            source: "adversarial-review",
            severity: "warning",
            category: "assumption",
            file: "lib/store.ts",
            message: "window expiry non-atomic",
          },
        ],
      },
    ];
    const ctx = makeVerifyCtx();
    const input: AdversarialReviewInput = {
      ...BASE_INPUT,
      story: { ...STORY, acceptanceCriteria: [AC_TEXT] },
      priorAdversarialIterations: priors as any,
      resolvedTestPatterns: { regex: [/\.spec\.ts$/] } as any,
    };
    const parsed = makeOutput({ passed: false, findings: [finding], normalizedFindings: [], acDropped: [] });
    const out = await adversarialReviewOp.verify!(parsed, input, ctx);
    // n=2, prev=warning → entry guard suppresses → advisory, not blocking
    expect(out.passed).toBe(true);
    expect(out.normalizedFindings.length).toBe(0);
    expect((out.advisoryFindings ?? []).length).toBe(1);
    // A plain (non-demoted) advisory must NOT carry the coverage-gap tag —
    // only recurrence-demoted findings do (see the recurrence test above).
    expect(out.advisoryFindings?.[0]?.meta?.coverageGap).not.toBe(true);
  });

  test("dropped findings are tracked in acDropped on output", async () => {
    return withTempDir(async (workdir) => {
      const FILE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), FILE_CONTENT);

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "ref",
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "No acQuote — will be dropped",
            suggestion: "fix",
            acIndex: 1,
            // verifiedBy passes substantiation; no acQuote → filterByAcQuote drops to acDropped
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
          },
        ],
        normalizedFindings: [],
      });
      const result = await adversarialReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      // acDropped should have the dropped finding
      expect((result as AdversarialReviewOutput).acDropped).toHaveLength(1);
    });
  });
});

describe("adversarialReviewOp.verify() — scope grounding", () => {
  const storyWithScope = {
    ...STORY,
    outOfScope: ["An interactive Ink TUI", "Per-story checkpoints"],
  };
  const inputWithScope: AdversarialReviewInput = { ...BASE_INPUT, story: storyWithScope };

  function scopeFinding(overrides: Record<string, unknown> = {}) {
    return {
      severity: "warning",
      category: "out-of-scope",
      file: "src/auth.ts",
      line: 10,
      issue: "Story added an Ink TUI",
      suggestion: "Remove the TUI",
      scopeQuote: "An interactive Ink TUI",
      scopeIndex: 1,
      ...overrides,
    };
  }

  test("keeps a scope finding whose scopeQuote is grounded in story.outOfScope", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ passed: false, findings: [scopeFinding()] as never, normalizedFindings: [] });

    const result = await adversarialReviewOp.verify!(parsed, inputWithScope, ctx);

    expect(result?.findings).toHaveLength(1);
  });

  test("drops a scope finding citing a boundary the story never declared", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({
      passed: false,
      findings: [scopeFinding({ scopeQuote: "a REST API nobody deferred" })] as never,
      normalizedFindings: [],
    });

    const result = await adversarialReviewOp.verify!(parsed, inputWithScope, ctx);

    expect(result?.findings).toHaveLength(0);
  });

  test("drops a scope citation when the story declares no exclusions at all", async () => {
    const ctx = makeVerifyCtx();
    const parsed = makeOutput({ passed: false, findings: [scopeFinding()] as never, normalizedFindings: [] });

    const result = await adversarialReviewOp.verify!(parsed, BASE_INPUT, ctx);

    expect(result?.findings).toHaveLength(0);
  });

  test("keeps a scope finding that offers no citation (description-level Scope bullet)", async () => {
    const ctx = makeVerifyCtx();
    const finding = scopeFinding({ scopeQuote: undefined, scopeIndex: undefined });
    const parsed = makeOutput({ passed: false, findings: [finding] as never, normalizedFindings: [] });

    const result = await adversarialReviewOp.verify!(parsed, inputWithScope, ctx);

    expect(result?.findings).toHaveLength(1);
  });
});
