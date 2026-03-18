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

// ─────────────────────────────────────────────────────────────────────────────
// discoverWorkspacePackages
// ─────────────────────────────────────────────────────────────────────────────

import { discoverWorkspacePackages } from "../../../src/context/generator";
import { mkdirSync, writeFileSync } from "node:fs";

describe("discoverWorkspacePackages", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-ws-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array when no workspace manifests found", async () => {
    const result = await discoverWorkspacePackages(tmpDir);
    expect(result).toEqual([]);
  });

  test("discovers packages from package.json workspaces array", async () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "monorepo",
      workspaces: ["packages/*"],
    }));
    mkdirSync(join(tmpDir, "packages", "api"), { recursive: true });
    writeFileSync(join(tmpDir, "packages", "api", "package.json"), JSON.stringify({ name: "api" }));
    mkdirSync(join(tmpDir, "packages", "web"), { recursive: true });
    writeFileSync(join(tmpDir, "packages", "web", "package.json"), JSON.stringify({ name: "web" }));

    const result = await discoverWorkspacePackages(tmpDir);
    expect(result).toContain("packages/api");
    expect(result).toContain("packages/web");
  });

  test("discovers packages from turbo.json packages field", async () => {
    writeFileSync(join(tmpDir, "turbo.json"), JSON.stringify({
      packages: ["apps/*"],
    }));
    mkdirSync(join(tmpDir, "apps", "dashboard"), { recursive: true });
    writeFileSync(join(tmpDir, "apps", "dashboard", "package.json"), JSON.stringify({ name: "dashboard" }));

    const result = await discoverWorkspacePackages(tmpDir);
    expect(result).toContain("apps/dashboard");
  });

  test("prefers nax/context.md packages over workspace manifest when both exist", async () => {
    // Set up nax/context.md in a package
    mkdirSync(join(tmpDir, "packages", "sdk", "nax"), { recursive: true });
    writeFileSync(join(tmpDir, "packages", "sdk", "nax", "context.md"), "# SDK Context");

    // Also set up workspace manifest pointing elsewhere
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      workspaces: ["packages/*"],
    }));
    mkdirSync(join(tmpDir, "packages", "other"), { recursive: true });
    writeFileSync(join(tmpDir, "packages", "other", "package.json"), JSON.stringify({ name: "other" }));

    const result = await discoverWorkspacePackages(tmpDir);
    // Should use nax/context.md discovery (absolute paths converted to relative)
    expect(result.some((p) => p.includes("sdk"))).toBe(true);
    // Should NOT fall through to workspace manifest
    expect(result.some((p) => p.includes("other"))).toBe(false);
  });

  test("skips directories without package.json", async () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      workspaces: ["packages/*"],
    }));
    // Create dir without package.json
    mkdirSync(join(tmpDir, "packages", "no-pkg"), { recursive: true });
    // Create dir with package.json
    mkdirSync(join(tmpDir, "packages", "with-pkg"), { recursive: true });
    writeFileSync(join(tmpDir, "packages", "with-pkg", "package.json"), JSON.stringify({ name: "with-pkg" }));

    const result = await discoverWorkspacePackages(tmpDir);
    expect(result).not.toContain("packages/no-pkg");
    expect(result).toContain("packages/with-pkg");
  });
});
