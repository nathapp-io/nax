/**
 * Unit tests for src/review/lint-parsing/strategies/ruff-annotated.ts — the
 * parser for ruff's default annotated-diagnostic output format (ruff 0.4+).
 */

import { describe, expect, test } from "bun:test";
import { parseRuffAnnotated, ruffAnnotatedStrategy } from "@/review/lint-parsing/strategies/ruff-annotated";

describe("parseRuffAnnotated", () => {
  test("returns null for empty or whitespace-only output", () => {
    expect(parseRuffAnnotated("")).toBeNull();
    expect(parseRuffAnnotated("   \n  \n")).toBeNull();
  });

  test("returns null when there is no --> arrow line at all", () => {
    expect(parseRuffAnnotated("All checks passed!")).toBeNull();
  });

  test("parses a single diagnostic with a message line, file:line:col, and context", () => {
    const output = [
      "E501 Line too long (110 > 100)",
      "    --> tests/unit/data/test_universe.py:1148:101",
      "     |",
      '1148 |         """...',
      "     |                 ^^^",
    ].join("\n");

    const result = parseRuffAnnotated(output);
    expect(result).not.toBeNull();
    expect(result?.format).toBe("ruff-annotated");
    expect(result?.diagnostics).toHaveLength(1);
    const diag = result?.diagnostics[0];
    expect(diag?.file).toBe("tests/unit/data/test_universe.py");
    expect(diag?.line).toBe(1148);
    expect(diag?.column).toBe(101);
    expect(diag?.message).toBe("E501 Line too long (110 > 100)");
    expect(diag?.raw).toContain("E501 Line too long (110 > 100)");
    expect(diag?.raw).toContain("-->");
  });

  test("parses an arrow line without a column", () => {
    const output = ["F401 'os' imported but unused", "    --> src/main.py:12"].join("\n");
    const result = parseRuffAnnotated(output);
    const diag = result?.diagnostics[0];
    expect(diag?.line).toBe(12);
    expect(diag?.column).toBeUndefined();
  });

  test("parses multiple diagnostics in one output", () => {
    const output = [
      "E501 Line too long",
      "    --> a.py:1:1",
      "     |",
      "1 | x = 1",
      "     |",
      "",
      "F401 unused import",
      "    --> b.py:2:1",
      "     |",
      "2 | import os",
      "     |",
    ].join("\n");

    const result = parseRuffAnnotated(output);
    expect(result?.diagnostics).toHaveLength(2);
    expect(result?.diagnostics[0].file).toBe("a.py");
    expect(result?.diagnostics[1].file).toBe("b.py");
  });

  test("skips an arrow line whose path has no recognised source extension", () => {
    const output = ["Some note", "    --> not-a-source-file.txt:1:1"].join("\n");
    expect(parseRuffAnnotated(output)).toBeNull();
  });

  test("returns null when the only arrow line is unrecognised, leaving zero diagnostics", () => {
    // hasArrow is true (matches ARROW_RE) but the loop's own arrowMatch/extension
    // check still filters it out — exercises the two-pass mismatch.
    const output = "    --> config.yaml:5:2";
    expect(parseRuffAnnotated(output)).toBeNull();
  });

  test("collects multiple message lines above the arrow, stopping at a blank line", () => {
    const output = [
      "note: this is additional context",
      "E501 Line too long",
      "    --> a.py:1:1",
      "     |",
      "1 | x = 1",
    ].join("\n");

    const result = parseRuffAnnotated(output);
    const diag = result?.diagnostics[0];
    expect(diag?.message).toBe("E501 Line too long");
    expect(diag?.raw).toContain("note: this is additional context");
    expect(diag?.raw).toContain("E501 Line too long");
  });

  test("message-line walk-back stops at a preceding --> line, not bleeding into the prior diagnostic", () => {
    const output = [
      "E501 first",
      "    --> a.py:1:1",
      "     |",
      "1 | x = 1",
      "     |",
      "F401 second",
      "    --> b.py:2:1",
    ].join("\n");

    const result = parseRuffAnnotated(output);
    expect(result?.diagnostics).toHaveLength(2);
    expect(result?.diagnostics[1].message).toBe("F401 second");
    expect(result?.diagnostics[1].raw).not.toContain("E501 first");
  });

  test("falls back to the file path as the message when there is no message line above the arrow", () => {
    const output = "    --> a.py:1:1\n     |\n1 | x = 1";
    const result = parseRuffAnnotated(output);
    expect(result?.diagnostics[0].message).toBe("a.py");
  });

  test("i advances past a non-matching / unsupported line without an infinite loop", () => {
    const output = ["some unrelated line", "another unrelated line", "E501 msg", "    --> a.py:1:1"].join("\n");
    const result = parseRuffAnnotated(output);
    expect(result?.diagnostics).toHaveLength(1);
    expect(result?.diagnostics[0].file).toBe("a.py");
  });
});

describe("ruffAnnotatedStrategy", () => {
  test("exposes the strategy name and delegates parse to parseRuffAnnotated", () => {
    expect(ruffAnnotatedStrategy.name).toBe("ruff-annotated");
    const output = "E501 msg\n    --> a.py:1:1";
    expect(ruffAnnotatedStrategy.parse(output)).toEqual(parseRuffAnnotated(output));
  });
});
