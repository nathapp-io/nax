import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

beforeEach(async () => {
  tmpDir = await Bun.file(os.tmpdir())
    .exists()
    .then(() => `${os.tmpdir()}/nax-verdict-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
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
    expect(result!.version).toBe(1);
    expect(result!.approved).toBe(true);
    expect(result!.tests.allPassing).toBe(true);
    expect(result!.tests.passCount).toBe(10);
    expect(result!.tests.failCount).toBe(0);
    expect(result!.reasoning).toBe("All good.");
  });

  test("returns null when verdict file does not exist (no throw)", async () => {
    // No file written — directory is empty
    const result = await readVerdict(tmpDir);
    expect(result).toBeNull();
  });

  test("returns null when verdict file does not exist for non-existent dir", async () => {
    const result = await readVerdict("/tmp/this-dir-does-not-exist-xyz-nax");
    expect(result).toBeNull();
  });

  test("returns null when JSON is malformed (no throw)", async () => {
    const filePath = path.join(tmpDir, VERDICT_FILE);
    await writeFile(filePath, "{ this is not valid json }", "utf-8");

    const result = await readVerdict(tmpDir);
    expect(result).toBeNull();
  });

  test("returns null when JSON is truncated (no throw)", async () => {
    const filePath = path.join(tmpDir, VERDICT_FILE);
    await writeFile(filePath, '{"version": 1, "approved": true, "tests":', "utf-8");

    const result = await readVerdict(tmpDir);
    expect(result).toBeNull();
  });

  test("coerces when version field is missing", async () => {
    const { version: _v, ...noVersion } = makeVerdict() as any;
    await writeVerdictFile(tmpDir, noVersion);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1); // coerced
    expect(result!.approved).toBe(true);
  });

  test("coerces when approved field is missing (defaults to false)", async () => {
    const data = makeVerdict() as any;
    delete data.approved;
    await writeVerdictFile(tmpDir, data);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.approved).toBe(false); // no verdict/approved → defaults false
  });

  test("coerces when tests field is missing", async () => {
    const data = makeVerdict() as any;
    delete data.tests;
    await writeVerdictFile(tmpDir, data);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tests.passCount).toBe(0);
  });

  test("coerces when tests.allPassing is missing", async () => {
    const data = makeVerdict() as any;
    delete data.tests.allPassing;
    await writeVerdictFile(tmpDir, data);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tests.passCount).toBe(10); // from partial tests object
  });

  test("coerces when testModifications field is missing", async () => {
    const data = makeVerdict() as any;
    delete data.testModifications;
    await writeVerdictFile(tmpDir, data);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.testModifications.detected).toBe(false);
  });

  test("coerces when acceptanceCriteria field is missing", async () => {
    const data = makeVerdict() as any;
    delete data.acceptanceCriteria;
    await writeVerdictFile(tmpDir, data);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.acceptanceCriteria.criteria).toEqual([]);
  });

  test("coerces when quality field is missing", async () => {
    const data = makeVerdict() as any;
    delete data.quality;
    await writeVerdictFile(tmpDir, data);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.quality.rating).toBe("acceptable"); // default
  });

  test("coerces when quality.rating is invalid", async () => {
    const data = makeVerdict() as any;
    data.quality.rating = "excellent"; // Not a valid rating
    await writeVerdictFile(tmpDir, data);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.quality.rating).toBe("acceptable"); // coerced to default
  });

  test("coerces when fixes is missing", async () => {
    const data = makeVerdict() as any;
    delete data.fixes;
    await writeVerdictFile(tmpDir, data);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.fixes).toEqual([]);
  });

  test("coerces when reasoning is missing", async () => {
    const data = makeVerdict() as any;
    delete data.reasoning;
    await writeVerdictFile(tmpDir, data);

    const result = await readVerdict(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
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
    expect(result!.approved).toBe(false);
    expect(result!.tests.failCount).toBe(3);
  });

  test("parses verdict with all quality ratings", async () => {
    for (const rating of ["good", "acceptable", "poor"] as const) {
      const verdict = makeVerdict({ quality: { rating, issues: [] } });
      await writeVerdictFile(tmpDir, verdict);

      const result = await readVerdict(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.quality.rating).toBe(rating);
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
    expect(result!.version).toBe(1);
    expect(result!.approved).toBe(true);
    expect(result!.tests.allPassing).toBe(true);
    expect(result!.tests.passCount).toBe(45);
    expect(result!.tests.failCount).toBe(0);
    expect(result!.acceptanceCriteria.allMet).toBe(true);
    expect(result!.acceptanceCriteria.criteria).toHaveLength(2);
    expect(result!.quality.rating).toBe("good"); // HIGH → good
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
    expect(result!.approved).toBe(false);
    expect(result!.tests.passCount).toBe(38);
    expect(result!.tests.failCount).toBe(7);
    expect(result!.tests.allPassing).toBe(false);
    expect(result!.acceptanceCriteria.allMet).toBe(false);
    expect(result!.quality.rating).toBe("poor"); // LOW → poor
  });

  test("preserves partial tests object fields", () => {
    const partial = {
      approved: true,
      tests: { passCount: 10, failCount: 2 },
    };

    const result = coerceVerdict(partial);
    expect(result).not.toBeNull();
    expect(result!.tests.passCount).toBe(10);
    expect(result!.tests.failCount).toBe(2);
  });

  test("provides defaults for completely empty object", () => {
    const result = coerceVerdict({});
    expect(result).not.toBeNull();
    expect(result!.approved).toBe(false);
    expect(result!.tests.passCount).toBe(0);
    expect(result!.tests.failCount).toBe(0);
    expect(result!.testModifications.detected).toBe(false);
    expect(result!.quality.rating).toBe("acceptable");
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
    expect(result!.acceptanceCriteria.allMet).toBe(false);
    expect(result!.acceptanceCriteria.criteria[0].met).toBe(true);
    expect(result!.acceptanceCriteria.criteria[1].met).toBe(false);
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

  test("does not throw when verdict file does not exist", async () => {
    // File doesn't exist — should not throw
    await expect(cleanupVerdict(tmpDir)).resolves.toBeUndefined();
  });

  test("does not throw when directory does not exist", async () => {
    // Non-existent directory — should not throw
    await expect(cleanupVerdict("/tmp/nonexistent-dir-nax-xyz")).resolves.toBeUndefined();
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

  test("approved=true with failing tests still → success (verifier approved)", () => {
    // Verifier takes precedence — if it says approved, we trust it
    const verdict = makeVerdict({
      approved: true,
      tests: { allPassing: false, passCount: 5, failCount: 2 },
    });
    const result = categorizeVerdict(verdict, false);
    expect(result.success).toBe(true);
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

  // --- acceptance criteria not met ---

  test("acceptance criteria not met → verifier-rejected", () => {
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
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("Must validate input");
  });

  // --- poor quality ---

  test("poor quality → verifier-rejected", () => {
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
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("SQL injection vulnerability");
    expect(result.reviewReason).toContain("No error handling");
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
    // Falls to catch-all
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
  });

  // --- catch-all: not approved without specific categorizable reason ---

  test("not approved with no specific categorizable reason → verifier-rejected (catch-all)", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: true, passCount: 10, failCount: 0 },
      testModifications: { detected: false, files: [], legitimate: true, reasoning: "None" },
      acceptanceCriteria: { allMet: true, criteria: [{ criterion: "Works", met: true }] },
      quality: { rating: "good", issues: [] },
      reasoning: "Something else is wrong.",
    });
    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("Something else is wrong.");
  });

  // --- null verdict fallback ---

  test("null verdict + testsPass=true → success", () => {
    const result = categorizeVerdict(null, true);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
  });

  test("null verdict + testsPass=false → tests-failing", () => {
    const result = categorizeVerdict(null, false);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("tests-failing");
    expect(result.reviewReason).toContain("no verdict file");
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

  test("failing tests take priority over acceptance criteria", () => {
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

  test("acceptance criteria not met takes priority over poor quality", () => {
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
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("Criterion A");
  });
});
