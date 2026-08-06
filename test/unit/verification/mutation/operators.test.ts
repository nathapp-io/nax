/**
 * Per-language mutation operator table tests.
 *
 * These exercise `getOperatorsForLanguage` and each operator's `apply`
 * directly, rather than through `generateMutants`. The indirect route cannot
 * distinguish "this language has no table" from "this operator produced
 * nothing", and it hides which of the 16 operator ids actually ran — the blind
 * spot that let `ts:cmp-flip` ship rewriting `!==` into the uncompilable
 * `!!=` (issue #1487).
 */

import { describe, expect, test } from "bun:test";
import { getOperatorsForLanguage } from "@/verification";
import type { MutationOperator } from "@/verification";

/** Normalise the `string | string[]` operator return into an array. */
function applied(op: MutationOperator, snippet: string): string[] {
  const out = op.apply(snippet);
  return Array.isArray(out) ? out : [out];
}

/** Look up one operator by id, failing loudly when the table lacks it. */
function operator(language: string, id: string): MutationOperator {
  const op = getOperatorsForLanguage(language).find((o) => o.id === id);
  if (!op) throw new Error(`no operator "${id}" in the ${language} table`);
  return op;
}

const LANGUAGE_IDS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["typescript", ["ts:cmp-flip", "ts:cmp-bracket-flip", "ts:bool-flip", "ts:arith-flip"]],
  ["javascript", ["ts:cmp-flip", "ts:cmp-bracket-flip", "ts:bool-flip", "ts:arith-flip"]],
  ["python", ["py:cmp-flip", "py:cmp-bracket-flip", "py:bool-flip", "py:arith-flip"]],
  ["go", ["go:cmp-flip", "go:cmp-bracket-flip", "go:bool-flip", "go:arith-flip"]],
  ["rust", ["rust:cmp-flip", "rust:cmp-bracket-flip", "rust:bool-flip", "rust:arith-flip"]],
];

