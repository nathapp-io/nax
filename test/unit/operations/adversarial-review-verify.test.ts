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
  acceptanceCriteria: ["AC1: security checks must pass", "AC2: no unhandled exceptions"],
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
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(
        join(workdir, "src", "auth.ts"),
        "function login(u, p) { return db.rawQuery(`SELECT * FROM users WHERE id=${u}`); }\n",
      );

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded", // embedded mode: substantiation still runs but observed matching is skipped for embedded
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
            acQuote: "security checks must pass",
          },
          {
            severity: "warning",
            category: "quality",
            file: "src/auth.ts",
            line: 1,
            issue: "Logging missing",
            suggestion: "Add logging",
            acIndex: 1,
            acQuote: "security checks must pass",
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
      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
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
            // No acQuote — filterByAcQuote drops this
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

  test("blocking/advisory split is correct — passed becomes true when all blocking are gone", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
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
            acIndex: 1,
            acQuote: "security checks must pass",
          },
        ],
        normalizedFindings: [],
      });
      const result = await adversarialReviewOp.verify!(parsed, input, ctx);
      expect(result).not.toBeNull();
      expect(result!.passed).toBe(true);
      expect(result!.normalizedFindings).toHaveLength(0);
    });
  });

  test("blocking error finding with valid acQuote survives filter pipeline", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(
        join(workdir, "src", "auth.ts"),
        "function login(u, p) { return db.rawQuery(`SELECT * FROM users WHERE id=${u}`); }\n",
      );

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
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
            acQuote: "security checks must pass",
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

  test("dropped findings are tracked in acDropped on output", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = {
        ...BASE_INPUT,
        workdir,
        mode: "embedded",
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
            // no acQuote
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
