/**
 * Unit tests for generateForPackage and discoverPackages (MW-004)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPackages, generateForPackage } from "../../../src/context/generator";
import type { NaxConfig } from "../../../src/config";

function makeConfig(): NaxConfig {
  return {} as unknown as NaxConfig;
}

describe("discoverPackages (MW-004)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array when no packages found", async () => {
    const packages = await discoverPackages(tmpDir);
    expect(packages).toEqual([]);
  });

  test("finds packages at one level deep (*/nax/context.md)", async () => {
    await Bun.write(join(tmpDir, "packages/api/nax/context.md"), "# API");
    const packages = await discoverPackages(tmpDir);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toBe(join(tmpDir, "packages/api"));
  });

  test("finds packages at two levels deep (*/*/nax/context.md)", async () => {
    await Bun.write(join(tmpDir, "apps/backend/nax/context.md"), "# Backend");
    const packages = await discoverPackages(tmpDir);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toBe(join(tmpDir, "apps/backend"));
  });

  test("finds multiple packages", async () => {
    await Bun.write(join(tmpDir, "packages/api/nax/context.md"), "# API");
    await Bun.write(join(tmpDir, "packages/web/nax/context.md"), "# Web");
    const packages = await discoverPackages(tmpDir);
    expect(packages).toHaveLength(2);
  });

  test("deduplicates packages found at multiple glob depths", async () => {
    // packages/api matches both patterns at 2 levels from root
    await Bun.write(join(tmpDir, "packages/api/nax/context.md"), "# API");
    const packages = await discoverPackages(tmpDir);
    // Should only appear once
    const unique = new Set(packages);
    expect(unique.size).toBe(packages.length);
  });
});

describe("generateForPackage (MW-004)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns error when nax/context.md does not exist", async () => {
    const result = await generateForPackage(tmpDir, makeConfig(), true);
    expect(result.error).toContain("context.md not found");
    expect(result.written).toBe(false);
  });

  test("dry run returns content without writing file", async () => {
    await Bun.write(join(tmpDir, "nax/context.md"), "# Package\n\nContent here.");
    const result = await generateForPackage(tmpDir, makeConfig(), true);
    expect(result.error).toBeUndefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.written).toBe(false);
    // File should NOT exist since dry run
    const outputFile = join(tmpDir, result.outputFile);
    expect(await Bun.file(outputFile).exists()).toBe(false);
  });

  test("writes CLAUDE.md when not dry run", async () => {
    await Bun.write(join(tmpDir, "nax/context.md"), "# Package\n\nContent here.");
    const result = await generateForPackage(tmpDir, makeConfig(), false);
    expect(result.error).toBeUndefined();
    expect(result.written).toBe(true);
    expect(result.outputFile).toBe("CLAUDE.md");
    const outputFile = join(tmpDir, "CLAUDE.md");
    expect(await Bun.file(outputFile).exists()).toBe(true);
  });

  test("returns packageDir in result", async () => {
    await Bun.write(join(tmpDir, "nax/context.md"), "# Package");
    const result = await generateForPackage(tmpDir, makeConfig(), true);
    expect(result.packageDir).toBe(tmpDir);
  });
});