describe("getOperatorsForLanguage — language dispatch", () => {
  test.each(LANGUAGE_IDS)("%s exposes exactly its four operator ids, in order", (language, ids) => {
    expect(getOperatorsForLanguage(language).map((o) => o.id)).toEqual([...ids]);
  });

  test("javascript resolves to the same table instance as typescript", () => {
    expect(getOperatorsForLanguage("javascript")).toBe(getOperatorsForLanguage("typescript"));
  });

  test("an undefined language yields no operators", () => {
    expect(getOperatorsForLanguage(undefined)).toEqual([]);
  });

  test("an unsupported language yields no operators", () => {
    expect(getOperatorsForLanguage("ruby")).toEqual([]);
  });

  test("language matching is exact — no casing or extension fallback", () => {
    expect(getOperatorsForLanguage("TypeScript")).toEqual([]);
    expect(getOperatorsForLanguage("ts")).toEqual([]);
  });

  test("every operator id is unique across all supported languages", () => {
    const ids = LANGUAGE_IDS.filter(([lang]) => lang !== "javascript").flatMap(([, langIds]) => langIds);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("cmp-flip — strict equality must not be shredded (#1487)", () => {
  test("!== flips only to === , never to the uncompilable !!=", () => {
    const results = applied(operator("typescript", "ts:cmp-flip"), "const x = a !== b;");

    expect(results).toEqual(["const x = a === b;"]);
    expect(results.some((r) => r.includes("!!="))).toBe(false);
  });

  test("=== flips only to !==", () => {
    expect(applied(operator("typescript", "ts:cmp-flip"), "const x = a === b;")).toEqual([
      "const x = a !== b;",
    ]);
  });

  test("a line mixing strict and loose equality mutates each independently", () => {
    const results = applied(operator("typescript", "ts:cmp-flip"), "if (a === b && c != d) {");

    expect(results).toContain("if (a !== b && c != d) {");
    expect(results).toContain("if (a === b && c == d) {");
    expect(results.some((r) => r.includes("!!="))).toBe(false);
  });
});

describe("cmp-flip — loose and relational operators", () => {
  test.each([
    ["x = a == b;", "x = a != b;"],
    ["x = a != b;", "x = a == b;"],
    ["x = a >= b;", "x = a <= b;"],
    ["x = a <= b;", "x = a >= b;"],
  ])("%s produces %s", (snippet, expected) => {
    expect(applied(operator("typescript", "ts:cmp-flip"), snippet)).toContain(expected);
  });

  test("every occurrence of an operator on the line is flipped together", () => {
    expect(applied(operator("go", "go:cmp-flip"), "if a == b && c == d {")).toEqual([
      "if a != b && c != d {",
    ]);
  });

  test("a snippet with no comparison operator produces nothing", () => {
    expect(applied(operator("go", "go:cmp-flip"), "count := total")).toEqual([]);
  });

  test("the universal table has no strict-equality entry — === is left alone", () => {
    // Python/Go/Rust have no `===`; the table must not invent a flip for it.
    expect(applied(operator("python", "py:cmp-flip"), "x = a >= b")).toEqual(["x = a <= b"]);
  });
});

describe("cmp-bracket-flip — bare > and < require whitespace on both sides", () => {
  test.each(["python", "go", "rust"])("%s flips a bare > to <", (language) => {
    expect(applied(operator(language, `${language === "python" ? "py" : language}:cmp-bracket-flip`), "if a > b")).toEqual(
      ["if a < b"],
    );
  });

  test("a bare < flips to >", () => {
    expect(applied(operator("rust", "rust:cmp-bracket-flip"), "if a < b {")).toEqual(["if a > b {"]);
  });

  test("an arrow function is not a comparison", () => {
    expect(applied(operator("typescript", "ts:cmp-bracket-flip"), "const f = (x) => x;")).toEqual([]);
  });

  test("a generic parameter list is not a comparison", () => {
    expect(applied(operator("typescript", "ts:cmp-bracket-flip"), "let xs: Array<string> = [];")).toEqual(
      [],
    );
  });

  test(">= and <= are left to cmp-flip", () => {
    expect(applied(operator("typescript", "ts:cmp-bracket-flip"), "if (a >= b) {")).toEqual([]);
  });
});

describe("bool-flip — per-language literal spelling", () => {
  test.each([
    ["typescript", "ts", "const ok = true;", "const ok = false;"],
    ["go", "go", "ok := true", "ok := false"],
    ["rust", "rust", "let ok = true;", "let ok = false;"],
    ["python", "py", "ok = True", "ok = False"],
  ])("%s flips its true literal", (language, prefix, snippet, expected) => {
    expect(applied(operator(language, `${prefix}:bool-flip`), snippet)).toEqual([expected]);
  });

  test("python does not flip the lowercase JS spelling", () => {
    expect(applied(operator("python", "py:bool-flip"), "ok = true")).toEqual([]);
  });

  test("typescript does not flip the capitalised Python spelling", () => {
    expect(applied(operator("typescript", "ts:bool-flip"), "const ok = True;")).toEqual([]);
  });

  test("the literal must stand alone — substrings are not flipped", () => {
    expect(applied(operator("typescript", "ts:bool-flip"), "const truely = trueish;")).toEqual([]);
  });

  test("a line carrying both literals yields one mutant per direction", () => {
    const results = applied(operator("typescript", "ts:bool-flip"), "const a = true, b = false;");

    expect(results).toContain("const a = false, b = false;");
    expect(results).toContain("const a = true, b = true;");
  });
});

describe("arith-flip — whitespace-guarded binary operators", () => {
  test.each([
    ["const s = a + b;", "const s = a - b;"],
    ["const s = a - b;", "const s = a + b;"],
    ["const s = a * b;", "const s = a / b;"],
    ["const s = a / b;", "const s = a * b;"],
  ])("%s produces %s", (snippet, expected) => {
    expect(applied(operator("typescript", "ts:arith-flip"), snippet)).toContain(expected);
  });

  test("a module specifier is not arithmetic", () => {
    expect(applied(operator("typescript", "ts:arith-flip"), 'import { x } from "../config";')).toEqual(
      [],
    );
  });

  test("a URL is not arithmetic", () => {
    expect(applied(operator("typescript", "ts:arith-flip"), 'const u = "https://a/b/c";')).toEqual([]);
  });

  test("a dangling trailing operator is not mutated", () => {
    expect(applied(operator("typescript", "ts:arith-flip"), "const s = a +")).toEqual([]);
  });

  test("all four languages share the same arithmetic behaviour", () => {
    for (const [language, prefix] of [
      ["python", "py"],
      ["go", "go"],
      ["rust", "rust"],
    ] as const) {
      expect(applied(operator(language, `${prefix}:arith-flip`), "s = a + b")).toContain("s = a - b");
    }
  });
});

describe("operators are pure and repeatable", () => {
  // The tables hold module-level /g regexes; a leaked `lastIndex` would make
  // the second call on identical input disagree with the first.
  test.each(LANGUAGE_IDS.flatMap(([language, ids]) => ids.map((id) => [language, id] as const)))(
    "%s %s returns identical output on repeated calls",
    (language, id) => {
      const op = operator(language, id);
      const snippet = "if a == b && x > y and s = c + d or ok = true or flag = True";

      expect(applied(op, snippet)).toEqual(applied(op, snippet));
    },
  );

  test("an operator never returns duplicate replacements", () => {
    const results = applied(operator("typescript", "ts:cmp-flip"), "if (a === b) {");
    expect(new Set(results).size).toBe(results.length);
  });

  test("an operator never returns the snippet unchanged", () => {
    for (const [language, ids] of LANGUAGE_IDS) {
      for (const id of ids) {
        const snippet = "if a == b && x > y and s = c + d or ok = true";
        expect(applied(operator(language, id), snippet)).not.toContain(snippet);
      }
    }
  });
});
