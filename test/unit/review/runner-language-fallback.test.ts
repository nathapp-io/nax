/**
 * Unit tests for US-004: Language-aware command fallback in review runner
 *
 * Tests cover:
 * - resolveLanguageCommand() lookup table + binary availability check
 * - resolveCommand() language-aware fallback as step 4 in resolution order
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _reviewGitDeps, _reviewRunnerDeps, resolveCommand, resolveLanguageCommand } from "@/review/runner";
import type { ReviewConfig } from "@/review/types";
import { makeConfigSlice } from "@test/helpers";

/** Minimal ReviewConfig with no explicit commands — lets fallback logic run */
const emptyConfig: ReviewConfig = makeConfigSlice("review", {
  enabled: true,
  checks: [],
  commands: {},
});

// ---------------------------------------------------------------------------
// resolveLanguageCommand — lookup table + binary check
// ---------------------------------------------------------------------------

describe("resolveLanguageCommand — language command table", () => {
  afterEach(() => {
    mock.restore();
  });

  describe("Go language", () => {
    test("returns correct command for test/lint/typecheck when go binaries are available", () => {
      const scenarios = [
        { check: "test", expected: "go test ./..." },
        { check: "lint", expected: "golangci-lint run" },
        { check: "typecheck", expected: "go vet ./..." },
      ] as const;
      for (const { check, expected } of scenarios) {
        const mockWhich = mock((_name: string) => "/usr/local/bin/go");
        expect(resolveLanguageCommand("go", check, mockWhich), check).toBe(expected);
      }
    });

    test("returns null for lint and test when go/golangci-lint binary is not found", () => {
      const mockWhich = mock((_name: string) => null);
      expect(resolveLanguageCommand("go", "lint", mockWhich)).toBeNull();
      expect(resolveLanguageCommand("go", "test", mockWhich)).toBeNull();
    });
  });

  describe("Rust language", () => {
    test("returns correct command when cargo is available; null when binary not found", () => {
      const found = mock((_name: string) => "/usr/local/bin/cargo");
      expect(resolveLanguageCommand("rust", "test", found), "test").toBe("cargo test");
      expect(resolveLanguageCommand("rust", "lint", found), "lint").toBe("cargo clippy -- -D warnings");
      const notFound = mock((_name: string) => null);
      expect(resolveLanguageCommand("rust", "test", notFound), "test-null").toBeNull();
    });
  });

  describe("Python language", () => {
    test("returns correct command for test/lint/typecheck when python binaries are available", () => {
      const scenarios = [
        { check: "test", expected: "pytest" },
        { check: "lint", expected: "ruff check ." },
        { check: "typecheck", expected: "mypy ." },
      ] as const;
      for (const { check, expected } of scenarios) {
        const mockWhich = mock((_name: string) => "/usr/local/bin/something");
        expect(resolveLanguageCommand("python", check, mockWhich), check).toBe(expected);
      }
    });

    test("returns null for missing binary, unsupported language, or empty language string", () => {
      expect(
        resolveLanguageCommand(
          "python",
          "lint",
          mock((_name: string) => null),
        ),
      ).toBeNull();
      expect(
        resolveLanguageCommand(
          "ruby",
          "test",
          mock((_name: string) => "/usr/bin/ruby"),
        ),
      ).toBeNull();
      expect(
        resolveLanguageCommand(
          "",
          "test",
          mock((_name: string) => "/usr/bin/something"),
        ),
      ).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// resolveCommand — language-aware fallback (AC-1 through AC-7)
// ---------------------------------------------------------------------------

describe("resolveCommand — language-aware fallback (US-004)", () => {
  let originalWhich: typeof _reviewRunnerDeps.which;
  let originalFile: typeof _reviewRunnerDeps.file;
  let originalGetUncommittedFiles: typeof _reviewGitDeps.getUncommittedFiles;

  beforeEach(() => {
    originalWhich = _reviewRunnerDeps.which;
    originalFile = _reviewRunnerDeps.file;
    originalGetUncommittedFiles = _reviewGitDeps.getUncommittedFiles;
  });

  afterEach(() => {
    _reviewRunnerDeps.which = originalWhich;
    _reviewRunnerDeps.file = originalFile;
    _reviewGitDeps.getUncommittedFiles = originalGetUncommittedFiles;
    mock.restore();
  });

  /** Mock package.json to be absent — no bun run script fallback */
  function mockNoPackageJson(): void {
    _reviewRunnerDeps.file = mock((_path: string) => ({
      text: () => Promise.reject(new Error("ENOENT: no such file")),
    }));
  }

  /** Mock package.json with given scripts */
  function mockPackageJson(scripts: Record<string, string>): void {
    _reviewRunnerDeps.file = mock((_path: string) => ({
      text: () => Promise.resolve(JSON.stringify({ scripts })),
    }));
  }

  // AC-1, AC-3, AC-4, AC-5
  test("AC-1+3+4+5: returns language-appropriate command when binary is available", async () => {
    const scenarios = [
      { ac: "AC-1", check: "test", language: "go", binary: "/usr/local/bin/go", expected: "go test ./..." },
      { ac: "AC-3", check: "test", language: "rust", binary: "/usr/local/bin/cargo", expected: "cargo test" },
      { ac: "AC-4", check: "test", language: "python", binary: "/usr/local/bin/pytest", expected: "pytest" },
      { ac: "AC-5", check: "typecheck", language: "go", binary: "/usr/local/bin/go", expected: "go vet ./..." },
    ] as const;
    for (const { ac, check, language, binary, expected } of scenarios) {
      _reviewRunnerDeps.which = mock((_name: string) => binary);
      mockNoPackageJson();
      const result = await resolveCommand(check, emptyConfig, undefined, "/tmp/workdir", undefined, { language });
      expect(result, ac).toBe(expected);
    }
  });

  // AC-2
  test("AC-2: returns null when binary not found; null when no profile provided (no regression)", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => null);
    mockNoPackageJson();
    expect(
      await resolveCommand("lint", emptyConfig, undefined, "/tmp/workdir", undefined, { language: "go" }),
    ).toBeNull();

    mockNoPackageJson();
    expect(await resolveCommand("test", emptyConfig, undefined, "/tmp/workdir", undefined, undefined)).toBeNull();
  });

  // AC-6
  test("AC-6: explicit config.review.commands.test takes precedence over language-aware fallback", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => "/usr/local/bin/go");
    mockNoPackageJson();

    const configWithExplicit: ReviewConfig = makeConfigSlice("review", {
      enabled: true,
      checks: [],
      commands: { test: "bun test --coverage" },
    });

    const result = await resolveCommand("test", configWithExplicit, undefined, "/tmp/workdir", undefined, {
      language: "go",
    });

    expect(result).toBe("bun test --coverage");
  });

  // AC-7
  test("AC-7: returns 'bun run test' for typescript when package.json has test script and no language binary found", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => null);
    mockPackageJson({ test: "bun test" });

    const result = await resolveCommand("test", emptyConfig, undefined, "/tmp/workdir", undefined, {
      language: "typescript",
    });

    expect(result).toBe("bun run test");
  });

  // Resolution order: language fallback comes before package.json script
  test("language fallback (step 4) takes priority over package.json bun run script (step 5)", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => "/usr/local/bin/go");
    mockPackageJson({ test: "custom-bun-test-runner" });

    const result = await resolveCommand("test", emptyConfig, undefined, "/tmp/workdir", undefined, {
      language: "go",
    });

    // Language command takes precedence — bun run fallback should NOT be used
    expect(result).toBe("go test ./...");
  });

  // quality.commands takes precedence over language fallback
  test("quality.commands[check] takes precedence over language-aware fallback", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => "/usr/local/bin/go");
    mockNoPackageJson();

    const qualityCommands = { test: "make test" };

    const result = await resolveCommand("test", emptyConfig, undefined, "/tmp/workdir", qualityCommands, {
      language: "go",
    });

    expect(result).toBe("make test");
  });
});
