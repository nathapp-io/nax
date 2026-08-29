/**
 * Unit tests for initPackage and generatePackageContextTemplate (MW-005)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { generatePackageContextTemplate, initPackage } from "@/cli/init-context";

describe("generatePackageContextTemplate (MW-005)", () => {
  test("uses the last path segment as package name", () => {
    const content = generatePackageContextTemplate("packages/api");
    expect(content).toContain("# api — Context");
  });

  test("uses single-segment path as package name", () => {
    const content = generatePackageContextTemplate("api");
    expect(content).toContain("# api — Context");
  });

  test("includes root context.md reference comment", () => {
    const content = generatePackageContextTemplate("packages/api");
    expect(content).toContain("Root context.md");
  });

  test("includes a Commands table with bun test", () => {
    const content = generatePackageContextTemplate("packages/api");
    expect(content).toContain("bun test");
  });

  test("includes Tech Stack and Development Guidelines sections", () => {
    const content = generatePackageContextTemplate("packages/web");
    expect(content).toContain("## Tech Stack");
    expect(content).toContain("## Development Guidelines");
  });
});

describe("initPackage (MW-005)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates nax/context.md in the package directory", async () => {
    await initPackage(tmpDir, "packages/api");
    const contextPath = join(tmpDir, ".nax/mono/packages/api/context.md");
    expect(await Bun.file(contextPath).exists()).toBe(true);
  });

  test("content includes package name from path", async () => {
    await initPackage(tmpDir, "packages/api");
    const content = await Bun.file(join(tmpDir, ".nax/mono/packages/api/context.md")).text();
    expect(content).toContain("# api — Context");
  });

  test("does not overwrite existing file when force=false", async () => {
    const contextPath = join(tmpDir, ".nax/mono/packages/api/context.md");
    await Bun.write(contextPath, "# Existing content");
    await initPackage(tmpDir, "packages/api", false);
    const content = await Bun.file(contextPath).text();
    expect(content).toBe("# Existing content");
  });

  test("overwrites existing file when force=true", async () => {
    const contextPath = join(tmpDir, ".nax/mono/packages/api/context.md");
    await Bun.write(contextPath, "# Existing content");
    await initPackage(tmpDir, "packages/api", true);
    const content = await Bun.file(contextPath).text();
    expect(content).not.toBe("# Existing content");
    expect(content).toContain("# api — Context");
  });

  test("creates intermediate directories", async () => {
    await initPackage(tmpDir, "apps/backend/service");
    const contextPath = join(tmpDir, ".nax/mono/apps/backend/service/context.md");
    expect(await Bun.file(contextPath).exists()).toBe(true);
  });

  test("rejects a packagePath that escapes the repo via '..' before creating any directory (US-002 AC #3)", async () => {
    await expect(initPackage(tmpDir, "../../evil")).rejects.toMatchObject({
      name: "NaxError",
      code: "INVALID_PACKAGE_PATH",
    });
    // The directory must NOT be created when validation rejects.
    expect(await Bun.file(join(tmpDir, ".nax/mono/evil/context.md")).exists()).toBe(false);
  });

  test("rejects an empty packagePath rather than resolving to the repo root (US-002 AC #6)", async () => {
    await expect(initPackage(tmpDir, "")).rejects.toMatchObject({
      name: "NaxError",
      code: "INVALID_PACKAGE_PATH",
    });
    const rootContext = join(tmpDir, ".nax", "context.md");
    // The pre-existing initContext file at <repoRoot>/.nax/context.md must NOT
    // be created by a stray empty packagePath.
    expect(await Bun.file(rootContext).exists()).toBe(false);
  });

  test("rejects an absolute packagePath before creating any directory", async () => {
    await expect(initPackage(tmpDir, "/etc")).rejects.toMatchObject({
      name: "NaxError",
      code: "INVALID_PACKAGE_PATH",
    });
  });
});
