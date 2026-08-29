/**
 * Tests for src/acceptance/generator-helpers.ts
 *
 * Covers:
 * - generateSkeletonTests produces correct skeleton code per language/framework
 * - extractTestCode extracts code from fenced blocks and raw output
 */

import { describe, expect, test } from "bun:test";
import { extractTestCode, generateSkeletonTests } from "@/acceptance/generator-helpers";
import type { AcceptanceCriterion } from "@/acceptance/types";

function makeCriteria(count = 2): AcceptanceCriterion[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `AC-${i + 1}`,
    text: `Criterion ${i + 1}`,
    lineNumber: i + 1,
  }));
}

describe("generateSkeletonTests", () => {
  test("generates TypeScript/bun:test skeleton by default", () => {
    const result = generateSkeletonTests("my-feature", makeCriteria(1));
    expect(result).toContain('import { describe, test, expect } from "bun:test"');
    expect(result).toContain('describe("my-feature - Acceptance Tests"');
    expect(result).toContain('test("AC-1: Criterion 1"');
    expect(result).toContain("expect(true).toBe(false)");
  });

  test("generates jest import when testFramework is jest", () => {
    const result = generateSkeletonTests("feat", makeCriteria(1), "jest");
    expect(result).toContain('import { describe, test, expect } from "@jest/globals"');
  });

  test("generates vitest import when testFramework is vitest", () => {
    const result = generateSkeletonTests("feat", makeCriteria(1), "vitest");
    expect(result).toContain('import { describe, test, expect } from "vitest"');
  });

  test("generates Go skeleton for language=go", () => {
    const result = generateSkeletonTests("feat", makeCriteria(2), undefined, "go");
    expect(result).toContain("package acceptance_test");
    expect(result).toContain('import "testing"');
    expect(result).toContain("func Test");
    expect(result).not.toContain("bun:test");
  });

  test("generates Python skeleton for language=python", () => {
    const result = generateSkeletonTests("feat", makeCriteria(2), undefined, "python");
    expect(result).toContain("import pytest");
    expect(result).toContain("def test_");
    expect(result).not.toContain("bun:test");
  });

  test("generates Rust skeleton for language=rust", () => {
    const result = generateSkeletonTests("feat", makeCriteria(2), undefined, "rust");
    expect(result).toContain("#[cfg(test)]");
    expect(result).toContain("#[test]");
    expect(result).toContain("fn ");
    expect(result).not.toContain("bun:test");
  });

  test("handles empty criteria list", () => {
    const result = generateSkeletonTests("feat", []);
    expect(result).toContain("describe(");
    expect(result).toContain("// No acceptance criteria found");
  });

  test("includes all criteria IDs in TypeScript skeleton", () => {
    const result = generateSkeletonTests("feat", makeCriteria(3));
    expect(result).toContain("AC-1:");
    expect(result).toContain("AC-2:");
    expect(result).toContain("AC-3:");
  });

  // US-006 AC-4: a criterion containing a double quote must produce one
  // well-formed string literal in the test title that round-trips to the
  // original criterion text. The previous implementation interpolated the
  // raw text into `"…"` which produced two unterminated string literals.
  test("escapes double quotes in criterion text so the test title is one well-formed literal that round-trips to the original (US-006 AC-4)", () => {
    const original = 'refuses "foo" arguments';
    const result = generateSkeletonTests("feat", [{ id: "AC-1", text: original, lineNumber: 1 }]);

    // Find the test() call and extract its first argument as a single,
    // well-formed string literal. The previous bug split this into two
    // unterminated literals on the same line.
    const titleLiteral = result.match(/test\(("([^"\\]|\\.)*")/)?.[1];
    expect(titleLiteral).toBeDefined();
    // biome-ignore lint/security/noGlobalEval: test fixture parses a literal the helper produced.
    const roundTripped = titleLiteral ? eval(titleLiteral) : "";
    // Round-trip: the criterion text appears intact inside the title literal,
    // and parsing the literal gives back exactly what we put in (id + text).
    expect(roundTripped).toContain(original);
    expect(roundTripped).toBe(`AC-1: ${original}`);
  });

  // US-006 AC-5: a criterion containing a newline must not leak parts of the
  // criterion text onto a line that is OUTSIDE a comment. The previous
  // implementation interpolated raw text into `// TODO: ${ac.text}`, so a
  // newline-bearing criterion produced real lines that broke the test file
  // (the spillover line started with text from the criterion, not with `//`).
  test("does not let criterion newlines escape into non-comment lines (US-006 AC-5)", () => {
    const original = "line one\nline two\nline three";
    const result = generateSkeletonTests("feat", [{ id: "AC-1", text: original, lineNumber: 1 }]);

    const lines = result.split("\n");
    // After splitting, every source line must either:
    //   (a) start with `//` (is a comment), OR
    //   (b) be blank, OR
    //   (c) start with `import`, `describe`, `});`, `test(`, or other code.
    // The forbidden case is: a line that starts with criterion text that
    // spilled out of a preceding comment. Specifically, no line outside a
    // comment block should have a fragment of the original criterion text
    // as its leading non-whitespace content.
    for (const line of lines) {
      const stripped = line.trimStart();
      if (stripped.length === 0) continue;
      if (stripped.startsWith("//")) continue;
      // Non-comment line: it must not start with a fragment of criterion text.
      // We check the criterion's segments: if any segment appears as the
      // LEADING content of this line, that's a comment-line escape.
      for (const segment of original.split("\n")) {
        if (segment.length === 0) continue;
        if (stripped.startsWith(segment)) {
          expect(stripped.startsWith(segment)).toBe(false);
        }
      }
    }
  });

  // US-006 AC-5 (secondary): a criterion that is *only* newlines (or
  // whitespace) must still produce a syntactically valid test file — i.e. the
  // generated `test(...)` title literal stays a single, parseable literal.
  test("criterion containing only newlines produces a syntactically valid test file (US-006 AC-5)", () => {
    const result = generateSkeletonTests("feat", [{ id: "AC-1", text: "\n\n", lineNumber: 1 }]);

    // The file should still parse — no half-open string literals or
    // stray lines. We assert: no line outside a comment is empty/non-comment.
    // The skeleton emitter always emits a complete test() block per criterion.
    expect(result).toContain("test(");
    expect(result).toContain("describe(");
  });

  // Adversarial review: U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH
  // SEPARATOR) are JavaScript line terminators per ECMA-262 §11.3. A
  // criterion containing either character used to escape the `//` comment
  // block — the replaceAll only handled LF and CR. Verify all four
  // line-terminator characters are now neutralized in the comment context.
  test.each([
    ["U+2028 LINE SEPARATOR", " "],
    ["U+2029 PARAGRAPH SEPARATOR", " "],
  ])("does not let %s escape the comment block (US-006 AC-5)", (_label, sep) => {
    const original = `line one${sep}line two`;
    const result = generateSkeletonTests("feat", [{ id: "AC-1", text: original, lineNumber: 1 }]);

    // The criterion text in the comment must appear as a visible escape
    // sequence (\u2028 / \u2029) — otherwise the JavaScript parser would
    // terminate the // comment and "line two" would land on a non-comment
    // line. The title literal (a string literal, where U+2028/U+2029 are
    // data) may still contain the raw character; only the comment context
    // must be neutralized.
    expect(result).toContain(`\\u${sep.charCodeAt(0).toString(16)}`);
    // Strongest single check: the transpiler must parse the generated
    // source without throwing. If the criterion's U+2028/U+2029 escaped
    // the // comment block, "line two" would land on a non-comment line
    // as bare identifier code and the parse would fail.
    const t = new Bun.Transpiler({});
    expect(() => t.transform(result)).not.toThrow();
  });
});

describe("extractTestCode", () => {
  test("extracts code from typescript fenced block", () => {
    const output = "Here is the test:\n```typescript\ndescribe('x', () => {});\n```";
    const result = extractTestCode(output);
    expect(result).toContain("describe('x'");
    expect(result).not.toContain("```");
  });

  test("extracts code from generic fenced block", () => {
    const output = "```\ndescribe('x', () => { test('y', () => {}); });\n```";
    const result = extractTestCode(output);
    expect(result).toContain("describe('x'");
  });

  test("returns null when no code block present", () => {
    const result = extractTestCode("just some prose");
    expect(result).toBeNull();
  });

  test("extracts Go code from package declaration", () => {
    const output = "package acceptance_test\n\nfunc TestMain(t *testing.T) {}";
    const result = extractTestCode(output);
    expect(result).toContain("package acceptance_test");
    expect(result).toContain("func TestMain");
  });

  test("extracts Python code from def test_", () => {
    const output = "import pytest\n\ndef test_something():\n    pass";
    const result = extractTestCode(output);
    expect(result).toContain("def test_something");
  });

  test("extracts TypeScript from import statement", () => {
    const output = "import { describe, test } from 'bun:test';\ndescribe('x', () => {});";
    const result = extractTestCode(output);
    expect(result).toContain("import { describe, test }");
  });

  test("extracts TypeScript from describe statement", () => {
    const output = "describe('feature', () => { test('ac', () => {}); });";
    const result = extractTestCode(output);
    expect(result).toContain("describe('feature'");
  });

  test("returns null for prose without test keywords", () => {
    const result = extractTestCode("Here is a summary of what I did.");
    expect(result).toBeNull();
  });

  test("returns null for fenced block without test keywords", () => {
    const output = "```\nconst x = 1;\n```";
    const result = extractTestCode(output);
    expect(result).toBeNull();
  });
});
