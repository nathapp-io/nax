import { describe, expect, test } from "bun:test";
import { parseBiomeJson } from "@/review/lint-parsing/strategies/biome-json";

const REAL_BIOME_ERROR_OUTPUT =
  '{"summary":{"changed":0,"unchanged":1,"matches":0,"duration":{"secs":0,"nanos":1203755},"errors":1,"warnings":0,"skipped":0,"suggestedFixesSkipped":0,"diagnosticsNotPrinted":0},"diagnostics":[{"category":"lint/suspicious/noDebugger","severity":"error","description":"This is an unexpected use of the debugger statement.","message":[{"elements":[],"content":"This is an unexpected use of the "},{"elements":["Emphasis"],"content":"debugger"},{"elements":[],"content":" statement."}],"advices":{"advices":[]},"verboseAdvices":{"advices":[]},"location":{"path":{"file":"/repo/src/foo.ts"},"span":[26,35],"sourceCode":"const x = 1;\\nconst y = 2;\\ndebugger;\\n"},"tags":["fixable"],"source":null}],"command":"check"}';

const REAL_BIOME_CLEAN_OUTPUT =
  '{"summary":{"changed":0,"unchanged":570,"matches":0,"duration":{"secs":0,"nanos":322154954},"errors":0,"warnings":0,"skipped":0,"suggestedFixesSkipped":0,"diagnosticsNotPrinted":0},"diagnostics":[],"command":"check"}';

describe("parseBiomeJson — actual --reporter json format", () => {
  test("parses real biome error output", () => {
    const result = parseBiomeJson(REAL_BIOME_ERROR_OUTPUT);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("biome-json");
    expect(result!.diagnostics).toHaveLength(1);

    const diag = result!.diagnostics[0];
    expect(diag.file).toBe("/repo/src/foo.ts");
    expect(diag.ruleId).toBe("lint/suspicious/noDebugger");
    expect(diag.message).toBe("This is an unexpected use of the debugger statement.");
  });

  test("returns null for clean output with no diagnostics", () => {
    expect(parseBiomeJson(REAL_BIOME_CLEAN_OUTPUT)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseBiomeJson("")).toBeNull();
  });

  test("returns null for plain text (non-JSON)", () => {
    expect(parseBiomeJson("Checked 570 files. No bugs found.")).toBeNull();
  });

  test("handles multiple diagnostics", () => {
    const multi = JSON.stringify({
      diagnostics: [
        {
          category: "lint/suspicious/noDebugger",
          severity: "error",
          description: "Unexpected debugger.",
          message: [],
          location: { path: { file: "/repo/src/a.ts" }, span: [0, 8] },
        },
        {
          category: "lint/correctness/noUnusedVariables",
          severity: "error",
          description: "Variable is unused.",
          message: [],
          location: { path: { file: "/repo/src/b.ts" }, span: [10, 20] },
        },
      ],
      command: "check",
    });

    const result = parseBiomeJson(multi);
    expect(result).not.toBeNull();
    expect(result!.diagnostics).toHaveLength(2);
    expect(result!.diagnostics[0].file).toBe("/repo/src/a.ts");
    expect(result!.diagnostics[1].file).toBe("/repo/src/b.ts");
  });
});
