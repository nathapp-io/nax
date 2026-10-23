import { describe, expect, test } from "bun:test";
import { BUN_CHECK_SAMPLE } from "@test/fixtures/bun-check";
import { formatTypecheckDiagnosticsOutput, parseTypecheckOutput } from "@/review/typecheck-parsing/parse";

const TSC_OUTPUT = "src/foo.ts(1,1): error TS2304: Cannot find name 'foo'.";

describe("parseTypecheckOutput", () => {
  test.each([
    ["AC-1 format", (r: ReturnType<typeof parseTypecheckOutput>) => r?.format, "bun-check"],
    ["AC-2 count", (r: ReturnType<typeof parseTypecheckOutput>) => r?.diagnostics.length, 1],
    [
      "AC-3 file",
      (r: ReturnType<typeof parseTypecheckOutput>) => r?.diagnostics[0]?.file,
      "test/unit/forge-tools/log-tool.test.ts",
    ],
    ["AC-4 line", (r: ReturnType<typeof parseTypecheckOutput>) => r?.diagnostics[0]?.line, 90],
    ["AC-5 column", (r: ReturnType<typeof parseTypecheckOutput>) => r?.diagnostics[0]?.column, 86],
    ["AC-6 code", (r: ReturnType<typeof parseTypecheckOutput>) => r?.diagnostics[0]?.code, "2769"],
    [
      "AC-7 message",
      (r: ReturnType<typeof parseTypecheckOutput>) => r?.diagnostics[0]?.message,
      "No overload matches this call.",
    ],
    [
      "AC-8 raw start",
      (r: ReturnType<typeof parseTypecheckOutput>) => r?.diagnostics[0]?.raw.startsWith("<error file="),
      true,
    ],
    ["AC-9 raw end", (r: ReturnType<typeof parseTypecheckOutput>) => r?.diagnostics[0]?.raw.endsWith("</error>"), true],
    ["AC-16 tool", (r: ReturnType<typeof parseTypecheckOutput>) => r?.findings?.[0]?.tool, "bun check"],
    ["AC-17 rule", (r: ReturnType<typeof parseTypecheckOutput>) => r?.findings?.[0]?.rule, "TS2769"],
  ] as const)("%s", (_name, select, expected) => {
    expect(select(parseTypecheckOutput(BUN_CHECK_SAMPLE, "auto", { workdir: "/repo" }))).toBe(expected);
  });

  test("auto prefers bun blocks over mixed tsc diagnostics", () => {
    const result = parseTypecheckOutput(`${TSC_OUTPUT}\n${BUN_CHECK_SAMPLE}`);
    expect(result?.format).toBe("bun-check");
    expect(result?.diagnostics).toHaveLength(1);
  });

  test("AC-23 auto preserves tsc fallback", () => {
    expect(parseTypecheckOutput(TSC_OUTPUT, "auto", { workdir: "/repo" })?.format).toBe("tsc");
  });

  test("AC-24 none disables bun parsing", () => {
    expect(parseTypecheckOutput(BUN_CHECK_SAMPLE, "none", { workdir: "/repo" })).toBeNull();
  });

  test("explicit tsc does not select bun blocks", () => {
    expect(parseTypecheckOutput(BUN_CHECK_SAMPLE, "tsc")).toBeNull();
  });

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

  test("'auto' recognizes tsc output when no bun error block is present", () => {
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
