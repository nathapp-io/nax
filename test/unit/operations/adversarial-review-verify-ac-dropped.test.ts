/**
 * Tests for adversarialReviewOp.verify() — AC-dropped findings surfaced on a
 * passing verdict (#1950).
 *
 * Split out of adversarial-review-verify.test.ts (file-size limit) — mirrors that
 * file's setup pattern.
 *
 * An AC-quote-dropped finding must reach a human-facing surface when the verdict
 * passes. Before the fix, `dropped` fed only `acDropped` (a machine channel
 * nothing renders); the run-end "NON-BLOCKING REVIEW FINDINGS" surface reads
 * `advisoryFindings` only, so the drop evaporated on a passing verdict.
 *
 * Drives the REAL adversarialReviewOp.verify() (not a hand-authored fixture).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, makeTestRuntime, opSelector, withTempDir } from "@test/helpers";
import type { AdversarialReviewInput, AdversarialReviewOutput } from "@/operations/adversarial-review";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const STORY = {
  id: "STORY-AV-ACDROP-01",
  title: "Adversarial verify pipeline — AC-dropped findings",
  description: "Tests for adversarialReviewOp.verify() (#1950)",
  // ACs include locus keywords so filterByAcQuote can validate acQuote-locus grounding.
  // "auth" is extracted from file "src/auth.ts"; must appear in both AC text and acQuote.
  acceptanceCriteria: [
    "AC1: auth login security must not allow SQL injection attacks",
    "AC2: handler must not throw unhandled exceptions",
  ],
};

const BASE_INPUT: AdversarialReviewInput = {
  workdir: "/tmp/adversarial-verify-ac-dropped-test",
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
    config: view.select(opSelector(adversarialReviewOp.config)),
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

async function runVerify(
  parsed: AdversarialReviewOutput,
  input: AdversarialReviewInput,
  ctx: ReturnType<typeof makeVerifyCtx>,
) {
  const { verify } = adversarialReviewOp;
  assertDefined(verify, "adversarialReviewOp.verify");
  return verify(parsed, input, ctx);
}

function dropCandidateFinding(overrides: Partial<AdversarialLLMFinding> = {}): AdversarialLLMFinding {
  return {
    severity: "error",
    category: "security",
    file: "src/auth.ts",
    line: 1,
    issue: "No acQuote — will be dropped",
    suggestion: "fix",
    acIndex: 1,
    // verifiedBy passes substantiation; no acQuote → filterByAcQuote drops to acDropped
    verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
    ...overrides,
  };
}

describe("adversarialReviewOp.verify() — AC-dropped findings surfaced on a passing verdict (#1950)", () => {
  test("passing verdict + a dropped blocking finding: the drop is folded into advisoryFindings, tagged, and passed stays true", async () => {
    return withTempDir(async (workdir) => {
      const FILE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), FILE_CONTENT);

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = { ...BASE_INPUT, workdir, mode: "ref" };
      // Model claims pass while emitting a blocking-severity, ungrounded finding —
      // exactly #1950's precondition (validateAcQuote only inspects blocking severities).
      const parsed = makeOutput({
        passed: true,
        findings: [dropCandidateFinding()],
        normalizedFindings: [],
      });

      const output = await runVerify(parsed, input, ctx);
      assertDefined(output, "verify() result");

      expect(output.passed).toBe(true);
      expect(output.acDropped).toHaveLength(1);
      // Still never blocks — normalizedFindings stays empty.
      expect(output.normalizedFindings).toHaveLength(0);

      const advisory = output.advisoryFindings ?? [];
      expect(advisory).toHaveLength(1);
      expect(advisory[0]?.message).toContain("No acQuote");
      expect(advisory[0]?.acDropped).toBe(true);
    });
  });

  test("failing verdict (everything dropped, accepted empty): drops are NOT folded into advisoryFindings", async () => {
    return withTempDir(async (workdir) => {
      const FILE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), FILE_CONTENT);

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = { ...BASE_INPUT, workdir, mode: "ref" };
      const parsed = makeOutput({
        passed: false,
        findings: [dropCandidateFinding()],
        normalizedFindings: [],
      });

      const output = await runVerify(parsed, input, ctx);
      assertDefined(output, "verify() result");

      expect(output.passed).toBe(false);
      expect(output.acDropped).toHaveLength(1);
      expect(output.advisoryFindings ?? []).toHaveLength(0);
    });
  });

  test("no drops: advisoryFindings is byte-identical to today (unaffected)", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = { ...BASE_INPUT, workdir, mode: "ref" };
      const parsed = makeOutput({
        passed: true,
        findings: [
          {
            severity: "warning",
            category: "quality",
            file: "src/auth.ts",
            line: 1,
            issue: "Advisory only",
            suggestion: "Consider X",
          },
        ],
        normalizedFindings: [],
      });

      const output = await runVerify(parsed, input, ctx);
      assertDefined(output, "verify() result");

      expect(output.passed).toBe(true);
      expect(output.acDropped ?? []).toHaveLength(0);
      const advisory = output.advisoryFindings ?? [];
      expect(advisory).toHaveLength(1);
      expect(advisory[0]?.message).toBe("Advisory only");
      expect(advisory[0]?.acDropped).toBeUndefined();
    });
  });
});
