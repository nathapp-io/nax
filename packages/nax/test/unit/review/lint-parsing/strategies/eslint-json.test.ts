/**
 * Unit tests for src/review/lint-parsing/strategies/eslint-json.ts — the
 * parser for ESLint's `--format json` output.
 */

import { describe, expect, test } from "bun:test";
import { eslintJsonStrategy, parseEslintJson } from "@/review/lint-parsing/strategies/eslint-json";

describe("parseEslintJson", () => {
  test("returns null for empty or whitespace-only output", () => {
    expect(parseEslintJson("")).toBeNull();
    expect(parseEslintJson("   \n")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseEslintJson("{not valid json")).toBeNull();
  });

  test("returns null when the payload is a non-array, non-{results} object", () => {
    expect(parseEslintJson(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  test("returns null when the payload is a bare scalar (null asRecord path)", () => {
    expect(parseEslintJson("42")).toBeNull();
    expect(parseEslintJson("null")).toBeNull();
  });

  test("returns null when entries array is empty", () => {
    expect(parseEslintJson("[]")).toBeNull();
    expect(parseEslintJson(JSON.stringify({ results: [] }))).toBeNull();
  });

  test("parses a top-level array of result entries (standard ESLint --format json)", () => {
    const output = JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          { line: 10, column: 5, severity: 2, ruleId: "no-unused-vars", message: "'x' is unused" },
          { line: 20, column: 1, severity: 1, ruleId: "no-console", message: "avoid console" },
        ],
      },
    ]);

    const result = parseEslintJson(output);
    expect(result?.format).toBe("eslint-json");
    expect(result?.diagnostics).toHaveLength(2);
    expect(result?.diagnostics[0]).toEqual({
      file: "/repo/src/a.ts",
      line: 10,
      column: 5,
      severity: "error",
      ruleId: "no-unused-vars",
      message: "'x' is unused",
      raw: "/repo/src/a.ts:10:5 'x' is unused",
    });
    expect(result?.diagnostics[1].severity).toBe("warning");
  });

  test("parses a { results: [...] } wrapper shape", () => {
    const output = JSON.stringify({
      results: [{ filePath: "/repo/b.ts", messages: [{ line: 1, column: 1, severity: 2, message: "boom" }] }],
    });
    const result = parseEslintJson(output);
    expect(result?.diagnostics).toHaveLength(1);
    expect(result?.diagnostics[0].file).toBe("/repo/b.ts");
  });

  test("maps unknown/absent severity to 'info'", () => {
    const output = JSON.stringify([{ filePath: "/repo/c.ts", messages: [{ message: "note", severity: 0 }] }]);
    const result = parseEslintJson(output);
    expect(result?.diagnostics[0].severity).toBe("info");

    const output2 = JSON.stringify([{ filePath: "/repo/c.ts", messages: [{ message: "note" }] }]);
    expect(parseEslintJson(output2)?.diagnostics[0].severity).toBe("info");
  });

  test("omits line/column when not numbers, and ruleId when null/absent", () => {
    const output = JSON.stringify([{ filePath: "/repo/d.ts", messages: [{ message: "no location", ruleId: null }] }]);
    const result = parseEslintJson(output);
    const diag = result?.diagnostics[0];
    expect(diag?.line).toBeUndefined();
    expect(diag?.column).toBeUndefined();
    expect(diag?.ruleId).toBeUndefined();
    expect(diag?.raw).toBe("/repo/d.ts:0:0 no location");
  });

  test("skips a message with no `message` text", () => {
    const output = JSON.stringify([
      {
        filePath: "/repo/e.ts",
        messages: [
          { line: 1, column: 1, severity: 2 },
          { line: 2, column: 1, message: "kept" },
        ],
      },
    ]);
    const result = parseEslintJson(output);
    expect(result?.diagnostics).toHaveLength(1);
    expect(result?.diagnostics[0].message).toBe("kept");
  });

  test("skips an entry with no filePath, or whose messages is not an array", () => {
    const output = JSON.stringify([
      { messages: [{ line: 1, message: "no file" }] },
      { filePath: "/repo/f.ts", messages: "not-an-array" },
      { filePath: "/repo/g.ts", messages: [{ line: 1, message: "kept" }] },
    ]);
    const result = parseEslintJson(output);
    expect(result?.diagnostics).toHaveLength(1);
    expect(result?.diagnostics[0].file).toBe("/repo/g.ts");
  });

  test("returns null when every entry's messages array is empty or filtered out", () => {
    const output = JSON.stringify([
      { filePath: "/repo/h.ts", messages: [] },
      { filePath: "/repo/i.ts", messages: [{ line: 1, severity: 2 }] },
    ]);
    expect(parseEslintJson(output)).toBeNull();
  });
});

describe("eslintJsonStrategy", () => {
  test("exposes the strategy name and delegates parse to parseEslintJson", () => {
    expect(eslintJsonStrategy.name).toBe("eslint-json");
    const output = JSON.stringify([{ filePath: "/repo/a.ts", messages: [{ line: 1, message: "x" }] }]);
    expect(eslintJsonStrategy.parse(output)).toEqual(parseEslintJson(output));
  });
});
