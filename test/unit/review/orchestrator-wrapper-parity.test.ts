/**
 * Parity tests — op verify() filter pipeline vs. wrapper consumer (AC10, AC11).
 *
 * Verifies that findings which survive verify()'s filter pipeline are the same
 * findings the wrapper reads from opResult. After the Task-6 refactor, the wrapper
 * reads opResult.findings and opResult.normalizedFindings directly — verify() is the
 * single filter SSOT. These tests guard against a regression where the wrapper
 * re-implements filtering or ignores the op's output.
 *
 * US-001 (semantic) is covered here.
 * US-002 (adversarial) tests are added in Task 13.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { semanticReviewOp } from "../../../src/operations/semantic-review";
import type { SemanticReviewInput } from "../../../src/operations/semantic-review";
import { makeTestRuntime, withTempDir } from "../../helpers";
import type { NaxRuntime } from "../../../src/runtime";

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
    config: view.select(semanticReviewOp.config),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

describe("Semantic op verify() parity with wrapper consumer (AC10, AC11)", () => {
  test("blocking findings from verify() appear in normalizedFindings — wrapper reads them as-is", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(
        join(workdir, "src", "auth.ts"),
        "function login(u, p) { return db.rawQuery(u + p); }\n",
      );

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

  test("advisory-only run: passed becomes true and normalizedFindings is empty", async () => {
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
      };

      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();

      // verify() overrides LLM's passed:false — no blocking findings → passed.
      expect(result!.passed).toBe(true);
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
      };

      const result = await semanticReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();

      // Dropped by AC-grounding filter — should not reach normalizedFindings.
      expect(result!.findings).toHaveLength(0);
      expect(result!.normalizedFindings).toHaveLength(0);
      // verify() is authoritative — no blocking findings → passed.
      expect(result!.passed).toBe(true);
    });
  });
});
