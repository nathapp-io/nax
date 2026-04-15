/**
 * Unit tests for extglob/brace expansion of framework-emitted glob patterns.
 *
 * The downstream `globsToTestRegex` extractor only handles the static suffix
 * after the last `*`. These tests pin down the expansion of common Jest and
 * Vitest defaults into simple globs that suffix extraction handles correctly.
 */

import { describe, expect, test } from "bun:test";
import { expandExtglob, expandExtglobAll } from "../../../src/test-runners/detect/extglob";
import { globsToTestRegex } from "../../../src/test-runners/conventions";

describe("expandExtglob — passthrough cases", () => {
  test("returns plain pattern unchanged when no extglob/brace syntax is present", () => {
    expect(expandExtglob("**/*.test.ts")).toEqual(["**/*.test.ts"]);
    expect(expandExtglob("test/**/*.spec.js")).toEqual(["test/**/*.spec.js"]);
    expect(expandExtglob("**/*_test.go")).toEqual(["**/*_test.go"]);
  });

  test("returns negation patterns unchanged (unsupported)", () => {
    expect(expandExtglob("**/!(test).ts")).toEqual(["**/!(test).ts"]);
  });

  test("returns character-range patterns unchanged (unsupported)", () => {
    expect(expandExtglob("**/test_[a-z].py")).toEqual(["**/test_[a-z].py"]);
  });
});

describe("expandExtglob — single constructs", () => {
  test("brace alternation", () => {
    expect(expandExtglob("**/*.{ts,js}").sort()).toEqual(["**/*.js", "**/*.ts"]);
  });

  test("character class", () => {
    expect(expandExtglob("**/*.[jt]s").sort()).toEqual(["**/*.js", "**/*.ts"]);
  });

  test("optional group ?(x) emits empty + content", () => {
    expect(expandExtglob("**/*.ts?(x)").sort()).toEqual(["**/*.ts", "**/*.tsx"]);
  });

  test("zero-or-more *(x|y) emits empty + each alternative", () => {
    expect(expandExtglob("**/spec*(.unit|.int).ts").sort()).toEqual([
      "**/spec.int.ts",
      "**/spec.ts",
      "**/spec.unit.ts",
    ]);
  });

  test("one-or-more +(x|y) emits each alternative", () => {
    expect(expandExtglob("**/+(spec|test).ts").sort()).toEqual(["**/spec.ts", "**/test.ts"]);
  });

  test("exactly-one @(x|y) emits each alternative", () => {
    expect(expandExtglob("**/@(spec|test).ts").sort()).toEqual(["**/spec.ts", "**/test.ts"]);
  });
});

describe("expandExtglob — Jest defaults", () => {
  test("**/__tests__/**/*.[jt]s?(x) → 4 simple globs", () => {
    const result = expandExtglob("**/__tests__/**/*.[jt]s?(x)").sort();
    expect(result).toEqual([
      "**/__tests__/**/*.js",
      "**/__tests__/**/*.jsx",
      "**/__tests__/**/*.ts",
      "**/__tests__/**/*.tsx",
    ]);
  });

  test("**/?(*.)+(spec|test).[jt]s?(x) → 16 simple globs covering all shapes", () => {
    const result = expandExtglob("**/?(*.)+(spec|test).[jt]s?(x)").sort();
    expect(result).toContain("**/*.spec.ts");
    expect(result).toContain("**/*.spec.tsx");
    expect(result).toContain("**/*.test.js");
    expect(result).toContain("**/spec.ts"); // bare form from ?(*.)
    expect(result).toContain("**/test.jsx");
    expect(result.length).toBe(16);
  });
});

describe("expandExtglob — Vitest defaults", () => {
  test("**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx} expands to 16 globs", () => {
    const result = expandExtglob("**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}");
    expect(result).toContain("**/*.test.ts");
    expect(result).toContain("**/*.spec.tsx");
    expect(result).toContain("**/*.spec.mjs");
    expect(result.length).toBe(16); // 2 × 8
  });
});

describe("expandExtglobAll — multi-pattern de-duplication", () => {
  test("merges and de-dupes overlapping expansions", () => {
    const result = expandExtglobAll(["**/*.{ts,js}", "**/*.[jt]s"]);
    expect(result.sort()).toEqual(["**/*.js", "**/*.ts"]);
  });

  test("preserves passthrough patterns alongside expanded ones", () => {
    const result = expandExtglobAll(["**/*.test.ts", "**/*.{spec,test}.js"]);
    expect(result.sort()).toEqual(["**/*.spec.js", "**/*.test.js", "**/*.test.ts"]);
  });
});

describe("regression — expanded globs work with globsToTestRegex", () => {
  test("Jest defaults expanded → globsToTestRegex matches real test paths", () => {
    const expanded = expandExtglobAll([
      "**/__tests__/**/*.[jt]s?(x)",
      "**/?(*.)+(spec|test).[jt]s?(x)",
    ]);
    const regexes = globsToTestRegex(expanded);

    // The whole point of FEAT-015 fix: real Jest test files must classify as test files.
    const isTest = (p: string) => regexes.some((re) => re.test(p));
    expect(isTest("apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts")).toBe(true);
    expect(isTest("apps/api/test/integration/foo/foo.integration.spec.ts")).toBe(true);
    expect(isTest("src/components/__tests__/button.tsx")).toBe(true);
    expect(isTest("src/foo.test.js")).toBe(true);
    expect(isTest("src/foo.ts")).toBe(false); // source file — must NOT match
  });

  test("non-expanded extglob produces a regex that matches nothing real (the bug)", () => {
    const regexes = globsToTestRegex(["**/?(*.)+(spec|test).[jt]s?(x)"]);
    const isTest = (p: string) => regexes.some((re) => re.test(p));
    // This is the original failure mode: real test files don't match the broken regex.
    expect(isTest("apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts")).toBe(false);
  });
});
