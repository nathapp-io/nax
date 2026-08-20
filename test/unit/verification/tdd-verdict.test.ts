import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  VERDICT_FILE,
  type VerifierVerdict,
  categorizeVerdict,
  cleanupVerdict,
  coerceVerdict,
  readVerdict,
} from "../../../src/tdd/verdict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVerdict(overrides: Partial<VerifierVerdict> = {}): VerifierVerdict {
  return {
    version: 1,
    approved: true,
    tests: {
      allPassing: true,
      passCount: 10,
      failCount: 0,
    },
    testModifications: {
      detected: false,
      files: [],
      legitimate: true,
      reasoning: "No test files modified",
    },
    acceptanceCriteria: {
      allMet: true,
      criteria: [{ criterion: "It works", met: true }],
    },
    quality: {
      rating: "good",
      issues: [],
    },
    fixes: [],
    reasoning: "All good.",
    ...overrides,
  };
}

async function writeVerdictFile(workdir: string, content: unknown): Promise<void> {
  const filePath = path.join(workdir, VERDICT_FILE);
  await writeFile(filePath, JSON.stringify(content, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Setup: temp directories per test group
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("nax-verdict-test-");
});

afterEach(() => {
  cleanupTempDir(tmpDir);
});

// ---------------------------------------------------------------------------
// readVerdict
// ---------------------------------------------------------------------------

describe("readVerdict", () => {
  test("returns parsed verdict when file exists and is valid", async () => {
    const verdict = makeVerdict();
    await writeVerdictFile(tmpDir, verdict);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.approved).toBe(true);
    expect(result?.tests.allPassing).toBe(true);
    expect(result?.tests.passCount).toBe(10);
    expect(result?.tests.failCount).toBe(0);
    expect(result?.reasoning).toBe("All good.");
  });

  test.each([
    ["empty directory", () => tmpDir],
    ["non-existent directory", () => "/tmp/this-dir-does-not-exist-xyz-nax"],
  ] as const)("returns null when verdict file does not exist (%s)", async (_label, getDir) => {
    const result = await readVerdict(getDir());
    expect(result).toBeNull();
  });

  test.each([
    ["malformed JSON", "{ this is not valid json }"],
    ["truncated JSON", '{"version": 1, "approved": true, "tests":'],
  ])("returns null when JSON is %s (no throw)", async (_label, content) => {
    const filePath = path.join(tmpDir, VERDICT_FILE);
    await writeFile(filePath, content, "utf-8");
    const result = await readVerdict(tmpDir);
    expect(result).toBeNull();
  });

  test.each([
    ["version missing", (d: any) => { delete d.version; }, (r: VerifierVerdict) => r.version, 1],
    ["approved missing", (d: any) => { d.approved = undefined; }, (r: VerifierVerdict) => r.approved, false],
    ["tests missing", (d: any) => { d.tests = undefined; }, (r: VerifierVerdict) => r.tests.passCount, 0],
    ["tests.allPassing missing", (d: any) => { d.tests.allPassing = undefined; }, (r: VerifierVerdict) => r.tests.passCount, 10],
    ["testModifications missing", (d: any) => { d.testModifications = undefined; }, (r: VerifierVerdict) => r.testModifications.detected, false],
    ["acceptanceCriteria missing", (d: any) => { d.acceptanceCriteria = undefined; }, (r: VerifierVerdict) => r.acceptanceCriteria.criteria, []],
    ["quality missing", (d: any) => { d.quality = undefined; }, (r: VerifierVerdict) => r.quality.rating, "acceptable"],
    ["quality.rating invalid", (d: any) => { d.quality.rating = "excellent"; }, (r: VerifierVerdict) => r.quality.rating, "acceptable"],
    ["fixes missing", (d: any) => { d.fixes = undefined; }, (r: VerifierVerdict) => r.fixes, []],
    ["reasoning missing", (d: any) => { d.reasoning = undefined; }, (r: VerifierVerdict) => r.version, 1],
  ])("coerces when %s", async (_label, mutate, getField, expected) => {
    const data = makeVerdict() as any;
    mutate(data);
    await writeVerdictFile(tmpDir, data);
    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getField(result!) as any).toEqual(expected);
  });

  test("parses verdict with approved=false correctly", async () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 5, failCount: 3 },
      reasoning: "Tests are failing.",
    });
    await writeVerdictFile(tmpDir, verdict);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.approved).toBe(false);
    expect(result?.tests.failCount).toBe(3);
  });

  test("parses verdict with all quality ratings", async () => {
    for (const rating of ["good", "acceptable", "poor"] as const) {
      const verdict = makeVerdict({ quality: { rating, issues: [] } });
      await writeVerdictFile(tmpDir, verdict);

      const result = await readVerdict(tmpDir);
      expect(result).not.toBeNull();
      expect(result?.quality.rating).toBe(rating);
    }
  });
});

