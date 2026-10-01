/**
 * findingsToFailedChecks — unit tests (AC2.1, AC2.2)
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined } from "@test/helpers";
import type { Finding } from "@/findings/types";
import { findingsToFailedChecks } from "@/operations";
import { byCodePoint } from "@/utils/sort";

const SEMANTIC_FINDING: Finding = {
  source: "semantic-review",
  severity: "error",
  category: "",
  message: "Does not implement AC-001",
  file: "src/foo.ts",
  line: 10,
};

const ADVERSARIAL_FINDING: Finding = {
  source: "adversarial-review",
  severity: "error",
  category: "",
  message: "Test coverage gap",
  file: "test/foo.test.ts",
  line: 5,
};

const LINT_FINDING: Finding = {
  source: "lint",
  severity: "error",
  category: "",
  message: "Unused variable",
  file: "src/bar.ts",
  line: 3,
};

const TYPECHECK_FINDING: Finding = {
  source: "typecheck",
  severity: "error",
  category: "",
  message: "Type mismatch",
  file: "src/baz.ts",
  line: 7,
};

const TEST_RUNNER_FINDING: Finding = {
  source: "test-runner",
  severity: "error",
  category: "",
  message: "Test failed",
  file: "test/baz.test.ts",
  line: 1,
};

describe("findingsToFailedChecks", () => {
  test("AC2.1: single semantic finding → one entry with check='semantic'", () => {
    const result = findingsToFailedChecks([SEMANTIC_FINDING]);
    expect(result).toHaveLength(1);
    expect(result[0]?.check).toBe("semantic");
    expect(result[0]?.success).toBe(false);
    expect(result[0]?.findings).toEqual([SEMANTIC_FINDING]);
  });

  test("AC2.2: mixed semantic + adversarial → 2 entries, one per source", () => {
    const result = findingsToFailedChecks([SEMANTIC_FINDING, ADVERSARIAL_FINDING]);
    expect(result).toHaveLength(2);
    const checks = result.map((r) => r.check).sort(byCodePoint);
    expect(checks).toEqual(["adversarial", "semantic"]);
  });

  test("AC2.2: lint + typecheck findings → 2 entries", () => {
    const result = findingsToFailedChecks([LINT_FINDING, TYPECHECK_FINDING]);
    expect(result).toHaveLength(2);
    const checks = result.map((r) => r.check).sort(byCodePoint);
    expect(checks).toEqual(["lint", "typecheck"]);
  });

  test("AC2.2: same source × 2 findings → 1 entry with both in findings[]", () => {
    const finding2: Finding = { ...SEMANTIC_FINDING, message: "AC-002 gap" };
    const result = findingsToFailedChecks([SEMANTIC_FINDING, finding2]);
    expect(result).toHaveLength(1);
    expect(result[0]?.findings).toHaveLength(2);
  });

  test("unmapped source (test-runner) is dropped", () => {
    const result = findingsToFailedChecks([TEST_RUNNER_FINDING]);
    expect(result).toHaveLength(0);
  });

  test("empty input → empty output", () => {
    const result = findingsToFailedChecks([]);
    expect(result).toHaveLength(0);
  });
});

/**
 * AC5: SOURCE_TO_CHECK maps "tdd-verifier" → "test"
 *
 * Verifies that:
 * - findingsToFailedChecks groups a tdd-verifier finding under check "test"
 * - The source file contains the canonical "tdd-verifier": "test" line
 */
const BASE = join(import.meta.dir, "../../../src/operations");

const TDD_VERIFIER_FINDING: Finding = {
  source: "tdd-verifier",
  severity: "error",
  category: "tests-failed",
  message: "3 story-scoped test(s) failed (verifier)",
  fixTarget: "source",
};

describe("AC5: SOURCE_TO_CHECK maps tdd-verifier to test check", () => {
  test("AC5: findingsToFailedChecks maps tdd-verifier finding to check 'test'", async () => {
    const results = findingsToFailedChecks([TDD_VERIFIER_FINDING]);

    expect(results.length).toBe(1);
    expect(results[0].check).toBe("test");
  });

  test("AC5: grouped check has success=false", async () => {
    const results = findingsToFailedChecks([TDD_VERIFIER_FINDING]);

    // Guard: fails assertively if tdd-verifier not mapped in SOURCE_TO_CHECK
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].success).toBe(false);
  });

  test("AC5: grouped check findings contains the tdd-verifier finding", async () => {
    const results = findingsToFailedChecks([TDD_VERIFIER_FINDING]);

    // Guard: fails assertively if tdd-verifier not mapped in SOURCE_TO_CHECK
    expect(results.length).toBeGreaterThan(0);
    const groupedFindings = results[0].findings;
    assertDefined(groupedFindings, "results[0].findings");
    expect(groupedFindings.length).toBe(1);
    expect(groupedFindings[0].source).toBe("tdd-verifier");
  });

  test("AC5: source file contains exactly one tdd-verifier: test line in SOURCE_TO_CHECK", async () => {
    const file = Bun.file(join(BASE, "_finding-to-check.ts"));
    const content = await file.text();
    const matches = content.split("\n").filter((line) => /^\s*"tdd-verifier": "test",\s*$/.test(line));
    expect(matches.length).toBe(1);
  });
});
