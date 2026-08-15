/**
 * Tests for Escalation Quote Integrity Check (Issue #930 Part 2)
 */

import { describe, expect, test } from "bun:test";
import {
  _quoteIntegrityDeps,
  extractQuoteTriples,
  verifyEscalationQuotes,
  verifyQuoteTriple,
} from "../../../../src/execution/escalation/quote-integrity";

// ─── extractQuoteTriples ──────────────────────────────────────────────────────

describe("extractQuoteTriples", () => {
  test("no citations → empty array", () => {
    expect(extractQuoteTriples("No file references here.")).toEqual([]);
  });

  test("backtick-quoted snippet after file:line", () => {
    const reason = "lines 42–44 of src/review/semantic.ts:42 `const x = foo()` are wrong";
    const triples = extractQuoteTriples(reason);
    expect(triples).toHaveLength(1);
    expect(triples[0]).toMatchObject({ file: "src/review/semantic.ts", line: 42, quote: "const x = foo()" });
  });

  test("double-quoted snippet after file:line", () => {
    const reason = `test/unit/foo.test.ts:106 "expect(result).toBe(true)" asserts the opposite`;
    const triples = extractQuoteTriples(reason);
    expect(triples).toHaveLength(1);
    expect(triples[0]).toMatchObject({ file: "test/unit/foo.test.ts", line: 106, quote: "expect(result).toBe(true)" });
  });

  test("multiple citations in one reason string", () => {
    const reason = [
      "At src/a.ts:10 `doThing()` and",
      "also src/b.ts:20 `otherThing()` both fail",
    ].join(" ");
    const triples = extractQuoteTriples(reason);
    expect(triples).toHaveLength(2);
    expect(triples[0].file).toBe("src/a.ts");
    expect(triples[1].file).toBe("src/b.ts");
  });

  test("quote shorter than 3 chars is ignored", () => {
    const reason = "src/foo.ts:5 `x` is bad";
    expect(extractQuoteTriples(reason)).toHaveLength(0);
  });

  test("file without extension is not matched", () => {
    const reason = "Makefile:10 `build` target is wrong";
    // "Makefile" has no extension — CITATION_RE requires an extension
    expect(extractQuoteTriples(reason)).toHaveLength(0);
  });
});

// ─── verifyQuoteTriple ────────────────────────────────────────────────────────

describe("verifyQuoteTriple", () => {
  function makeDeps(fileContent: string | null) {
    return {
      readFile: async (_path: string) => fileContent,
    };
  }

  const FILE_CONTENT = [
    "line 1",
    "line 2",
    "const validateAcQuote = (finding) => {",
    "  return { valid: true };",
    "}",
    "line 6",
    "line 7",
  ].join("\n");

  test("quote found within ±3 lines of cited line → true", async () => {
    const triple = { file: "src/review/validator.ts", line: 3, quote: "validateAcQuote" };
    expect(await verifyQuoteTriple(triple, "/workdir", makeDeps(FILE_CONTENT))).toBe(true);
  });

  test("quote found just outside window (line 7 in content, cited line 1) → false", async () => {
    const triple = { file: "src/f.ts", line: 1, quote: "line 7" };
    expect(await verifyQuoteTriple(triple, "/workdir", makeDeps(FILE_CONTENT))).toBe(false);
  });

  test("file does not exist → false", async () => {
    const triple = { file: "src/missing.ts", line: 1, quote: "anything" };
    expect(await verifyQuoteTriple(triple, "/workdir", makeDeps(null))).toBe(false);
  });

  test("quote match is case-insensitive", async () => {
    const triple = { file: "src/f.ts", line: 3, quote: "VALIDATEACQUOTE" };
    expect(await verifyQuoteTriple(triple, "/workdir", makeDeps(FILE_CONTENT))).toBe(true);
  });

  test("quote with extra whitespace is normalised for comparison", async () => {
    const triple = { file: "src/f.ts", line: 3, quote: "validateAcQuote  =  (finding)" };
    expect(await verifyQuoteTriple(triple, "/workdir", makeDeps(FILE_CONTENT))).toBe(true);
  });

  // BUG-08: triple.file comes from LLM-authored escalation text and can
  // contain ".." segments — must not be readable outside workdir even if a
  // file happens to exist there (the readFile stub below would otherwise
  // "verify" it).
  test("path traversal outside workdir is rejected without ever calling readFile", async () => {
    let called = false;
    const deps = {
      readFile: async (_path: string) => {
        called = true;
        return "SECRET=exfiltrated";
      },
    };
    const triple = { file: "../../.env", line: 1, quote: "SECRET=exfiltrated" };
    expect(await verifyQuoteTriple(triple, "/workdir/repo", deps)).toBe(false);
    expect(called).toBe(false);
  });

  test("absolute path outside workdir is rejected", async () => {
    let called = false;
    const deps = {
      readFile: async (_path: string) => {
        called = true;
        return "root:x:0:0";
      },
    };
    const triple = { file: "/etc/passwd", line: 1, quote: "root:x:0:0" };
    expect(await verifyQuoteTriple(triple, "/workdir/repo", deps)).toBe(false);
    expect(called).toBe(false);
  });
});

