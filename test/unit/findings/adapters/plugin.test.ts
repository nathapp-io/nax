import { describe, expect, test } from "bun:test";
import type { ReviewFinding } from "../../../../src/plugins/types";
import { pluginToFinding } from "../../../../src/findings";

const WORKDIR = "/repo";

const baseReviewFinding: ReviewFinding = {
  ruleId: "no-unused-vars",
  severity: "error",
  file: "src/foo.ts",
  line: 10,
  message: "Variable is unused",
};

describe("pluginToFinding", () => {
  test("maps required fields", () => {
    const finding = pluginToFinding(baseReviewFinding, WORKDIR);

    expect(finding.source).toBe("plugin");
    expect(finding.severity).toBe("error");
    expect(finding.category).toBe("general");
    expect(finding.rule).toBe("no-unused-vars");
    expect(finding.file).toBe("src/foo.ts");
    expect(finding.line).toBe(10);
    expect(finding.message).toBe("Variable is unused");
  });

  test("defaults tool to 'plugin' when source is absent", () => {
    const finding = pluginToFinding(baseReviewFinding, WORKDIR);
    expect(finding.tool).toBe("plugin");
  });

  test("uses rf.source as tool when present", () => {
    const rf: ReviewFinding = { ...baseReviewFinding, source: "semgrep" };
    const finding = pluginToFinding(rf, WORKDIR);
    expect(finding.tool).toBe("semgrep");
  });

  test("passes through all severity levels without change", () => {
    const severities = ["critical", "error", "warning", "info", "low"] as const;
    for (const severity of severities) {
      const finding = pluginToFinding({ ...baseReviewFinding, severity }, WORKDIR);
      expect(finding.severity).toBe(severity);
    }
  });

  test("uses rf.category when present", () => {
    const rf: ReviewFinding = { ...baseReviewFinding, category: "security" };
    const finding = pluginToFinding(rf, WORKDIR);
    expect(finding.category).toBe("security");
  });

  test("defaults category to 'general' when absent", () => {
    const finding = pluginToFinding(baseReviewFinding, WORKDIR);
    expect(finding.category).toBe("general");
  });

  test("passes through column, endLine, endColumn when present", () => {
    const rf: ReviewFinding = { ...baseReviewFinding, column: 5, endLine: 12, endColumn: 8 };
    const finding = pluginToFinding(rf, WORKDIR);
    expect(finding.column).toBe(5);
    expect(finding.endLine).toBe(12);
    expect(finding.endColumn).toBe(8);
  });

  test("omits column, endLine, endColumn when absent", () => {
    const finding = pluginToFinding(baseReviewFinding, WORKDIR);
    expect(finding.column).toBeUndefined();
    expect(finding.endLine).toBeUndefined();
    expect(finding.endColumn).toBeUndefined();
  });

  test("stores url in meta when present", () => {
    const rf: ReviewFinding = { ...baseReviewFinding, url: "https://eslint.org/rules/no-unused-vars" };
    const finding = pluginToFinding(rf, WORKDIR);
    expect(finding.meta).toEqual({ url: "https://eslint.org/rules/no-unused-vars" });
  });

  test("omits meta when url is absent", () => {
    const finding = pluginToFinding(baseReviewFinding, WORKDIR);
    expect(finding.meta).toBeUndefined();
  });

  test("workdir parameter is accepted but file path is not rebased (already workdir-relative)", () => {
    const rf: ReviewFinding = { ...baseReviewFinding, file: "src/nested/bar.ts" };
    const finding = pluginToFinding(rf, "/different/workdir");
    expect(finding.file).toBe("src/nested/bar.ts");
  });
});
