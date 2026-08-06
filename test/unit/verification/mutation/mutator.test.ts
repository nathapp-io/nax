/**
 * Mutation generation core tests.
 *
 * Covers the deterministic, pure mutation-generation module that the
 * mutation spot-check pipeline uses to seed language-aware mutants.
 */

import { describe, expect, test } from "bun:test";
import { generateMutants } from "@/verification";

describe("generateMutants — TypeScript operator coverage", () => {
  test("AC1: a > b produces a comparison-flip mutant with after 'a < b'", () => {
    const source = "function cmp(a: number, b: number) {\n  return a > b;\n}\n";
    const mutants = generateMutants({ source, language: "typescript", file: "cmp.ts" });

    const flip = mutants.find((m) => m.after.includes("a < b"));
    expect(flip).toBeDefined();
    expect(flip?.before).toContain("a > b");
    expect(flip?.operatorId).toMatch(/cmp|comparison|flip/i);
  });

  test("AC2: boolean literal true is replaced with false", () => {
    const source = "const flag = true;\n";
    const mutants = generateMutants({ source, language: "typescript", file: "flag.ts" });

    const flip = mutants.find((m) => m.after.includes("false") && m.before.includes("true"));
    expect(flip).toBeDefined();
  });

  test("AC3: x + y produces an arithmetic mutant with after 'x - y'", () => {
    const source = "function add(x: number, y: number) {\n  return x + y;\n}\n";
    const mutants = generateMutants({ source, language: "typescript", file: "add.ts" });

    const flip = mutants.find((m) => m.after.includes("x - y"));
    expect(flip).toBeDefined();
    expect(flip?.before).toContain("x + y");
  });
});

describe("generateMutants — Mutant shape", () => {
  test("AC4: each Mutant exposes file, 1-indexed line, before, after, operatorId", () => {
    const source = "if (a > b) {\n  return true;\n}\n";
    const mutants = generateMutants({ source, language: "typescript", file: "check.ts" });

    expect(mutants.length).toBeGreaterThan(0);
    for (const m of mutants) {
      expect(m.file).toBe("check.ts");
      expect(typeof m.line).toBe("number");
      expect(m.line).toBeGreaterThanOrEqual(1);
      expect(typeof m.before).toBe("string");
      expect(typeof m.after).toBe("string");
      expect(typeof m.operatorId).toBe("string");
      expect(m.operatorId.length).toBeGreaterThan(0);
    }
  });
});

describe("generateMutants — unsupported languages", () => {
  test("undefined language returns empty array", () => {
    expect(generateMutants({ source: "a > b\n", language: undefined, file: "x.ts" })).toEqual([]);
  });

  test("unknown language returns empty array", () => {
    expect(generateMutants({ source: "a > b\n", language: "ruby", file: "x.rb" })).toEqual([]);
  });
});

describe("generateMutants — Python operator coverage", () => {
  test("bool-flip: True -> False", () => {
    const mutants = generateMutants({ source: "flag = True\n", language: "python", file: "f.py" });
    expect(mutants.some((m) => m.after === "flag = False" && m.operatorId === "py:bool-flip")).toBe(true);
  });

  test("cmp-flip: == -> !=", () => {
    const mutants = generateMutants({ source: "x = a == b\n", language: "python", file: "f.py" });
    expect(mutants.some((m) => m.after === "x = a != b" && m.operatorId === "py:cmp-flip")).toBe(true);
  });

  test("arith-flip: + -> -", () => {
    const mutants = generateMutants({ source: "y = a + b\n", language: "python", file: "f.py" });
    expect(mutants.some((m) => m.after === "y = a - b" && m.operatorId === "py:arith-flip")).toBe(true);
  });
});

describe("generateMutants — Go operator coverage", () => {
  test("bool-flip: true -> false", () => {
    const mutants = generateMutants({ source: "ok := true\n", language: "go", file: "f.go" });
    expect(mutants.some((m) => m.after === "ok := false" && m.operatorId === "go:bool-flip")).toBe(true);
  });

  test("bracket-flip: > -> <", () => {
    const mutants = generateMutants({ source: "if a > b {\n", language: "go", file: "f.go" });
    expect(mutants.some((m) => m.after === "if a < b {" && m.operatorId === "go:cmp-bracket-flip")).toBe(true);
  });
});

