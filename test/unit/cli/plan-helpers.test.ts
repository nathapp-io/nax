/**
 * Unit tests for src/cli/plan-helpers.ts
 *
 * Tests buildSourceRootsSection output format and edge cases, plus the
 * stdin-based CLI interaction bridge used by `nax plan`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { SourceRoot } from "@/analyze/types";
import { buildSourceRootsSection } from "@/cli";
import { createCliInteractionBridge } from "@/cli/plan-helpers";

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

describe("createCliInteractionBridge", () => {
  describe("detectQuestion", () => {
    test("returns true when the text contains a question mark", async () => {
      const bridge = createCliInteractionBridge();
      expect(await bridge.detectQuestion("What should I do?")).toBe(true);
    });

    test("returns false when the text has no question mark", async () => {
      const bridge = createCliInteractionBridge();
      expect(await bridge.detectQuestion("Implementing the story now.")).toBe(false);
    });
  });

  describe("onQuestionDetected", () => {
    const origIsTTY = process.stdin.isTTY;

    afterEach(() => {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    });

    test("skips interaction and returns empty string in non-TTY mode", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      const bridge = createCliInteractionBridge();

      const answer = await bridge.onQuestionDetected("Should I proceed?");

      expect(answer).toBe("");
    });

    test("resolves with an empty string when stdin closes before a line arrives", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      const bridge = createCliInteractionBridge();

      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (() => true) as typeof process.stdout.write;

      try {
        const pending = bridge.onQuestionDetected("Should I proceed?");
        process.stdin.emit("end");
        const answer = await pending;
        expect(answer).toBe("");
      } finally {
        process.stdout.write = origWrite;
      }
    });
  });
});
