import { describe, expect, test } from "bun:test";
import {
  acceptanceDiagnoseRawArrayToFindings,
  acceptanceDiagnoseRawToFinding,
} from "../../../../src/findings";

describe("acceptanceDiagnoseRawToFinding", () => {
  test("maps well-formed minimal record with default severity", () => {
    const finding = acceptanceDiagnoseRawToFinding({
      message: "wrong output stream",
      category: "stdout-capture",
    });

    expect(finding).toMatchObject({
      source: "acceptance-diagnose",
      severity: "error",
      category: "stdout-capture",
      message: "wrong output stream",
    });
  });

  test("preserves optional fields when well-typed", () => {
    const finding = acceptanceDiagnoseRawToFinding({
      message: "bad import",
      category: "import-path",
      severity: "warning",
      fixTarget: "test",
      file: "test/foo.test.ts",
      line: 12,
      suggestion: "fix path",
    });

    expect(finding).toMatchObject({
      source: "acceptance-diagnose",
      severity: "warning",
      fixTarget: "test",
      file: "test/foo.test.ts",
      line: 12,
      suggestion: "fix path",
      category: "import-path",
      message: "bad import",
    });
  });

  test("returns null when message is missing", () => {
    const finding = acceptanceDiagnoseRawToFinding({ category: "stdout-capture" });
    expect(finding).toBeNull();
  });

  test("returns null when category is missing", () => {
    const finding = acceptanceDiagnoseRawToFinding({ message: "x" });
    expect(finding).toBeNull();
  });

  test("returns null for wrong required field types", () => {
    const finding = acceptanceDiagnoseRawToFinding({ message: 1, category: 2 });
    expect(finding).toBeNull();
  });

  test("defaults severity to error when severity is non-string", () => {
    const finding = acceptanceDiagnoseRawToFinding({
      message: "x",
      category: "other",
      severity: 42,
    });

    expect(finding?.severity).toBe("error");
  });

  test("passes through unknown fixTarget string", () => {
    const finding = acceptanceDiagnoseRawToFinding({
      message: "x",
      category: "other",
      fixTarget: "weird",
    });

    expect(finding?.fixTarget).toBe("weird");
  });
});

describe("acceptanceDiagnoseRawArrayToFindings", () => {
  test("returns [] for non-array input", () => {
    expect(acceptanceDiagnoseRawArrayToFindings("not an array")).toEqual([]);
    expect(acceptanceDiagnoseRawArrayToFindings(null)).toEqual([]);
    expect(acceptanceDiagnoseRawArrayToFindings(undefined)).toEqual([]);
    expect(acceptanceDiagnoseRawArrayToFindings({})).toEqual([]);
  });

  test("returns [] for empty array", () => {
    expect(acceptanceDiagnoseRawArrayToFindings([])).toEqual([]);
  });

  test("drops malformed records and keeps valid ones", () => {
    const findings = acceptanceDiagnoseRawArrayToFindings([
      { message: "valid", category: "ac-mismatch" },
      { message: "missing category" },
      { category: "missing message" },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: "acceptance-diagnose",
      message: "valid",
      category: "ac-mismatch",
    });
  });
});