describe("generateMutants — Rust operator coverage", () => {
  test("bool-flip: true -> false", () => {
    const mutants = generateMutants({ source: "let ok = true;\n", language: "rust", file: "f.rs" });
    expect(mutants.some((m) => m.after === "let ok = false;" && m.operatorId === "rust:bool-flip")).toBe(true);
  });

  test("cmp-flip: == -> !=", () => {
    const mutants = generateMutants({ source: "let e = a == b;\n", language: "rust", file: "f.rs" });
    expect(mutants.some((m) => m.after === "let e = a != b;" && m.operatorId === "rust:cmp-flip")).toBe(true);
  });
});

describe("generateMutants — no truncation (US-002 AC10)", () => {
  test("AC10: source yielding more than three candidates with no max returns every candidate", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`const v${i} = a > b;`);
    }
    const source = `${lines.join("\n")}\n`;

    const mutants = generateMutants({ source, language: "typescript", file: "many.ts" });

    // Each `a > b` line produces exactly one `ts:cmp-bracket-flip` mutant;
    // 10 lines must yield 10 mutants (no truncation when max is omitted).
    expect(mutants).toHaveLength(10);
  });
});

describe("generateMutants — empty source", () => {
  test("AC9: source with no operator-matchable tokens returns empty array", () => {
    const source = "// just a comment\nconst x = 1;\n";
    const mutants = generateMutants({ source, language: "typescript", file: "empty.ts" });
    expect(mutants).toEqual([]);
  });
});

describe("generateMutants — deduplication", () => {
  test("overlapping comparison patterns (>= and >) produce a single mutant", () => {
    const mutants = generateMutants({ source: "if (a >= b) {}", language: "typescript", file: "x.ts" });
    expect(mutants).toHaveLength(1);
    expect(mutants[0].after).toBe("if (a <= b) {}");
  });

  test("overlapping comparison patterns (<= and <) produce a single mutant", () => {
    const mutants = generateMutants({ source: "if (a <= b) {}", language: "typescript", file: "x.ts" });
    expect(mutants).toHaveLength(1);
    expect(mutants[0].after).toBe("if (a >= b) {}");
  });

  test("overlapping equality patterns (=== and ==) produce a single mutant", () => {
    const mutants = generateMutants({ source: "if (a === b) {}", language: "typescript", file: "x.ts" });
    expect(mutants).toHaveLength(1);
    expect(mutants[0].after).toBe("if (a !== b) {}");
  });
});

describe("generateMutants — language-aware comment skipping", () => {
  test("Python '#' comment line is not mutated", () => {
    const mutants = generateMutants({ source: "# a == b\n", language: "python", file: "f.py" });
    expect(mutants).toEqual([]);
  });

  test("non-Python '//' comment line is still skipped", () => {
    const mutants = generateMutants({ source: "// a == b\n", language: "rust", file: "f.rs" });
    expect(mutants).toEqual([]);
  });

  test("Python leading '#' line is skipped but a real code line still mutates", () => {
    const source = "# comment == here\nx = a == b\n";
    const mutants = generateMutants({ source, language: "python", file: "f.py" });
    expect(mutants.every((m) => m.line !== 1)).toBe(true);
    expect(mutants.some((m) => m.operatorId === "py:cmp-flip" && m.line === 2)).toBe(true);
  });
});

