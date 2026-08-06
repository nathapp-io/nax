/**
 * Selection tests for `selectEvenlySpaced`.
 *
 * The selector is a pure function: given a candidate list and a budget, it
 * returns a deterministic evenly-spread subset. It is the single point of
 * truth for per-story mutation budget — both the file-spread bias and the
 * top-of-file bias are fixed here.
 */

import { describe, expect, test } from "bun:test";
import { selectEvenlySpaced } from "@/verification";
import type { Mutant } from "@/verification/mutation/types";

function mutant(file: string, line: number): Mutant {
  return { file, line, before: `b${line}`, after: `a${line}`, operatorId: "ts:cmp-flip" };
}

function makeMutants(count: number, file = "f.ts"): Mutant[] {
  const out: Mutant[] = [];
  for (let i = 0; i < count; i++) out.push(mutant(file, i + 1));
  return out;
}

describe("selectEvenlySpaced — importability (AC1)", () => {
  test("is callable as a function from src/verification/mutation/select.ts", () => {
    expect(typeof selectEvenlySpaced).toBe("function");
  });
});

describe("selectEvenlySpaced — boundary cases", () => {
  test("AC2: nine mutants and max 3 returns exactly three mutants", () => {
    const result = selectEvenlySpaced(makeMutants(9), 3);
    expect(result).toHaveLength(3);
  });

  test("AC3: nine mutants and max 3 returns input positions 0, 3, and 6", () => {
    const mutants = makeMutants(9);
    const result = selectEvenlySpaced(mutants, 3);
    expect(result[0]).toBe(mutants[0]);
    expect(result[1]).toBe(mutants[3]);
    expect(result[2]).toBe(mutants[6]);
  });

  test("AC4: ten mutants and max 3 returns input positions 0, 3, and 6", () => {
    const mutants = makeMutants(10);
    const result = selectEvenlySpaced(mutants, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(mutants[0]);
    expect(result[1]).toBe(mutants[3]);
    expect(result[2]).toBe(mutants[6]);
  });

  test("AC5: two mutants and max 5 returns both mutants in input order", () => {
    const mutants = makeMutants(2);
    const result = selectEvenlySpaced(mutants, 5);
    expect(result).toEqual(mutants);
  });

  test("AC6: empty list and max 3 returns an empty array", () => {
    const result = selectEvenlySpaced([], 3);
    expect(result).toEqual([]);
  });

  test("AC7: nine mutants and max 0 returns an empty array", () => {
    const result = selectEvenlySpaced(makeMutants(9), 0);
    expect(result).toEqual([]);
  });

  test("AC8: nine mutants and max -1 returns an empty array", () => {
    const result = selectEvenlySpaced(makeMutants(9), -1);
    expect(result).toEqual([]);
  });
});

describe("selectEvenlySpaced — determinism (AC9)", () => {
  test("two calls with identical input and max return deeply equal arrays", () => {
    const mutants = makeMutants(9);
    const a = selectEvenlySpaced(mutants, 3);
    const b = selectEvenlySpaced(mutants, 3);
    expect(a).toEqual(b);
  });

  test("does not mutate the input array", () => {
    const mutants = makeMutants(9);
    const before = mutants.slice();
    selectEvenlySpaced(mutants, 3);
    expect(mutants).toEqual(before);
  });
});

describe("selectEvenlySpaced — even spread across multiple files", () => {
  test("strides across a combined list of mutants from multiple files", () => {
    const a = makeMutants(6, "a.ts");
    const b = makeMutants(6, "b.ts");
    const combined = [...a, ...b];
    const result = selectEvenlySpaced(combined, 2);
    expect(result).toHaveLength(2);
    // stride = floor(12/2) = 6 — picks positions 0 (a.ts) and 6 (b.ts).
    expect(result[0]?.file).toBe("a.ts");
    expect(result[1]?.file).toBe("b.ts");
  });
});
