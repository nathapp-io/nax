/**
 * Unit tests for src/cli/plan-helpers.ts
 *
 * Tests buildSourceRootsSection output format and edge cases.
 */

import { describe, expect, test } from "bun:test";
import type { SourceRoot } from "@/analyze/types";
import { buildSourceRootsSection } from "@/cli";

describe("buildSourceRootsSection", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // AC-1: Returns a string starting with "## Source Roots"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-1: returns a string starting with '## Source Roots'", () => {
    const roots: SourceRoot[] = [];
    const result = buildSourceRootsSection(roots);
    expect(result.startsWith("## Source Roots")).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-2: Contains one "- <path>  (<language|unknown>, framework: ..., tests: ...)" line per root
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-2: renders single root with language, framework, and test runner", () => {
    const roots: SourceRoot[] = [
      { path: "packages/api", language: "typescript", framework: "NestJS", testRunner: "jest" },
    ];
    const result = buildSourceRootsSection(roots);
    expect(result).toContain("- packages/api  (typescript, framework: NestJS, tests: jest)");
  });

  test("AC-2: renders multiple roots correctly", () => {
    const roots: SourceRoot[] = [
      { path: "packages/api", language: "typescript", framework: "NestJS", testRunner: "jest" },
      { path: "packages/web", language: "typescript", framework: "Next.js", testRunner: "vitest" },
      { path: "cmd/worker", language: "go", framework: "", testRunner: "go-test" },
    ];
    const result = buildSourceRootsSection(roots);
    expect(result).toContain("- packages/api  (typescript, framework: NestJS, tests: jest)");
    expect(result).toContain("- packages/web  (typescript, framework: Next.js, tests: vitest)");
    expect(result).toContain("- cmd/worker  (go, framework: —, tests: go-test)");
  });

  test("AC-2: renders empty framework and test runner as '—'", () => {
    const roots: SourceRoot[] = [{ path: "python-pkg", language: "python", framework: "", testRunner: "" }];
    const result = buildSourceRootsSection(roots);
    expect(result).toContain("- python-pkg  (python, framework: —, tests: —)");
  });

  test("AC-2: renders undefined language as 'unknown'", () => {
    const roots: SourceRoot[] = [{ path: "ambiguous", language: undefined, framework: "", testRunner: "" }];
    const result = buildSourceRootsSection(roots);
    expect(result).toContain("- ambiguous  (unknown, framework: —, tests: —)");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-3: When called with empty array, contains "- .  (unknown, framework: —, tests: —)"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-3: returns '- .  (unknown, framework: —, tests: —)' when array is empty", () => {
    const result = buildSourceRootsSection([]);
    expect(result).toContain("- .  (unknown, framework: —, tests: —)");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Additional: Section contains instruction text about tools and budget
  // ──────────────────────────────────────────────────────────────────────────

  test("includes instruction text about Read, Grep, and Glob tools", () => {
    const result = buildSourceRootsSection([]);
    expect(result).toContain("You have Read, Grep, and Glob tools");
  });

  test("includes budget guidance of '≤ 10 file reads per story'", () => {
    const result = buildSourceRootsSection([]);
    expect(result).toContain("≤ 10 file reads per story");
  });

  test("includes instruction to cite findings as 'path:line'", () => {
    const result = buildSourceRootsSection([]);
    expect(result).toContain("path:line");
  });
});