describe("generateMutants — whitespace-guard arithmetic (non-spaced tokens must not mutate)", () => {
  test("AC1: '@/errors' import specifier yields no ts:arith-flip mutant", () => {
    const source = `import { NaxError } from "@/errors";`;
    const mutants = generateMutants({ source, language: "typescript", file: "errors.ts" });
    expect(mutants.some((m) => m.operatorId === "ts:arith-flip")).toBe(false);
  });

  test("AC2: './types' import type specifier yields no ts:arith-flip mutant", () => {
    const source = `import type { Mutant } from "./types";`;
    const mutants = generateMutants({ source, language: "typescript", file: "types.ts" });
    expect(mutants.some((m) => m.operatorId === "ts:arith-flip")).toBe(false);
  });

  test("AC3: URL string literal yields no ts:arith-flip mutant", () => {
    const source = `const url = "https://a.example/b/c";`;
    const mutants = generateMutants({ source, language: "typescript", file: "url.ts" });
    expect(mutants.some((m) => m.operatorId === "ts:arith-flip")).toBe(false);
  });

  test("AC4: spaced '-' on a real arithmetic expression mutates to '+'", () => {
    const source = `const idx = line - 1;`;
    const mutants = generateMutants({ source, language: "typescript", file: "idx.ts" });
    expect(mutants.some((m) => m.operatorId === "ts:arith-flip" && m.after === "const idx = line + 1;")).toBe(true);
  });

  test("AC5: spaced '+' mutates to '-'", () => {
    const source = `const total = a + b;`;
    const mutants = generateMutants({ source, language: "typescript", file: "total.ts" });
    expect(mutants.some((m) => m.operatorId === "ts:arith-flip" && m.after === "const total = a - b;")).toBe(true);
  });

  test("AC6: spaced '/' mutates to '*'", () => {
    const source = `const half = n / 2;`;
    const mutants = generateMutants({ source, language: "typescript", file: "half.ts" });
    expect(mutants.some((m) => m.operatorId === "ts:arith-flip" && m.after === "const half = n * 2;")).toBe(true);
  });

  test("AC7: spaced '*' mutates to '/'", () => {
    const source = `const twice = n * 2;`;
    const mutants = generateMutants({ source, language: "typescript", file: "twice.ts" });
    expect(mutants.some((m) => m.operatorId === "ts:arith-flip" && m.after === "const twice = n / 2;")).toBe(true);
  });

  test("AC8: Python spaced '+' mutates to '-'", () => {
    const source = `y = a + b`;
    const mutants = generateMutants({ source, language: "python", file: "f.py" });
    expect(mutants.some((m) => m.operatorId === "py:arith-flip" && m.after === "y = a - b")).toBe(true);
  });

  test("AC9: Python path string literal yields no py:arith-flip mutant", () => {
    const source = `path = "a/b/c"`;
    const mutants = generateMutants({ source, language: "python", file: "f.py" });
    expect(mutants.some((m) => m.operatorId === "py:arith-flip")).toBe(false);
  });

  test("AC10: Go spaced '+' mutates to '-'", () => {
    const source = `sum := a + b`;
    const mutants = generateMutants({ source, language: "go", file: "f.go" });
    expect(mutants.some((m) => m.operatorId === "go:arith-flip" && m.after === "sum := a - b")).toBe(true);
  });

  test("AC11: Rust spaced '+' mutates to '-'", () => {
    const source = `let sum = a + b;`;
    const mutants = generateMutants({ source, language: "rust", file: "f.rs" });
    expect(mutants.some((m) => m.operatorId === "rust:arith-flip" && m.after === "let sum = a - b;")).toBe(true);
  });

  test("AC12: arithmetic mutations on a line with spaced arithmetic land at line >= 6", () => {
    const lines = [
      `import { a } from "./a";`,
      `import { b } from "./b";`,
      `import { c } from "./c";`,
      `import { d } from "./d";`,
      `import { e } from "./e";`,
      `const total = a + b;`,
    ];
    const source = `${lines.join("\n")}\n`;
    const mutants = generateMutants({ source, language: "typescript", file: "imports.ts" });
    expect(mutants.length).toBeGreaterThan(0);
    for (const m of mutants) {
      expect(m.line).toBeGreaterThanOrEqual(6);
    }
  });

  test("AC13: two calls with identical inputs return deeply equal arrays", () => {
    const source = `const x = a + b;\nconst y = c - d;\n`;
    const first = generateMutants({ source, language: "typescript", file: "x.ts" });
    const second = generateMutants({ source, language: "typescript", file: "x.ts" });
    expect(second).toEqual(first);
  });
});
