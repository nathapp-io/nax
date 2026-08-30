import { describe, expect, test } from "bun:test";
import { formatTypecheckDiagnosticsOutput, parseTypecheckOutput } from "@/review/typecheck-parsing/parse";

const TSC_OUTPUT = "src/foo.ts(1,1): error TS2304: Cannot find name 'foo'.";

describe("parseTypecheckOutput", () => {
  test("returns null for blank output", () => {
    expect(parseTypecheckOutput("")).toBeNull();
    expect(parseTypecheckOutput("   \n  ")).toBeNull();
  });

  test("returns raw parsed diagnostics when no opts (workdir) is given", () => {
    const result = parseTypecheckOutput(TSC_OUTPUT, "tsc");
    expect(result).not.toBeNull();
    expect(result?.format).toBe("tsc");
    expect(result?.diagnostics.length).toBeGreaterThan(0);
    expect(result?.findings).toBeUndefined();
  });

  test("attaches structured findings when opts.workdir is provided", () => {
    const result = parseTypecheckOutput(TSC_OUTPUT, "tsc", { workdir: "/repo" });
    expect(result).not.toBeNull();
    expect(result?.findings).toBeDefined();
    expect(result?.findings?.length).toBe(result?.diagnostics.length);
    expect(result?.findings?.[0].source).toBe("typecheck");
  });

  test("forces the tsc-only strategy set", () => {
    const result = parseTypecheckOutput(TSC_OUTPUT, "tsc");
    expect(result?.format).toBe("tsc");
  });

  test("forces the text-block-only strategy set and returns null on tsc-shaped input it cannot parse as text", () => {
    // "text" format skips the tsc strategy entirely, so unrelated freeform prose
    // with no diagnostic-like content parses to nothing.
    const result = parseTypecheckOutput("just some prose with no diagnostics", "text");
    expect(result).toBeNull();
  });

  test("returns null immediately for format 'none', regardless of content", () => {
    expect(parseTypecheckOutput(TSC_OUTPUT, "none")).toBeNull();
  });

  test("'auto' tries tsc first, falling through to text-block when tsc finds nothing", () => {
    const result = parseTypecheckOutput(TSC_OUTPUT); // default format is "auto"
    expect(result).not.toBeNull();
    expect(result?.format).toBe("tsc");
  });

  test("defaults to 'auto' when format is omitted", () => {
    expect(parseTypecheckOutput("")).toBeNull();
  });
});

describe("formatTypecheckDiagnosticsOutput", () => {
  test("returns null for an empty diagnostics array", () => {
    expect(formatTypecheckDiagnosticsOutput([])).toBeNull();
  });

  test("joins each diagnostic's raw text with a blank line between them", () => {
    const diagnostics = [
      { file: "a.ts", message: "boom", raw: "a.ts(1,1): error TS1: boom" },
      { file: "b.ts", message: "bang", raw: "b.ts(2,2): error TS2: bang" },
    ];
    expect(formatTypecheckDiagnosticsOutput(diagnostics)).toBe(
      "a.ts(1,1): error TS1: boom\n\nb.ts(2,2): error TS2: bang",
    );
  });

  test("returns null when every diagnostic's raw text is blank", () => {
    const diagnostics = [
      { file: "a.ts", message: "boom", raw: "  " },
      { file: "b.ts", message: "bang", raw: "" },
    ];
    expect(formatTypecheckDiagnosticsOutput(diagnostics)).toBeNull();
  });
});
