/**
 * findingsToFailedChecks — unit tests (AC2.1, AC2.2)
 */
import { describe, expect, test } from "bun:test";
import { findingsToFailedChecks } from "@/operations";
import type { Finding } from "@/findings/types";

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
    const checks = result.map((r) => r.check).sort();
    expect(checks).toEqual(["adversarial", "semantic"]);
  });

  test("AC2.2: lint + typecheck findings → 2 entries", () => {
    const result = findingsToFailedChecks([LINT_FINDING, TYPECHECK_FINDING]);
    expect(result).toHaveLength(2);
    const checks = result.map((r) => r.check).sort();
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
