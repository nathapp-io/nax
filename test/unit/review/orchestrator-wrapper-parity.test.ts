/**
 * Parity tests — op verify() filter pipeline vs. wrapper consumer (AC10, AC11).
 *
 * Verifies that findings which survive verify()'s filter pipeline are the same
 * findings the wrapper reads from opResult. After the Task-6 refactor, the wrapper
 * reads opResult.findings and opResult.normalizedFindings directly — verify() is the
 * single filter SSOT. These tests guard against a regression where the wrapper
 * re-implements filtering or ignores the op's output.
 *
 * US-001 (semantic) is covered in the first describe block.
 * US-002 (adversarial) is covered in the second describe block (Task 13).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  makeAgentAdapter,
  makeIteration,
  makeMockAgentManager,
  makeMockRuntime,
  makeSpawn,
  makeTestRuntime,
  opSelector,
  withTempDir,
} from "@test/helpers";
import type { IAgentManager } from "@/agents";
import type { AdversarialReviewInput, AdversarialReviewOutput } from "@/operations/adversarial-review";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { SemanticReviewInput } from "@/operations/semantic-review";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { AdversarialReviewConfig, SemanticStory } from "@/review";
import { _adversarialDeps, _diffUtilsDeps, runAdversarialReview } from "@/review";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const STORY = {
  id: "STORY-PARITY-S01",
  title: "Parity test story",
  description: "verify() parity with wrapper",
  acceptanceCriteria: ["AC1: the feature works correctly", "AC2: error cases are handled"],
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

function makeAdversarialVerifyCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return {
    packageView: view,
    config: view.select(opSelector(adversarialReviewOp.config)),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

const ADVERSARIAL_STORY = {
  id: "STORY-PARITY-A01",
  title: "Adversarial parity test story",
  description: "verify() parity with adversarial wrapper",
  acceptanceCriteria: [
    "AC1: auth login must not allow SQL injection attacks",
    "AC2: error cases are handled gracefully",
  ],
};

describe("Semantic op verify() parity with wrapper consumer (AC10, AC11)", () => {
  test("blocking findings from verify() appear in normalizedFindings — wrapper reads them as-is", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        workdir,
        story: STORY,
        semanticConfig: {
          model: "balanced" as const,
          diffMode: "embedded" as const,
          resetRefOnRerun: false,
          rules: [],
          timeoutMs: 600_000,
          substantiation: { requote: true, maxRequotes: 5 },
        },
        mode: "embedded", // skip evidence substantiation
        blockingThreshold: "error",
      };

      const parsed = {
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection",
            suggestion: "parameterize",
            acIndex: 1,
          },
          {
            severity: "warning",
            file: "src/auth.ts",
            line: 1,
            issue: "Consider logging",
            suggestion: "add log",
            acIndex: 1,
          },
        ],
        normalizedFindings: [],
        acDropped: [],
      };

      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();

      // The blocking error finding should be in normalizedFindings — the wrapper
      // returns these as `findings` on ReviewCheckResult.
      expect(result!.normalizedFindings).toHaveLength(1);
      expect(result!.normalizedFindings[0]?.source).toBe("semantic-review");
      expect(result!.normalizedFindings[0]?.message).toContain("SQL injection");

      // The advisory warning should NOT be in normalizedFindings.
      expect(result!.normalizedFindings.some((f) => f.message?.includes("Consider logging"))).toBe(false);

      // opResult.findings contains all accepted findings (blocking + advisory).
      expect(result!.findings).toHaveLength(2);
    });
  });

  test("advisory-only run: verdict passes (nax#1347) with empty normalizedFindings", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        workdir,
        story: STORY,
        semanticConfig: {
          model: "balanced" as const,
          diffMode: "embedded" as const,
          resetRefOnRerun: false,
          rules: [],
          timeoutMs: 600_000,
          substantiation: { requote: true, maxRequotes: 5 },
        },
        mode: "embedded",
        blockingThreshold: "error",
      };

      const parsed = {
        passed: false, // LLM said failed, but only advisory findings
        findings: [
          {
            severity: "warning",
            file: "src/auth.ts",
            line: 1,
            issue: "Minor style issue",
            suggestion: "reformat",
            acIndex: 1,
          },
        ],
        normalizedFindings: [],
        acDropped: [],
      };

      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();

      // nax#1347: with only advisory (sub-threshold) findings surviving, the verdict
      // honours blockingThreshold and passes — the LLM's raw passed:false no longer
      // fails the review when nothing is blocking. The advisory finding is still surfaced.
      expect(result!.passed).toBe(true);
      expect(result!.findings).toHaveLength(1);
      expect(result!.normalizedFindings).toHaveLength(0);
    });
  });

  test("invalid acIndex drops blocking finding — wrapper sees empty normalizedFindings", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: SemanticReviewInput = {
        workdir,
        story: STORY,
        semanticConfig: {
          model: "balanced" as const,
          diffMode: "embedded" as const,
          resetRefOnRerun: false,
          rules: [],
          timeoutMs: 600_000,
          substantiation: { requote: true, maxRequotes: 5 },
        },
        mode: "embedded",
        blockingThreshold: "error",
      };

      const parsed = {
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/auth.ts",
            line: 1,
            issue: "Bad finding without AC attribution",
            suggestion: "fix it",
            acIndex: 99, // out of range — only 2 ACs
          },
        ],
        normalizedFindings: [],
        acDropped: [],
      };

      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();

      // Dropped by AC-grounding filter — should not reach normalizedFindings.
      expect(result!.findings).toHaveLength(0);
      expect(result!.normalizedFindings).toHaveLength(0);
      // verify() preserves the failure signal so the wrapper can fail-closed.
      expect(result!.passed).toBe(false);
    });
  });
});

describe("Adversarial op verify() parity with wrapper consumer (AC10, AC11 adversarial)", () => {
  test("blocking finding with valid acQuote survives — wrapper reads from normalizedFindings", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const ctx = makeAdversarialVerifyCtx();
      const input: AdversarialReviewInput = {
        workdir,
        story: ADVERSARIAL_STORY,
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

      const parsed = {
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection via rawQuery",
            suggestion: "Use parameterized queries",
            acIndex: 1,
            acQuote: "auth login must not allow SQL injection",
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
          },
          {
            severity: "warning",
            category: "quality",
            file: "src/auth.ts",
            line: 1,
            issue: "Missing error logging",
            suggestion: "Add logger",
          },
        ],
        normalizedFindings: [],
        acDropped: [],
      };

      const result = await adversarialReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();

      // Blocking error finding survives → in normalizedFindings with source tag.
      expect(result!.normalizedFindings).toHaveLength(1);
      expect(result!.normalizedFindings[0]?.source).toBe("adversarial-review");
      expect(result!.normalizedFindings[0]?.message).toContain("SQL injection");

      // Advisory warning NOT in normalizedFindings.
      expect(result!.normalizedFindings.some((f) => f.message?.includes("Missing error logging"))).toBe(false);
    });
  });

  test("advisory-only run: verdict passes (nax#1378) with empty normalizedFindings", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeAdversarialVerifyCtx();
      const input: AdversarialReviewInput = {
        workdir,
        story: ADVERSARIAL_STORY,
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

      const parsed = {
        passed: false, // LLM said failed but only advisory findings
        findings: [
          {
            severity: "warning",
            category: "quality",
            file: "src/auth.ts",
            line: 1,
            issue: "Advisory note",
            suggestion: "consider X",
          },
        ],
        normalizedFindings: [],
        acDropped: [],
      };

      const result = await adversarialReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();

      // nax#1378 — parity with semantic (nax#1347): the verdict honours blockingThreshold,
      // so an advisory-only result passes. Preserving the LLM's raw failure signal here
      // deadlocked the story: the wrapper saw passed:false with nothing routable, so the
      // rectification cycle had no finding to hand a fix strategy.
      expect(result!.passed).toBe(true);
      expect(result!.normalizedFindings).toHaveLength(0);
    });
  });

  test("AC-dropped blocking finding → wrapper sees empty normalizedFindings and passed:false", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const ctx = makeAdversarialVerifyCtx();
      const input: AdversarialReviewInput = {
        workdir,
        story: ADVERSARIAL_STORY,
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

      const parsed = {
        passed: false,
        findings: [
          {
            severity: "error",
            category: "convention",
            file: "src/auth.ts",
            line: 1,
            issue: "Custom interface convention violation",
            suggestion: "remove it",
            acIndex: 1,
            // No acQuote → filterByAcQuote drops this finding
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
          },
        ],
        normalizedFindings: [],
        acDropped: [],
      };

      const result = await adversarialReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();

      // AC-dropped → verify() preserves passed:false so the wrapper can fail-closed.
      expect(result!.passed).toBe(false);
      expect(result!.findings).toHaveLength(0);
      expect(result!.normalizedFindings).toHaveLength(0);
      // The drop is tracked in acDropped for counterfactual telemetry.
      expect((result as import("@/operations/adversarial-review").AdversarialReviewOutput).acDropped).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Recurrence-demotion parity: adversarialReviewOp.verify() and the wrapper
// (runAdversarialReview()) each call classifyRecurrence independently — the
// op inside verify(), the wrapper again over opResult.findings (see
// src/review/adversarial.ts). This guards against those two call sites
// drifting apart, and against the coverage-gap tag (Fix: tagCoverageGap)
// being applied inconsistently between them.
//
// This is a full both-paths test: the SAME accepted finding + prior
// iterations + recurrenceDemotion config are run through (a) the op's own
// verify() directly and (b) the wrapper's real end-to-end dispatch (via
// runAdversarialReview() -> callOp -> adversarialReviewOp), using the same
// harness as test/unit/review/adversarial-pass-fail.test.ts (mocked agent
// response + mocked git diff/stat spawn calls, no LLM/network I/O).
// ---------------------------------------------------------------------------

describe("Recurrence-demotion parity: op verify() vs wrapper recomputation", () => {
  const RECURRENCE_STORY: SemanticStory = {
    id: "STORY-PARITY-RECUR",
    title: "Recurrence parity story",
    description: "op/wrapper classifyRecurrence parity",
    acceptanceCriteria: ["Users can log in"],
  };

  const RECURRENCE_CONFIG: AdversarialReviewConfig = {
    model: "balanced",
    diffMode: "ref",
    rules: [],
    timeoutMs: 180_000,
    excludePatterns: [],
    parallel: false,
    maxConcurrentSessions: 2,
  };

  const RECURRING_FINDING = {
    severity: "error",
    category: "error-path",
    file: "src/log.ts",
    line: 10,
    issue: "No error handling on login",
    suggestion: "Add try/catch",
    acQuote: "can log in",
    acIndex: 1,
    verifiedBy: { file: "src/log.ts", observed: "login handler stub" },
  };

  // Two prior iterations under the same fingerprint (file + category + issue
  // prefix), both "error" — with default maxBlockingRounds=2, the third
  // sighting (n=3 >= maxBlockingRounds+1) demotes to advisory + coverage-gap.
  const PRIOR_ITERATIONS = Array.from({ length: 2 }, (_v, i) =>
    makeIteration({
      iterationNum: i + 1,
      outcome: "regressed",
      startedAt: "2026-07-17T00:00:00.000Z",
      finishedAt: "2026-07-17T00:00:01.000Z",
      findingsAfter: [
        {
          source: "adversarial-review",
          severity: "error",
          category: "error-path",
          file: "src/log.ts",
          message: "No error handling on login",
        },
      ],
    }),
  );

  const STAT_OUTPUT = "src/log.ts | 5 +++++\n 1 file changed, 5 insertions(+)";

  function makeAgentManager(llmResponse: string): IAgentManager {
    return makeMockAgentManager({
      getDefaultAgent: "claude",
      completeFn: async () => ({
        output: llmResponse,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
      }),
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: llmResponse,
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        estimatedCostUsd: 0.001,
        internalRoundTrips: 0,
      }),
      completeWithFallbackFn: async () => ({
        result: {
          output: llmResponse,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0.001,
        },
        fallbacks: [],
      }),
      completeAsFn: async () => ({
        output: llmResponse,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
      }),
      getAgentFn: () => makeAgentAdapter(),
    });
  }

  let origSpawn: typeof _diffUtilsDeps.spawn;
  let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
  let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
  let origWriteReviewAudit: typeof _adversarialDeps.writeReviewAudit;

  beforeEach(() => {
    origSpawn = _diffUtilsDeps.spawn;
    origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    origGetMergeBase = _diffUtilsDeps.getMergeBase;
    origWriteReviewAudit = _adversarialDeps.writeReviewAudit;
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    _diffUtilsDeps.spawn = makeSpawn(() => STAT_OUTPUT).spawn;
  });

  afterEach(() => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
    _adversarialDeps.writeReviewAudit = origWriteReviewAudit;
  });

  test("op verify() and wrapper agree on blocking/advisory/demoted partition and coverage-gap tagging", async () => {
    const llmResponse = JSON.stringify({ passed: false, findings: [RECURRING_FINDING] });

    // --- Path A: op.verify() called directly with the same accepted finding + priors. ---
    const opCtx = makeAdversarialVerifyCtx();
    const opInput: AdversarialReviewInput = {
      workdir: "/tmp/wd",
      repoRoot: "/tmp/wd",
      story: RECURRENCE_STORY,
      adversarialConfig: RECURRENCE_CONFIG,
      mode: "ref",
      storyGitRef: "abc123",
      blockingThreshold: "error",
      priorAdversarialIterations: PRIOR_ITERATIONS,
    };
    const opParsed: AdversarialReviewOutput = {
      passed: false,
      findings: [RECURRING_FINDING],
      normalizedFindings: [],
      acDropped: [],
    };
    const opResult = await adversarialReviewOp.verify!(opParsed, opInput, opCtx);
    assertDefined(opResult, "verify() result");

    // --- Path B: full wrapper dispatch — runAdversarialReview() -> callOp -> adversarialReviewOp. ---
    const agentManager = makeAgentManager(llmResponse);
    const runtime = makeMockRuntime({ agentManager });
    const wrapperResult = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: RECURRENCE_STORY,
      adversarialConfig: RECURRENCE_CONFIG,
      agentManager,
      runtime,
      priorAdversarialIterations: PRIOR_ITERATIONS,
    });

    // Both paths classify the sole finding as demoted (n=3 >= maxBlockingRounds+1):
    // nothing blocks, and the demoted finding surfaces as advisory.
    expect(opResult.passed).toBe(true);
    expect(opResult.normalizedFindings).toHaveLength(0);
    expect(opResult.advisoryFindings).toHaveLength(1);

    expect(wrapperResult.success).toBe(opResult.passed);
    expect(wrapperResult.findings).toBeUndefined();
    expect(wrapperResult.advisoryFindings).toHaveLength(opResult.advisoryFindings?.length ?? -1);

    // Both paths tag the demoted finding with the coverage-gap marker (Fix: tagCoverageGap).
    expect(opResult.advisoryFindings?.[0]?.meta?.coverageGap).toBe(true);
    expect(wrapperResult.advisoryFindings?.[0]?.meta?.coverageGap).toBe(true);

    // Same underlying finding identity in both paths.
    expect(wrapperResult.advisoryFindings?.[0]?.message).toBe(opResult.advisoryFindings?.[0]?.message);
  });
});
