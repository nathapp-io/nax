/**
 * Unit tests for initPackage and generatePackageContextTemplate (MW-005)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePackageContextTemplate, initPackage } from "../../../src/cli/init-context";

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
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates nax/context.md in the package directory", async () => {
    await initPackage(tmpDir, "packages/api");
    const contextPath = join(tmpDir, ".nax/packages/packages/api/context.md");
    expect(await Bun.file(contextPath).exists()).toBe(true);
  });

  test("content includes package name from path", async () => {
    await initPackage(tmpDir, "packages/api");
    const content = await Bun.file(join(tmpDir, ".nax/packages/packages/api/context.md")).text();
    expect(content).toContain("# api — Context");
  });

  test("does not overwrite existing file when force=false", async () => {
    const contextPath = join(tmpDir, ".nax/packages/packages/api/context.md");
    await Bun.write(contextPath, "# Existing content");
    await initPackage(tmpDir, "packages/api", false);
    const content = await Bun.file(contextPath).text();
    expect(content).toBe("# Existing content");
  });

  test("overwrites existing file when force=true", async () => {
    const contextPath = join(tmpDir, ".nax/packages/packages/api/context.md");
    await Bun.write(contextPath, "# Existing content");
    await initPackage(tmpDir, "packages/api", true);
    const content = await Bun.file(contextPath).text();
    expect(content).not.toBe("# Existing content");
    expect(content).toContain("# api — Context");
  });

  test("creates intermediate directories", async () => {
    await initPackage(tmpDir, "apps/backend/service");
    const contextPath = join(tmpDir, ".nax/packages/apps/backend/service/context.md");
    expect(await Bun.file(contextPath).exists()).toBe(true);
  });
});
