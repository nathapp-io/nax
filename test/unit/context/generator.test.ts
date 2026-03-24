/**
 * Unit tests for generateForPackage and discoverPackages (MW-004)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _generatorDeps, discoverPackages, generateForPackage } from "../../../src/context/generator";
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

  test("finds packages at one level deep (.nax/mono/*/context.md)", async () => {
    await Bun.write(join(tmpDir, ".nax/mono/api/context.md"), "# API");
    const packages = await discoverPackages(tmpDir);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toBe(join(tmpDir, "api"));
  });

  test("finds packages at two levels deep (.nax/mono/*/*/context.md)", async () => {
    await Bun.write(join(tmpDir, ".nax/mono/apps/backend/context.md"), "# Backend");
    const packages = await discoverPackages(tmpDir);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toBe(join(tmpDir, "apps/backend"));
  });

  test("finds multiple packages", async () => {
    await Bun.write(join(tmpDir, ".nax/mono/api/context.md"), "# API");
    await Bun.write(join(tmpDir, ".nax/mono/web/context.md"), "# Web");
    const packages = await discoverPackages(tmpDir);
    expect(packages).toHaveLength(2);
  });

  test("deduplicates packages found at multiple glob depths", async () => {
    // apps/api matches the two-level pattern only
    await Bun.write(join(tmpDir, ".nax/mono/apps/api/context.md"), "# API");
    const packages = await discoverPackages(tmpDir);
    // Should only appear once
    const unique = new Set(packages);
    expect(unique.size).toBe(packages.length);
  });
});

describe("generateForPackage (MW-004)", () => {
  // Uses _generatorDeps mocks — no real file I/O, parallel-safe.
  let origDeps: typeof _generatorDeps;

  beforeEach(() => {
    origDeps = { ..._generatorDeps };
    // Default: context.md not found, no metadata, no writes
    _generatorDeps.existsSync = mock(() => false);
    _generatorDeps.readTextFile = mock(() => Promise.resolve(""));
    _generatorDeps.writeFile = mock(() => Promise.resolve(0));
    _generatorDeps.buildProjectMetadata = mock(() => Promise.resolve(undefined as never));
  });

  afterEach(() => {
    Object.assign(_generatorDeps, origDeps);
    mock.restore();
  });

  test("returns error when context.md does not exist", async () => {
    // existsSync already mocked to return false in beforeEach
    const results = await generateForPackage("/fake/dir", makeConfig(), true, "/fake/dir");
    expect(results).toHaveLength(1);
    expect(results[0].error).toContain("context.md not found");
    expect(results[0].written).toBe(false);
  });

  test("dry run returns content without writing file", async () => {
    _generatorDeps.existsSync = mock(() => true);
    _generatorDeps.readTextFile = mock(() => Promise.resolve("# Package\n\nContent here."));
    const writeMock = mock(() => Promise.resolve(0));
    _generatorDeps.writeFile = writeMock;

    const results = await generateForPackage("/fake/dir", makeConfig(), true, "/fake/dir");
    const result = results[0];
    expect(result.error).toBeUndefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.written).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("writes CLAUDE.md when not dry run (default agents)", async () => {
    _generatorDeps.existsSync = mock(() => true);
    _generatorDeps.readTextFile = mock(() => Promise.resolve("# Package\n\nContent here."));
    const writeMock = mock(() => Promise.resolve(0));
    _generatorDeps.writeFile = writeMock;

    const results = await generateForPackage("/fake/dir", makeConfig(), false);
    expect(results).toHaveLength(1);
    expect(results[0].error).toBeUndefined();
    expect(results[0].written).toBe(true);
    expect(results[0].outputFile).toBe("CLAUDE.md");
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  test("returns packageDir in result", async () => {
    _generatorDeps.existsSync = mock(() => true);
    _generatorDeps.readTextFile = mock(() => Promise.resolve("# Package"));
    _generatorDeps.writeFile = mock(() => Promise.resolve(0));

    const results = await generateForPackage("/fake/dir", makeConfig(), true, "/fake/dir");
    expect(results[0].packageDir).toBe("/fake/dir");
  });

  test("generates for all config.generate.agents when set", async () => {
    _generatorDeps.existsSync = mock(() => true);
    _generatorDeps.readTextFile = mock(() => Promise.resolve("# Package\n\nContent."));
    const writeMock = mock(() => Promise.resolve(0));
    _generatorDeps.writeFile = writeMock;

    const config = { generate: { agents: ["claude", "codex"] } } as unknown as NaxConfig;
    const results = await generateForPackage("/fake/dir", config, false);
    expect(results).toHaveLength(2);
    const outputFiles = results.map((r) => r.outputFile);
    expect(outputFiles).toContain("CLAUDE.md");
    expect(outputFiles).toContain("codex.md");
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(results.every((r) => r.written === true)).toBe(true);
    expect(writeMock).toHaveBeenCalledTimes(2);
  });

  test("defaults to claude only when config.generate.agents is not set", async () => {
    _generatorDeps.existsSync = mock(() => true);
    _generatorDeps.readTextFile = mock(() => Promise.resolve("# Package"));
    _generatorDeps.writeFile = mock(() => Promise.resolve(0));

    const results = await generateForPackage("/fake/dir", makeConfig(), true, "/fake/dir");
    expect(results).toHaveLength(1);
    expect(results[0].outputFile).toBe("CLAUDE.md");
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
    // Set up .nax/mono/packages/sdk/context.md (new structure)
    mkdirSync(join(tmpDir, ".nax", "mono", "packages", "sdk"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "mono", "packages", "sdk", "context.md"), "# SDK Context");

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
