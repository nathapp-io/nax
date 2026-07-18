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

describe("generateMutants — max limit", () => {
  test("AC8: 10 operator-matchable lines with max=3 returns at most 3 mutants", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`const v${i} = a > b;`);
    }
    const source = `${lines.join("\n")}\n`;

    const mutants = generateMutants({ source, language: "typescript", file: "many.ts", max: 3 });

    expect(mutants.length).toBeLessThanOrEqual(3);
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
