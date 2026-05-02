import { describe, expect, test } from "bun:test";
import { llmReviewFindingToFinding } from "../../../../src/findings";

describe("llmReviewFindingToFinding", () => {
  test("maps required fields", () => {
    const f = llmReviewFindingToFinding({ severity: "error", file: "src/foo.ts", issue: "null dereference" }, "/repo");
    expect(f.source).toBe("adversarial-review");
    expect(f.severity).toBe("error");
    expect(f.message).toBe("null dereference");
    expect(f.file).toBe("src/foo.ts");
    expect(f.category).toBe("");
  });

  test("maps optional fields when present", () => {
    const f = llmReviewFindingToFinding(
      {
        severity: "warning",
        file: "src/bar.ts",
        issue: "incomplete error handling",
        suggestion: "add catch block",
        category: "error-path",
        line: 42,
      },
      "/repo",
    );
    expect(f.line).toBe(42);
    expect(f.suggestion).toBe("add catch block");
    expect(f.category).toBe("error-path");
    expect(f.severity).toBe("warning");
  });

  test("normalizes legacy 'warn' severity to 'warning'", () => {
    const f = llmReviewFindingToFinding({ severity: "warn", file: "src/foo.ts", issue: "fragile pattern" }, "/repo");
    expect(f.severity).toBe("warning");
  });

  test("passes through 'unverifiable' severity", () => {
    const f = llmReviewFindingToFinding(
      { severity: "unverifiable", file: "src/foo.ts", issue: "suspect pattern" },
      "/repo",
    );
    expect(f.severity).toBe("unverifiable");
  });

  test("defaults unknown severity to 'info'", () => {
    const f = llmReviewFindingToFinding({ severity: "unknown", file: "src/foo.ts", issue: "something" }, "/repo");
    expect(f.severity).toBe("info");
  });

  test("rebases absolute path to workdir-relative", () => {
    const f = llmReviewFindingToFinding({ severity: "error", file: "/repo/src/foo.ts", issue: "issue" }, "/repo");
    expect(f.file).toBe("src/foo.ts");
  });

  test("passes through 'critical' severity", () => {
    const f = llmReviewFindingToFinding({ severity: "critical", file: "src/foo.ts", issue: "crash" }, "/repo");
    expect(f.severity).toBe("critical");
  });
});
