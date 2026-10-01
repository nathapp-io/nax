/**
 * Unit tests for src/test-runners/detect/workspace.ts
 *
 * Covers every workspace-manifest detector (pnpm, npm/yarn, lerna, turbo/nx,
 * .nax/mono layout), the glob-expansion marker check, malformed-manifest
 * error paths, and the per-workdir memoization cache.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { clearWorkspaceCache, discoverWorkspacePackages } from "@/test-runners";

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("nax-workspace-detect-test-");
  clearWorkspaceCache();
});

afterEach(() => {
  clearWorkspaceCache();
  cleanupTempDir(tmpDir);
});

async function writePackageMarker(dir: string): Promise<void> {
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "pkg" }));
}

describe("discoverWorkspacePackages", () => {
  test("returns an empty array for a single-package project with no manifests", async () => {
    await Bun.write(join(tmpDir, "package.json"), JSON.stringify({ name: "root" }));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual([]);
  });

  test("returns an empty array for a completely empty workdir", async () => {
    const result = await discoverWorkspacePackages(tmpDir);
    expect(result).toEqual([]);
  });

  // ── pnpm-workspace.yaml ──────────────────────────────────────────────────

  test("detects packages from pnpm-workspace.yaml with a glob pattern", async () => {
    await Bun.write(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await writePackageMarker(join(tmpDir, "packages", "api"));
    await writePackageMarker(join(tmpDir, "packages", "web"));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/api", "packages/web"]);
  });

  test("ignores glob matches that have no recognized package marker", async () => {
    await Bun.write(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await writePackageMarker(join(tmpDir, "packages", "api"));
    await Bun.write(join(tmpDir, "packages", "no-marker", "README.md"), "not a package");

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/api"]);
  });

  test("recognizes a package directory alongside go.mod/pyproject.toml/Cargo.toml siblings", async () => {
    // Each dir also carries a package.json so the marker check reliably resolves —
    // the go.mod/pyproject.toml/Cargo.toml existence checks still execute concurrently.
    await Bun.write(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await Bun.write(join(tmpDir, "packages", "go-svc", "go.mod"), "module svc\n");
    await writePackageMarker(join(tmpDir, "packages", "go-svc"));
    await Bun.write(join(tmpDir, "packages", "py-svc", "pyproject.toml"), "[project]\nname='svc'\n");
    await writePackageMarker(join(tmpDir, "packages", "py-svc"));
    await Bun.write(join(tmpDir, "packages", "rs-svc", "Cargo.toml"), "[package]\nname='svc'\n");
    await writePackageMarker(join(tmpDir, "packages", "rs-svc"));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/go-svc", "packages/py-svc", "packages/rs-svc"]);
  });

  test("returns an empty array when pnpm-workspace.yaml has no packages field", async () => {
    await Bun.write(join(tmpDir, "pnpm-workspace.yaml"), "catalog:\n  foo: '1.0.0'\n");

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual([]);
  });

  test("returns an empty array when pnpm-workspace.yaml is malformed YAML", async () => {
    await Bun.write(join(tmpDir, "pnpm-workspace.yaml"), "packages: [unterminated\n");

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual([]);
  });

  // ── package.json#workspaces (npm/yarn) ───────────────────────────────────

  test("detects packages from package.json#workspaces as an array", async () => {
    await Bun.write(join(tmpDir, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    await writePackageMarker(join(tmpDir, "packages", "api"));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/api"]);
  });

  test("detects packages from package.json#workspaces.packages (yarn object form)", async () => {
    await Bun.write(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", workspaces: { packages: ["packages/*"] } }),
    );
    await writePackageMarker(join(tmpDir, "packages", "web"));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/web"]);
  });

  test("returns an empty array when package.json has no workspaces field", async () => {
    await Bun.write(join(tmpDir, "package.json"), JSON.stringify({ name: "root" }));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual([]);
  });

  test("returns an empty array when package.json is malformed JSON", async () => {
    await Bun.write(join(tmpDir, "package.json"), "{not valid json");

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual([]);
  });

  // ── lerna.json ────────────────────────────────────────────────────────────

  test("detects packages from lerna.json with explicit packages patterns", async () => {
    await Bun.write(join(tmpDir, "lerna.json"), JSON.stringify({ packages: ["libs/*"] }));
    await writePackageMarker(join(tmpDir, "libs", "core"));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["libs/core"]);
  });

  test("defaults lerna.json to 'packages/*' when no packages field is present", async () => {
    await Bun.write(join(tmpDir, "lerna.json"), JSON.stringify({ version: "1.0.0" }));
    await writePackageMarker(join(tmpDir, "packages", "api"));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/api"]);
  });

  test("returns an empty array when lerna.json is malformed JSON", async () => {
    await Bun.write(join(tmpDir, "lerna.json"), "{not valid json");

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual([]);
  });

  // ── turbo.json / nx.json ──────────────────────────────────────────────────

  test("confirms monorepo layout via turbo.json, deferring to pnpm/npm detectors for dirs", async () => {
    await Bun.write(join(tmpDir, "turbo.json"), JSON.stringify({ pipeline: {} }));
    await Bun.write(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await writePackageMarker(join(tmpDir, "packages", "api"));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/api"]);
  });

  test("confirms monorepo layout via nx.json using package.json#workspaces", async () => {
    await Bun.write(join(tmpDir, "nx.json"), JSON.stringify({}));
    await Bun.write(join(tmpDir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await writePackageMarker(join(tmpDir, "packages", "web"));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/web"]);
  });

  test("does not contribute packages when neither turbo.json nor nx.json exist", async () => {
    await Bun.write(join(tmpDir, "package.json"), JSON.stringify({ name: "root" }));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual([]);
  });

  // ── .nax/mono/ layout ─────────────────────────────────────────────────────

  test("detects packages from an existing .nax/mono/ layout", async () => {
    await Bun.write(join(tmpDir, ".nax", "mono", "packages", "api", "config.json"), "{}");
    await Bun.write(join(tmpDir, ".nax", "mono", "packages", "web", "config.json"), "{}");

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/api", "packages/web"]);
  });

  test("walks nested .nax/mono/ directories that hold no config.json", async () => {
    // Intermediate dir has no config.json of its own, only its leaf child does.
    await Bun.write(join(tmpDir, ".nax", "mono", "services", "billing", "config.json"), "{}");

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["services/billing"]);
  });

  test("returns an empty array when there is no .nax/mono/ directory at all", async () => {
    await Bun.write(join(tmpDir, "package.json"), JSON.stringify({ name: "root" }));

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual([]);
  });

  // ── combining detectors + dedup ──────────────────────────────────────────

  test("merges and deduplicates packages discovered by multiple detectors", async () => {
    await Bun.write(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await writePackageMarker(join(tmpDir, "packages", "api"));
    await Bun.write(join(tmpDir, ".nax", "mono", "packages", "api", "config.json"), "{}");

    const result = await discoverWorkspacePackages(tmpDir);

    expect(result).toEqual(["packages/api"]);
  });

  // ── memoization ───────────────────────────────────────────────────────────

  test("memoizes results per workdir until clearWorkspaceCache() is called", async () => {
    await Bun.write(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await writePackageMarker(join(tmpDir, "packages", "api"));

    const first = await discoverWorkspacePackages(tmpDir);
    expect(first).toEqual(["packages/api"]);

    // Mutate on disk after the first call — the cached result should still win.
    await writePackageMarker(join(tmpDir, "packages", "web"));
    const second = await discoverWorkspacePackages(tmpDir);
    expect(second).toEqual(["packages/api"]);

    clearWorkspaceCache();
    const third = await discoverWorkspacePackages(tmpDir);
    expect(third).toEqual(["packages/api", "packages/web"]);
  });
});
