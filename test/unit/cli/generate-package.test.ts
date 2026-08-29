/**
 * Unit tests for the `package` option boundary in `generateCommand` (US-002).
 *
 * Validates that an absolute or otherwise unsafe `package` option is rejected
 * with a `NaxError` rather than silently reinterpreted as a repo-relative
 * directory.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { generateCommand } from "@/cli/generate";

describe("generateCommand — US-002 package option validation", () => {
  let tmpDir: string;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-gen-pkg-test-");
    mkdirSync(join(tmpDir, ".nax"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax/context.md"), "# Context");

    // Mock process.exit so generateCommand's failure paths throw instead of
    // killing the test runner — once validation rejects with NaxError, we
    // want that to surface as a normal exception.
    originalExit = process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockProcessExit(): void {
    process.exit = mock((code?: number): never => {
      throw new Error(`process.exit(${code ?? 1})`);
    }) as typeof process.exit;
  }

  test("rejects absolute --package /etc with NaxError rather than reinterpreting as repo-relative (US-002 AC #4)", async () => {
    mockProcessExit();

    let caught: unknown = null;
    try {
      await generateCommand({ dir: tmpDir, package: "/etc" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught).toMatchObject({ name: "NaxError", code: "INVALID_PACKAGE_PATH" });

    // The repo-relative "etc" directory must NOT have been created.
    expect(await Bun.file(join(tmpDir, "etc")).exists()).toBe(false);
  });

  test("rejects --package that escapes the repo via '..' before generating", async () => {
    mockProcessExit();

    let caught: unknown = null;
    try {
      await generateCommand({ dir: tmpDir, package: "../evil" });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught).toMatchObject({ name: "NaxError", code: "INVALID_PACKAGE_PATH" });
  });
});
