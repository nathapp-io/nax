import { describe, expect, test } from "bun:test";
import { isTestFile, isSourceFile } from "../src/tdd";

describe("isTestFile", () => {
  test("matches test/ directory", () => {
    expect(isTestFile("test/auth.e2e-spec.ts")).toBe(true);
  });

  test("matches .spec.ts files", () => {
    expect(isTestFile("src/auth/auth.spec.ts")).toBe(true);
  });

  test("matches .test.ts files", () => {
    expect(isTestFile("src/utils.test.ts")).toBe(true);
  });

  test("does not match source files", () => {
    expect(isTestFile("src/auth/auth.service.ts")).toBe(false);
  });
});

describe("isSourceFile", () => {
  test("matches src/ directory", () => {
    expect(isSourceFile("src/auth/auth.service.ts")).toBe(true);
  });

  test("matches lib/ directory", () => {
    expect(isSourceFile("lib/utils.ts")).toBe(true);
  });

  test("does not match test files in test/", () => {
    expect(isSourceFile("test/auth.spec.ts")).toBe(false);
  });
});
