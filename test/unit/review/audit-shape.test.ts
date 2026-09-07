/**
 * Review-audit persisted shape (#1861) — characterization test.
 *
 * #942 assumed the review audit persisted canonical `ReviewFinding` (ruleId +
 * message). #1859 found that assumption was tested only through a dead entry
 * point (`runSemanticReview` / the deleted `src/review/semantic.ts`), never
 * through the live op path. This test drives the REAL op path —
 * `adversarialReviewOp.verify()` and `semanticReviewOp.verify()`, exactly what
 * `src/execution/story-orchestrator/review-decision.ts` reads to build the
 * persisted `ReviewAuditEntry` — and asserts the shape those ops actually
 * emit for `result.findings` and `advisoryFindings`.
 *
 * It does NOT hand-author a fixture finding and assert expectations against
 * it: the LLM-shaped input below is the reviewer's raw wire output (what a
 * parsed LLM turn looks like), and every assertion is on what the op's own
 * verify() pipeline converts that into. That is the boundary #1861 rules on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, makeTestRuntime, opSelector, withTempDir } from "@test/helpers";
import type { AdversarialReviewInput, AdversarialReviewOutput } from "@/operations/adversarial-review";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { SemanticReviewInput, SemanticReviewOutput } from "@/operations/semantic-review";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeVerifyCtx(op: typeof adversarialReviewOp | typeof semanticReviewOp) {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return {
    packageView: view,
    config: view.select(opSelector(op.config)),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

describe("adversarialReviewOp — persisted audit shape (#1861)", () => {
  const STORY = {
    id: "STORY-AUDIT-01",
    title: "Audit shape story",
    description: "Drives adversarialReviewOp.verify() to inspect its emitted shape",
    acceptanceCriteria: ["AC1: auth login security must not allow SQL injection attacks"],
  };

  const BASE_INPUT: AdversarialReviewInput = {
    workdir: "/tmp/audit-shape-test",
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

  function makeOutput(overrides: Partial<AdversarialReviewOutput> = {}): AdversarialReviewOutput {
    return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
  }

  test("result.findings (what review-decision.ts persists as ReviewAuditEntry.result) stays the raw LLM shape: issue/category, no message/ruleId", async () => {
    return withTempDir(async (workdir) => {
      const FILE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), FILE_CONTENT);

      const ctx = makeVerifyCtx(adversarialReviewOp);
      const input: AdversarialReviewInput = { ...BASE_INPUT, workdir };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection via string concatenation",
            suggestion: "Use parameterized queries",
            acIndex: 1,
            acQuote: "auth login security must not allow SQL injection",
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
          },
        ],
      });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const result = await verify(parsed, input, ctx);
      assertDefined(result, "verify() result");

      expect(result.findings).toHaveLength(1);
      const raw = result.findings[0] as Record<string, unknown>;
      expect(raw.issue).toBe("SQL injection via string concatenation");
      expect(raw.category).toBe("security");
      expect(raw.message).toBeUndefined();
      expect(raw.ruleId).toBeUndefined();
    });
  });

  test("advisoryFindings (Finding shape) carries message, not issue, for a sub-threshold finding", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx(adversarialReviewOp);
      const input: AdversarialReviewInput = { ...BASE_INPUT, workdir };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "warning",
            category: "quality",
            file: "src/auth.ts",
            line: 1,
            issue: "Logging is missing on the failure path",
            suggestion: "Add a log line",
            // non-blocking — substantiation and AC-grounding both skip non-blocking severities
          },
        ],
      });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const result = await verify(parsed, input, ctx);
      assertDefined(result, "verify() result");

      assertDefined(result.advisoryFindings, "advisoryFindings");
      expect(result.advisoryFindings).toHaveLength(1);
      const finding = result.advisoryFindings[0];
      expect(finding.message).toBe("Logging is missing on the failure path");
      expect(finding.category).toBe("quality");
      // `Finding` has no `issue` / `ruleId` field at all — a wrong field name
      // must not compile (#1816), so these are structural checks, not runtime
      // ones. Curator's findingRuleId() derives a ruleId downstream (from
      // `result.findings`, not `advisoryFindings`), falling back to
      // `category` when the raw record has no ruleId/rule/checkId.
      expect("issue" in finding).toBe(false);
      expect("ruleId" in finding).toBe(false);
    });
  });
});

describe("semanticReviewOp — persisted audit shape (#1861)", () => {
  const STORY = {
    id: "STORY-AUDIT-02",
    title: "Audit shape story",
    description: "Drives semanticReviewOp.verify() to inspect its emitted shape",
    acceptanceCriteria: ["AC0: returns 200 on success"],
  };

  const BASE_INPUT: SemanticReviewInput = {
    workdir: "/tmp/audit-shape-semantic-test",
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

  function makeOutput(overrides: Partial<SemanticReviewOutput> = {}): SemanticReviewOutput {
    return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
  }

  test("result.findings stays the raw LLM shape: issue/category, no message", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx(semanticReviewOp);
      const input: SemanticReviewInput = { ...BASE_INPUT, workdir };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "unimplemented",
            file: "src/auth.ts",
            line: 1,
            issue: "AC 0 handler returns 500 on valid credentials",
            suggestion: "fix the happy path",
            acIndex: 1,
          },
        ],
      });

      const { verify } = semanticReviewOp;
      assertDefined(verify, "semanticReviewOp.verify");
      const result = await verify(parsed, input, ctx);
      assertDefined(result, "verify() result");

      expect(result.findings).toHaveLength(1);
      const raw = result.findings[0] as Record<string, unknown>;
      expect(raw.issue).toBe("AC 0 handler returns 500 on valid credentials");
      expect(raw.category).toBe("unimplemented");
      expect(raw.message).toBeUndefined();
      expect(raw.ruleId).toBeUndefined();
    });
  });

  // Previously, a plain sub-threshold-severity finding did NOT reach
  // semanticReviewOp's advisoryFindings: verify() intersected the
  // recurrence-demotion "advisory" bucket with `isBlockingSeverity` before
  // converting (src/operations/semantic-review.ts, the removed
  // `subThreshold.filter(...)` line) — an inverted condition, since `advisory`
  // is already the sub-threshold bucket and intersecting it with
  // "is blocking-severity" produced the empty set on every default-config run.
  // That was ruled a defect and fixed in nax#1865: semantic now forwards its
  // `advisory` bucket unfiltered, matching adversarialReviewOp.verify(). This
  // test still drives the recurrence-demoted path specifically (a
  // formerly-blocking finding demoted after recurring past maxBlockingRounds),
  // because that path is what exercises the Finding/ReviewFinding shape
  // question #1861 rules on (`message`/no `issue`) — not because it is the
  // only path into advisoryFindings any more.
  test("advisoryFindings (recurrence-demoted path) carries message, not issue", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx(semanticReviewOp);
      const RECURRING = "AC0 still unimplemented — the handler returns 500";
      const priorRound = (n: number, message: string) => ({
        iterationNum: n,
        findingsBefore: [],
        fixesApplied: [],
        findingsAfter: [
          {
            source: "semantic-review" as const,
            severity: "error" as const,
            category: "unimplemented",
            file: "src/auth.ts",
            message,
            meta: { acIndex: 1 },
          },
        ],
        outcome: "unchanged" as const,
        startedAt: "2026-08-01T00:00:00.000Z",
        finishedAt: "2026-08-01T00:00:01.000Z",
      });
      const input: SemanticReviewInput = {
        ...BASE_INPUT,
        workdir,
        semanticConfig: { ...BASE_INPUT.semanticConfig, recurrenceDemotion: { enabled: true, maxBlockingRounds: 2 } },
        priorSemanticIterations: [priorRound(1, RECURRING), priorRound(2, `${RECURRING} again`)],
      };
      const parsed = makeOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "unimplemented",
            file: "src/auth.ts",
            line: 1,
            issue: RECURRING,
            suggestion: "fix the happy path",
            acIndex: 1,
          },
        ],
      });

      const { verify } = semanticReviewOp;
      assertDefined(verify, "semanticReviewOp.verify");
      const result = await verify(parsed, input, ctx);
      assertDefined(result, "verify() result");

      assertDefined(result.advisoryFindings, "advisoryFindings");
      expect(result.advisoryFindings).toHaveLength(1);
      const finding = result.advisoryFindings[0];
      expect(finding.message).toBe(RECURRING);
      expect(finding.category).toBe("unimplemented");
      // `Finding` has no `issue` / `ruleId` field at all — structural checks,
      // not runtime ones (see the adversarial block above for the rationale).
      expect("issue" in finding).toBe(false);
      expect("ruleId" in finding).toBe(false);
    });
  });
});