// ─── verifyEscalationQuotes ───────────────────────────────────────────────────

describe("verifyEscalationQuotes", () => {
  function makeDeps(fileContent: string | null) {
    return { readFile: async (_path: string) => fileContent };
  }

  const REAL_CONTENT = [
    "function doStuff() {",
    "  return 42;",
    "}",
  ].join("\n");

  test("reason with no citations returned unchanged", async () => {
    const reason = "Just a plain failure reason with no file references.";
    expect(await verifyEscalationQuotes(reason, "/workdir", "story-1", makeDeps(null))).toBe(reason);
  });

  test("verified quote retained in output", async () => {
    const reason = "At src/foo.ts:2 `return 42;` is the problem";
    const result = await verifyEscalationQuotes(reason, "/workdir", "story-1", makeDeps(REAL_CONTENT));
    expect(result).toContain("return 42;");
    expect(result).not.toContain("<UNVERIFIED_QUOTE>");
  });

  test("fabricated quote replaced with <UNVERIFIED_QUOTE>", async () => {
    const reason = "At src/foo.ts:2 `fabricatedQuoteNotInFile()` is the smoking gun";
    const result = await verifyEscalationQuotes(reason, "/workdir", "story-1", makeDeps(REAL_CONTENT));
    expect(result).toContain("<UNVERIFIED_QUOTE>");
    expect(result).not.toContain("fabricatedQuoteNotInFile");
    // File:line citation should remain for debugging
    expect(result).toContain("src/foo.ts:2");
  });

  test("file:line citation preserved when quote is replaced", async () => {
    const reason = "src/foo.ts:99 `definitelyNotHere()` is wrong";
    const result = await verifyEscalationQuotes(reason, "/workdir", "story-1", makeDeps(REAL_CONTENT));
    expect(result).toContain("src/foo.ts:99");
  });

  test("multiple citations: verified retained, fabricated replaced", async () => {
    const reason = [
      "First: src/foo.ts:2 `return 42;` is correct.",
      "Second: src/foo.ts:2 `impostor()` is fabricated.",
    ].join(" ");
    const result = await verifyEscalationQuotes(reason, "/workdir", "story-1", makeDeps(REAL_CONTENT));
    expect(result).toContain("return 42;");
    expect(result).toContain("<UNVERIFIED_QUOTE>");
    expect(result).not.toContain("impostor()");
  });

  test("missing file → quote replaced with <UNVERIFIED_QUOTE>", async () => {
    const reason = "src/missing.ts:1 `someQuote()` is the issue";
    const result = await verifyEscalationQuotes(reason, "/workdir", "story-1", makeDeps(null));
    expect(result).toContain("<UNVERIFIED_QUOTE>");
  });
});
