import { describe, expect, test } from "bun:test";
import { tscDiagnosticToFinding } from "../../../../src/findings";
import type { TypecheckDiagnostic } from "../../../../src/review/typecheck-parsing";

const WORKDIR = "/repo";

const baseDiagnostic: TypecheckDiagnostic = {
  file: "src/foo.ts",
  line: 42,
  column: 10,
  code: "2304",
  message: "Cannot find name 'Foo'.",
  raw: "src/foo.ts(42,10): error TS2304: Cannot find name 'Foo'.",
};

describe("tscDiagnosticToFinding", () => {
  test("maps required fields", () => {
    const finding = tscDiagnosticToFinding(baseDiagnostic, WORKDIR);

    expect(finding.source).toBe("typecheck");
    expect(finding.tool).toBe("tsc");
    expect(finding.severity).toBe("error");
    expect(finding.category).toBe("type-error");
    expect(finding.rule).toBe("TS2304");
    expect(finding.file).toBe("src/foo.ts");
    expect(finding.line).toBe(42);
    expect(finding.column).toBe(10);
    expect(finding.message).toBe("Cannot find name 'Foo'.");
  });

  test("severity is always 'error'", () => {
    const finding = tscDiagnosticToFinding(baseDiagnostic, WORKDIR);
    expect(finding.severity).toBe("error");
  });

  test("formats code as TS-prefixed rule", () => {
    const finding = tscDiagnosticToFinding(baseDiagnostic, WORKDIR);
    expect(finding.rule).toBe("TS2304");
  });

  test("omits rule when code is undefined", () => {
    const d: TypecheckDiagnostic = { ...baseDiagnostic, code: undefined };
    const finding = tscDiagnosticToFinding(d, WORKDIR);
    expect(finding.rule).toBeUndefined();
  });

  test("omits column when absent", () => {
    const d: TypecheckDiagnostic = { ...baseDiagnostic, column: undefined };
    const finding = tscDiagnosticToFinding(d, WORKDIR);
    expect(finding.column).toBeUndefined();
  });

  test("omits line when absent", () => {
    const d: TypecheckDiagnostic = { ...baseDiagnostic, line: undefined };
    const finding = tscDiagnosticToFinding(d, WORKDIR);
    expect(finding.line).toBeUndefined();
  });

  test("preserves workdir-relative file path unchanged", () => {
    const d: TypecheckDiagnostic = { ...baseDiagnostic, file: "src/nested/bar.ts" };
    const finding = tscDiagnosticToFinding(d, "/repo");
    expect(finding.file).toBe("src/nested/bar.ts");
  });

  test("rebases absolute file path to workdir-relative", () => {
    const d: TypecheckDiagnostic = { ...baseDiagnostic, file: "/repo/src/absolute.ts" };
    const finding = tscDiagnosticToFinding(d, "/repo");
    expect(finding.file).toBe("src/absolute.ts");
  });

  test("fixTarget is always undefined — derived by cycle layer", () => {
    const finding = tscDiagnosticToFinding(baseDiagnostic, WORKDIR);
    expect(finding.fixTarget).toBeUndefined();
  });

  test("suggestion is always undefined — TypecheckDiagnostic has no fix field", () => {
    const finding = tscDiagnosticToFinding(baseDiagnostic, WORKDIR);
    expect(finding.suggestion).toBeUndefined();
  });
});