// ---------------------------------------------------------------------------
// coerceVerdict
// ---------------------------------------------------------------------------

describe("coerceVerdict", () => {
  test("coerces free-form verdict with 'verdict: PASS'", () => {
    const freeForm = {
      story: "Some story (MA-003)",
      verdict: "PASS",
      timestamp: "2026-03-09T00:00:00Z",
      verification_summary: {
        acceptance_criteria: "4/4 SATISFIED",
        test_results: "45/45 PASS",
        code_quality: "HIGH",
        overall_status: "READY FOR MERGE",
      },
      acceptance_criteria_review: {
        criterion_1: { name: "Implements complete()", status: "SATISFIED", evidence: "line 147" },
        criterion_2: { name: "Handles errors", status: "SATISFIED", evidence: "line 180" },
      },
    };

    const result = coerceVerdict(freeForm);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.approved).toBe(true);
    expect(result?.tests.allPassing).toBe(true);
    expect(result?.tests.passCount).toBe(45);
    expect(result?.tests.failCount).toBe(0);
    expect(result?.acceptanceCriteria.allMet).toBe(true);
    expect(result?.acceptanceCriteria.criteria).toHaveLength(2);
    expect(result?.quality.rating).toBe("good"); // HIGH → good
  });

  test("coerces free-form verdict with 'verdict: FAIL'", () => {
    const freeForm = {
      verdict: "FAIL",
      verification_summary: {
        test_results: "38/45 PASS",
        acceptance_criteria: "3/4 SATISFIED",
        code_quality: "LOW",
      },
    };

    const result = coerceVerdict(freeForm);
    expect(result).not.toBeNull();
    expect(result?.approved).toBe(false);
    expect(result?.tests.passCount).toBe(38);
    expect(result?.tests.failCount).toBe(7);
    expect(result?.tests.allPassing).toBe(false);
    expect(result?.acceptanceCriteria.allMet).toBe(false);
    expect(result?.quality.rating).toBe("poor"); // LOW → poor
  });

  test("preserves partial tests object fields", () => {
    const partial = {
      approved: true,
      tests: { passCount: 10, failCount: 2 },
    };

    const result = coerceVerdict(partial);
    expect(result).not.toBeNull();
    expect(result?.tests.passCount).toBe(10);
    expect(result?.tests.failCount).toBe(2);
  });

  test("provides defaults for completely empty object", () => {
    const result = coerceVerdict({});
    expect(result).not.toBeNull();
    expect(result?.approved).toBe(false);
    expect(result?.tests.passCount).toBe(0);
    expect(result?.tests.failCount).toBe(0);
    expect(result?.testModifications.detected).toBe(false);
    expect(result?.quality.rating).toBe("acceptable");
  });

  test("handles acceptance_criteria_review with UNSATISFIED criteria", () => {
    const freeForm = {
      verdict: "FAIL",
      acceptance_criteria_review: {
        criterion_1: { name: "Must pass", status: "SATISFIED" },
        criterion_2: { name: "Must handle errors", status: "UNSATISFIED" },
      },
    };

    const result = coerceVerdict(freeForm);
    expect(result?.acceptanceCriteria.allMet).toBe(false);
    expect(result?.acceptanceCriteria.criteria[0].met).toBe(true);
    expect(result?.acceptanceCriteria.criteria[1].met).toBe(false);
  });

  // BUG-31: verdict coercion regressions
  test("does not approve 'VERIFIED FAILED' — a contradicted VERIFIED prefix", () => {
    const result = coerceVerdict({
      verdict: "VERIFIED FAILED: 3 tests red",
      verification_summary: { test_results: "3/3 FAIL" },
    });
    expect(result?.approved).toBe(false);
  });

  test("plain 'VERIFIED' with no failure indicator is still approved", () => {
    const result = coerceVerdict({ verdict: "VERIFIED" });
    expect(result?.approved).toBe(true);
  });

  test("does not mistake a date for a pass/fail ratio", () => {
    const result = coerceVerdict({
      verdict: "VERIFIED",
      verification_summary: { test_results: "2024/05/13 ran 5 tests, 5/5 PASS" },
    });
    expect(result?.tests.passCount).toBe(5);
    expect(result?.tests.failCount).toBe(0);
  });

  test("does not parse a ratio when there is no test-count context at all", () => {
    const result = coerceVerdict({
      verdict: "VERIFIED",
      verification_summary: { test_results: "created on 2024/05/13" },
    });
    expect(result?.tests.passCount).toBe(0);
    expect(result?.tests.failCount).toBe(0);
  });

  // Review follow-up: the ratio regex must still recognise the FAIL side of a
  // ratio ("42/45 FAIL"), otherwise a summary contradicting an approving verdict
  // silently reports failCount 0 / allPassing true.
  test("parses a FAIL-side ratio so a contradicting summary is not reported as all-passing", () => {
    const result = coerceVerdict({
      verdict: "VERIFIED",
      verification_summary: { test_results: "42/45 FAIL" },
    });
    expect(result?.tests.passCount).toBe(42);
    expect(result?.tests.failCount).toBe(3);
    expect(result?.tests.allPassing).toBe(false);
  });

  test("'PASSED' is accepted as an approval token", () => {
    expect(coerceVerdict({ verdict: "PASSED" })?.approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleanupVerdict
// ---------------------------------------------------------------------------

describe("cleanupVerdict", () => {
  test("deletes the verdict file when it exists", async () => {
    const verdict = makeVerdict();
    await writeVerdictFile(tmpDir, verdict);

    const filePath = path.join(tmpDir, VERDICT_FILE);
    expect(existsSync(filePath)).toBe(true);

    await cleanupVerdict(tmpDir);
    expect(existsSync(filePath)).toBe(false);
  });

  test.each([
    ["verdict file does not exist", () => cleanupVerdict(tmpDir)],
    ["directory does not exist", () => cleanupVerdict("/tmp/nonexistent-dir-nax-xyz")],
  ])("does not throw when %s", async (_label, fn) => {
    await expect(fn()).resolves.toBeUndefined();
  });

  test("can be called multiple times without error", async () => {
    const verdict = makeVerdict();
    await writeVerdictFile(tmpDir, verdict);

    await cleanupVerdict(tmpDir);
    // Second call — file already deleted
    await expect(cleanupVerdict(tmpDir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// categorizeVerdict
// ---------------------------------------------------------------------------

describe("categorizeVerdict", () => {
  // --- approved=true ---

  test("approved=true → success", () => {
    const verdict = makeVerdict({ approved: true });
    const result = categorizeVerdict(verdict, false);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
  });

  test("approved=true cannot override failing tests", () => {
    const verdict = makeVerdict({
      approved: true,
      tests: { allPassing: false, passCount: 5, failCount: 2 },
    });
    const result = categorizeVerdict(verdict, false);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("tests-failing");
  });

  // --- illegitimate test modifications ---

  test("illegitimate test mods → verifier-rejected", () => {
    const verdict = makeVerdict({
      approved: false,
      testModifications: {
        detected: true,
        files: ["test/foo.test.ts"],
        legitimate: false,
        reasoning: "Implementer loosened assertions to mask bugs",
      },
    });
    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("illegitimate test modifications");
    expect(result.reviewReason).toContain("test/foo.test.ts");
    expect(result.reviewReason).toContain("Implementer loosened assertions");
  });

  test("detected test mods but legitimate → does NOT categorize as verifier-rejected for that reason", () => {
    const verdict = makeVerdict({
      approved: false,
      testModifications: {
        detected: true,
        files: ["test/foo.test.ts"],
        legitimate: true, // Legitimate — should not trigger verifier-rejected for this reason
        reasoning: "Fixed incorrect test expectations",
      },
      tests: { allPassing: false, passCount: 3, failCount: 2 },
    });
    const result = categorizeVerdict(verdict, false);
    // Falls through to next reason: tests failing
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("tests-failing");
  });

  // --- tests failing ---

  test("tests failing → tests-failing", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 4, failCount: 3 },
      reasoning: "Some tests are still failing.",
    });
    const result = categorizeVerdict(verdict, false);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("tests-failing");
    expect(result.reviewReason).toContain("3 failure(s)");
  });

  test("structured incorrect-test diagnosis pauses source rectification", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 8, failCount: 1 },
      testFailureDiagnosis: {
        cause: "test-incorrect",
        assertions: [
          {
            file: "test/unit/foo.test.ts",
            testName: "injects the required failure note",
            reasoning: "The assertion omits the note required by AC7.",
          },
        ],
      },
    });

    const result = categorizeVerdict(verdict, false);

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("test-incorrect");
    expect(result.reviewReason).toContain("test/unit/foo.test.ts");
    expect(result.reviewReason).toContain("human review");
  });

  test("incorrect-test diagnosis requires concrete assertions", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 8, failCount: 1 },
      testFailureDiagnosis: { cause: "test-incorrect", assertions: [] },
    });

    expect(categorizeVerdict(verdict, false).failureCategory).toBe("tests-failing");
  });

  test("incorrect-test diagnosis is inadmissible when the implementer modified tests", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 8, failCount: 1 },
      testModifications: {
        detected: true,
        files: ["test/unit/foo.test.ts"],
        legitimate: true,
        reasoning: "Implementer changed the assertion.",
      },
      testFailureDiagnosis: {
        cause: "test-incorrect",
        assertions: [{ file: "test/unit/foo.test.ts", reasoning: "Assertion is wrong." }],
      },
    });

    expect(categorizeVerdict(verdict, false).failureCategory).toBe("tests-failing");
  });

  test("incorrect-test diagnosis is inadmissible when acceptance criteria are unmet", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 8, failCount: 1 },
      acceptanceCriteria: { allMet: false, criteria: [{ criterion: "AC7", met: false }] },
      testFailureDiagnosis: {
        cause: "test-incorrect",
        assertions: [{ file: "test/unit/foo.test.ts", reasoning: "Assertion is wrong." }],
      },
    });

    expect(categorizeVerdict(verdict, false).failureCategory).toBe("tests-failing");
  });

  // --- advisory acceptance criteria / quality ---

  test("acceptance criteria not met only → advisory success", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: true, passCount: 10, failCount: 0 },
      acceptanceCriteria: {
        allMet: false,
        criteria: [
          { criterion: "Must validate input", met: false, note: "No validation" },
          { criterion: "Must return 200", met: true },
        ],
      },
    });
    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
    expect(result.reviewReason).toBeUndefined();
  });

  test("poor quality only → advisory success", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: true, passCount: 10, failCount: 0 },
      acceptanceCriteria: {
        allMet: true,
        criteria: [{ criterion: "Works", met: true }],
      },
      quality: {
        rating: "poor",
        issues: ["SQL injection vulnerability", "No error handling"],
      },
    });
    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
    expect(result.reviewReason).toBeUndefined();
  });

  test("acceptable quality → does not trigger poor-quality rejection", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: true, passCount: 10, failCount: 0 },
      acceptanceCriteria: {
        allMet: true,
        criteria: [{ criterion: "Works", met: true }],
      },
      quality: {
        rating: "acceptable",
        issues: ["Minor style issues"],
      },
      reasoning: "Overall acceptable but not approved for other reason",
    });
    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
  });

  // --- catch-all: not approved without TDD integrity failure ---

  test("not approved with no TDD integrity failure → advisory success", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: true, passCount: 10, failCount: 0 },
      testModifications: { detected: false, files: [], legitimate: true, reasoning: "None" },
      acceptanceCriteria: { allMet: true, criteria: [{ criterion: "Works", met: true }] },
      quality: { rating: "good", issues: [] },
      reasoning: "Something else is wrong.",
    });
    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
    expect(result.reviewReason).toBeUndefined();
  });

  // --- null verdict fallback ---

  test.each<[boolean, boolean, string | undefined]>([
    [true, true, undefined],
    [false, false, "tests-failing"],
  ])("null verdict + testsPass=%s → success=%s", (testsPass, expectedSuccess, expectedCategory) => {
    const result = categorizeVerdict(null, testsPass);
    expect(result.success).toBe(expectedSuccess);
    if (expectedCategory) expect(result.failureCategory).toBe(expectedCategory as any);
    else expect(result.failureCategory).toBeUndefined();
  });

  // --- priority ordering ---

  test("illegitimate test mods take priority over failing tests", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 2, failCount: 5 },
      testModifications: {
        detected: true,
        files: ["test/bar.test.ts"],
        legitimate: false,
        reasoning: "Cheated",
      },
    });
    const result = categorizeVerdict(verdict, false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("illegitimate test modifications");
  });

  test("failing tests still block when acceptance criteria are also unmet", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 1, failCount: 2 },
      testModifications: {
        detected: false,
        files: [],
        legitimate: true,
        reasoning: "None",
      },
      acceptanceCriteria: {
        allMet: false,
        criteria: [{ criterion: "Unmet", met: false }],
      },
    });
    const result = categorizeVerdict(verdict, false);
    expect(result.failureCategory).toBe("tests-failing");
  });

  test("acceptance criteria plus poor quality without TDD integrity failure → advisory success", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: true, passCount: 10, failCount: 0 },
      testModifications: {
        detected: false,
        files: [],
        legitimate: true,
        reasoning: "None",
      },
      acceptanceCriteria: {
        allMet: false,
        criteria: [{ criterion: "Criterion A", met: false }],
      },
      quality: { rating: "poor", issues: ["Very bad"] },
    });
    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
    expect(result.reviewReason).toBeUndefined();
  });
});
