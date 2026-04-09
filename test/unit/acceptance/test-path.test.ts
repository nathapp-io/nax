import { describe, expect, test } from "bun:test";
import {
  resolveSuggestedPackageFeatureTestPath,
  resolveSuggestedTestFile,
  suggestedTestFilename,
} from "../../../src/acceptance/test-path";

describe("suggestedTestFilename()", () => {
  test("returns .nax-suggested.test.ts for TypeScript (default)", () => {
    expect(suggestedTestFilename()).toBe(".nax-suggested.test.ts");
    expect(suggestedTestFilename("typescript")).toBe(".nax-suggested.test.ts");
  });

  test("returns .nax-suggested_test.go for Go", () => {
    expect(suggestedTestFilename("go")).toBe(".nax-suggested_test.go");
  });

  test("returns .nax-suggested.test.py for Python", () => {
    expect(suggestedTestFilename("python")).toBe(".nax-suggested.test.py");
  });

  test("returns .nax-suggested.rs for Rust", () => {
    expect(suggestedTestFilename("rust")).toBe(".nax-suggested.rs");
  });
});

describe("resolveSuggestedTestFile()", () => {
  test("uses config override when provided", () => {
    expect(resolveSuggestedTestFile("go", "custom-suggested.test.ts")).toBe("custom-suggested.test.ts");
  });

  test("falls back to language default when no config override", () => {
    expect(resolveSuggestedTestFile("go")).toBe(".nax-suggested_test.go");
    expect(resolveSuggestedTestFile()).toBe(".nax-suggested.test.ts");
  });
});

describe("resolveSuggestedPackageFeatureTestPath()", () => {
  test("returns correct monorepo path", () => {
    const result = resolveSuggestedPackageFeatureTestPath("/project/apps/api", "auth-feature");
    expect(result).toBe("/project/apps/api/.nax/features/auth-feature/.nax-suggested.test.ts");
  });

  test("respects language", () => {
    const result = resolveSuggestedPackageFeatureTestPath("/project", "feat", undefined, "go");
    expect(result).toBe("/project/.nax/features/feat/.nax-suggested_test.go");
  });

  test("respects config override", () => {
    const result = resolveSuggestedPackageFeatureTestPath("/project", "feat", "custom.test.ts");
    expect(result).toBe("/project/.nax/features/feat/custom.test.ts");
  });
});
