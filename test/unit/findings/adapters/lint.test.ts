import { describe, expect, test } from "bun:test";
import { lintDiagnosticToFinding } from "../../../../src/findings";
import type { LintDiagnostic } from "../../../../src/review/lint-parsing";

const WORKDIR = "/repo";
const CWD = "/repo";

const baseDiagnostic: LintDiagnostic = {
  file: "src/foo.ts",
  line: 10,
  column: 5,
  severity: "error",
  ruleId: "lint/suspicious/noDoubleEquals",
  message: "Use === instead of ==",
  raw: "src/foo.ts:10:5 error lint/suspicious/noDoubleEquals Use === instead of ==",
};

describe("lintDiagnosticToFinding", () => {
  test("maps required fields — biome tool", () => {
    const finding = lintDiagnosticToFinding(baseDiagnostic, WORKDIR, CWD, "biome");

    expect(finding.source).toBe("lint");
    expect(finding.tool).toBe("biome");
    expect(finding.severity).toBe("error");
    expect(finding.category).toBe("lint");
    expect(finding.rule).toBe("lint/suspicious/noDoubleEquals");
    expect(finding.file).toBe("src/foo.ts");
    expect(finding.line).toBe(10);
    expect(finding.column).toBe(5);
    expect(finding.message).toBe("Use === instead of ==");
  });

  test("maps eslint tool", () => {
    const finding = lintDiagnosticToFinding(baseDiagnostic, WORKDIR, CWD, "eslint");
    expect(finding.tool).toBe("eslint");
    expect(finding.source).toBe("lint");
  });

  test("maps text tool", () => {
    const finding = lintDiagnosticToFinding(baseDiagnostic, WORKDIR, CWD, "text");
    expect(finding.tool).toBe("text");
  });

  test("defaults severity to 'warning' when diagnostic severity is undefined", () => {
    const d: LintDiagnostic = { ...baseDiagnostic, severity: undefined };
    const finding = lintDiagnosticToFinding(d, WORKDIR, CWD, "biome");
    expect(finding.severity).toBe("warning");
  });

  test.each([
    ["error" as const],
    ["warning" as const],
    ["info" as const],
  ])("passes through severity '%s'", (severity) => {
    const d: LintDiagnostic = { ...baseDiagnostic, severity };
    const finding = lintDiagnosticToFinding(d, WORKDIR, CWD, "biome");
    expect(finding.severity).toBe(severity);
  });

  test("omits column when absent", () => {
    const d: LintDiagnostic = { ...baseDiagnostic, column: undefined };
    const finding = lintDiagnosticToFinding(d, WORKDIR, CWD, "biome");
    expect(finding.column).toBeUndefined();
  });

  test("omits ruleId / rule when absent", () => {
    const d: LintDiagnostic = { ...baseDiagnostic, ruleId: undefined };
    const finding = lintDiagnosticToFinding(d, WORKDIR, CWD, "biome");
    expect(finding.rule).toBeUndefined();
  });

  test("rebases cwd-relative file path to workdir-relative", () => {
    const d: LintDiagnostic = { ...baseDiagnostic, file: "src/nested/bar.ts" };
    const finding = lintDiagnosticToFinding(d, "/repo", "/repo", "biome");
    expect(finding.file).toBe("src/nested/bar.ts");
  });

  test("rebases absolute file path to workdir-relative", () => {
    const d: LintDiagnostic = { ...baseDiagnostic, file: "/repo/src/absolute.ts" };
    const finding = lintDiagnosticToFinding(d, "/repo", "/repo", "biome");
    expect(finding.file).toBe("src/absolute.ts");
  });

  test("rebases file when cwd differs from workdir", () => {
    // lint ran in /repo/packages/lib, workdir is /repo
    const d: LintDiagnostic = { ...baseDiagnostic, file: "src/util.ts" };
    const finding = lintDiagnosticToFinding(d, "/repo", "/repo/packages/lib", "biome");
    expect(finding.file).toBe("packages/lib/src/util.ts");
  });

  test("fixTarget is always undefined — derived by cycle layer", () => {
    const finding = lintDiagnosticToFinding(baseDiagnostic, WORKDIR, CWD, "biome");
    expect(finding.fixTarget).toBeUndefined();
  });

  test("suggestion is always undefined — LintDiagnostic has no fix field", () => {
    const finding = lintDiagnosticToFinding(baseDiagnostic, WORKDIR, CWD, "biome");
    expect(finding.suggestion).toBeUndefined();
  });
});
