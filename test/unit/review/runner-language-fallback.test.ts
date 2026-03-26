/**
 * Unit tests for US-004: Language-aware command fallback in review runner
 *
 * Tests cover:
 * - resolveLanguageCommand() lookup table + binary availability check
 * - resolveCommand() language-aware fallback as step 4 in resolution order
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _reviewGitDeps,
  _reviewRunnerDeps,
  resolveCommand,
  resolveLanguageCommand,
} from "../../../src/review/runner";
import type { ReviewConfig } from "../../../src/review/types";

/** Minimal ReviewConfig with no explicit commands — lets fallback logic run */
const emptyConfig: ReviewConfig = {
  enabled: true,
  checks: [],
  commands: {},
};

// ---------------------------------------------------------------------------
// resolveLanguageCommand — lookup table + binary check
// ---------------------------------------------------------------------------

describe("resolveLanguageCommand — language command table", () => {
  afterEach(() => {
    mock.restore();
  });

  describe("Go language", () => {
    test("returns 'go test ./...' for 'test' check when go binary is available", () => {
      const mockWhich = mock((_name: string) => "/usr/local/bin/go");
      const result = resolveLanguageCommand("go", "test", mockWhich);
      expect(result).toBe("go test ./...");
    });

    test("returns 'golangci-lint run' for 'lint' check when golangci-lint is available", () => {
      const mockWhich = mock((_name: string) => "/usr/local/bin/golangci-lint");
      const result = resolveLanguageCommand("go", "lint", mockWhich);
      expect(result).toBe("golangci-lint run");
    });

    test("returns 'go vet ./...' for 'typecheck' check when go binary is available", () => {
      const mockWhich = mock((_name: string) => "/usr/local/bin/go");
      const result = resolveLanguageCommand("go", "typecheck", mockWhich);
      expect(result).toBe("go vet ./...");
    });

    test("returns null for 'lint' check when golangci-lint binary is not found", () => {
      const mockWhich = mock((_name: string) => null);
      const result = resolveLanguageCommand("go", "lint", mockWhich);
      expect(result).toBeNull();
    });

    test("returns null for 'test' check when go binary is not found", () => {
      const mockWhich = mock((_name: string) => null);
      const result = resolveLanguageCommand("go", "test", mockWhich);
      expect(result).toBeNull();
    });
  });

  describe("Rust language", () => {
    test("returns 'cargo test' for 'test' check when cargo binary is available", () => {
      const mockWhich = mock((_name: string) => "/usr/local/bin/cargo");
      const result = resolveLanguageCommand("rust", "test", mockWhich);
      expect(result).toBe("cargo test");
    });

    test("returns 'cargo clippy -- -D warnings' for 'lint' check when cargo is available", () => {
      const mockWhich = mock((_name: string) => "/usr/local/bin/cargo");
      const result = resolveLanguageCommand("rust", "lint", mockWhich);
      expect(result).toBe("cargo clippy -- -D warnings");
    });

    test("returns null for 'test' check when cargo binary is not found", () => {
      const mockWhich = mock((_name: string) => null);
      const result = resolveLanguageCommand("rust", "test", mockWhich);
      expect(result).toBeNull();
    });
  });

  describe("Python language", () => {
    test("returns 'pytest' for 'test' check when pytest binary is available", () => {
      const mockWhich = mock((_name: string) => "/usr/local/bin/pytest");
      const result = resolveLanguageCommand("python", "test", mockWhich);
      expect(result).toBe("pytest");
    });

    test("returns 'ruff check .' for 'lint' check when ruff binary is available", () => {
      const mockWhich = mock((_name: string) => "/usr/local/bin/ruff");
      const result = resolveLanguageCommand("python", "lint", mockWhich);
      expect(result).toBe("ruff check .");
    });

    test("returns 'mypy .' for 'typecheck' check when mypy binary is available", () => {
      const mockWhich = mock((_name: string) => "/usr/local/bin/mypy");
      const result = resolveLanguageCommand("python", "typecheck", mockWhich);
      expect(result).toBe("mypy .");
    });

    test("returns null for 'lint' check when ruff binary is not found", () => {
      const mockWhich = mock((_name: string) => null);
      const result = resolveLanguageCommand("python", "lint", mockWhich);
      expect(result).toBeNull();
    });
  });

  describe("unsupported language", () => {
    test("returns null for unsupported language (ruby)", () => {
      const mockWhich = mock((_name: string) => "/usr/bin/ruby");
      const result = resolveLanguageCommand("ruby", "test", mockWhich);
      expect(result).toBeNull();
    });

    test("returns null for empty language string", () => {
      const mockWhich = mock((_name: string) => "/usr/bin/something");
      const result = resolveLanguageCommand("", "test", mockWhich);
      expect(result).toBeNull();
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
    })) as typeof _reviewRunnerDeps.file;
  }

  /** Mock package.json with given scripts */
  function mockPackageJson(scripts: Record<string, string>): void {
    _reviewRunnerDeps.file = mock((_path: string) => ({
      text: () => Promise.resolve(JSON.stringify({ scripts })),
    })) as typeof _reviewRunnerDeps.file;
  }

  // AC-1
  test("AC-1: returns 'go test ./...' for test/go when go binary is available and no explicit config", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => "/usr/local/bin/go");
    mockNoPackageJson();

    const result = await resolveCommand("test", emptyConfig, undefined, "/tmp/workdir", undefined, {
      language: "go",
    });

    expect(result).toBe("go test ./...");
  });

  // AC-2
  test("AC-2: returns null for lint/go when golangci-lint binary is not found via Bun.which()", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => null);
    mockNoPackageJson();

    const result = await resolveCommand("lint", emptyConfig, undefined, "/tmp/workdir", undefined, {
      language: "go",
    });

    expect(result).toBeNull();
  });

  // AC-3
  test("AC-3: returns 'cargo test' for test/rust when cargo binary is available", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => "/usr/local/bin/cargo");
    mockNoPackageJson();

    const result = await resolveCommand("test", emptyConfig, undefined, "/tmp/workdir", undefined, {
      language: "rust",
    });

    expect(result).toBe("cargo test");
  });

  // AC-4
  test("AC-4: returns 'pytest' for test/python when pytest binary is available", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => "/usr/local/bin/pytest");
    mockNoPackageJson();

    const result = await resolveCommand("test", emptyConfig, undefined, "/tmp/workdir", undefined, {
      language: "python",
    });

    expect(result).toBe("pytest");
  });

  // AC-5
  test("AC-5: returns 'go vet ./...' for typecheck/go when go binary is available", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => "/usr/local/bin/go");
    mockNoPackageJson();

    const result = await resolveCommand("typecheck", emptyConfig, undefined, "/tmp/workdir", undefined, {
      language: "go",
    });

    expect(result).toBe("go vet ./...");
  });

  // AC-6
  test("AC-6: explicit config.review.commands.test takes precedence over language-aware fallback", async () => {
    _reviewRunnerDeps.which = mock((_name: string) => "/usr/local/bin/go");
    mockNoPackageJson();

    const configWithExplicit: ReviewConfig = {
      enabled: true,
      checks: [],
      commands: { test: "bun test --coverage" },
    };

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

  // No profile provided — existing behavior unchanged (no regression)
  test("returns null when no profile, no explicit config, and no package.json script (no regression)", async () => {
    mockNoPackageJson();

    const result = await resolveCommand("test", emptyConfig, undefined, "/tmp/workdir", undefined, undefined);

    expect(result).toBeNull();
  });
});
