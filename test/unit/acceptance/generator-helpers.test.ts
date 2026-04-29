/**
 * Tests for src/acceptance/generator-helpers.ts
 *
 * Covers:
 * - generateSkeletonTests produces correct skeleton code per language/framework
 * - extractTestCode extracts code from fenced blocks and raw output
 */

import { describe, expect, test } from "bun:test";
import { extractTestCode, generateSkeletonTests } from "../../../src/acceptance/generator-helpers";
import type { AcceptanceCriterion } from "../../../src/acceptance/types";

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
