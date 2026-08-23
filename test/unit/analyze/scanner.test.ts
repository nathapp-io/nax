/**
 * Unit tests for src/analyze/scanner.ts — scanSourceRoots()
 */

import { describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { join } from "node:path";
import { _scannerDeps, scanSourceRoots } from "@/analyze";
import type { Logger } from "@/logger";
import { makeLogger, withDepsRestore, withTempDir } from "@test/helpers";

// ── ACs 1 & 2: TypeScript single package ─────────────────────────────────────

describe("scanSourceRoots — single TypeScript package", () => {
  withDepsRestore(_scannerDeps);

  test("returns array of length 1", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "my-app", devDependencies: { typescript: "^5.0.0" } }),
      );
      const roots = await scanSourceRoots(dir);
      expect(roots).toHaveLength(1);
    });
  });

  test("single root has path '.' and language 'typescript'", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "my-app", devDependencies: { typescript: "^5.0.0" } }),
      );
      const [root] = await scanSourceRoots(dir);
      expect(root.path).toBe(".");
      expect(root.language).toBe("typescript");
    });
  });
});

// ── ACs 3 & 4: Workspace packages ────────────────────────────────────────────

describe("scanSourceRoots — workspace packages", () => {
  withDepsRestore(_scannerDeps);

  test("returns one SourceRoot per discovered package", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "packages/api/package.json"),
        JSON.stringify({ name: "api", devDependencies: { typescript: "^5.0.0" } }),
      );
      await Bun.write(
        join(dir, "packages/web/package.json"),
        JSON.stringify({ name: "web", devDependencies: { typescript: "^5.0.0", react: "^18.0.0" } }),
      );

      _scannerDeps.discoverWorkspacePackages = mock(() => Promise.resolve(["packages/api", "packages/web"]));

      const roots = await scanSourceRoots(dir);
      expect(roots).toHaveLength(2);
    });
  });

  test("each root has workspace-relative path and language resolved per package", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "packages/api/package.json"),
        JSON.stringify({ name: "api", devDependencies: { typescript: "^5.0.0" } }),
      );
      await Bun.write(join(dir, "packages/backend/go.mod"), "module example.com/backend\n\ngo 1.21\n");

      _scannerDeps.discoverWorkspacePackages = mock(() => Promise.resolve(["packages/api", "packages/backend"]));

      const roots = await scanSourceRoots(dir);

      const api = roots.find((r) => r.path === "packages/api");
      const backend = roots.find((r) => r.path === "packages/backend");

      expect(api?.path).toBe("packages/api");
      expect(api?.language).toBe("typescript");
      expect(backend?.path).toBe("packages/backend");
      expect(backend?.language).toBe("go");
    });
  });
});

// ── AC 5: Go single package ───────────────────────────────────────────────────

describe("scanSourceRoots — Go single package", () => {
  test("returns [{ path: '.', language: 'go', framework: '', testRunner: 'go-test' }]", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
      const roots = await scanSourceRoots(dir);
      expect(roots).toEqual([{ path: ".", language: "go", framework: "", testRunner: "go-test" }]);
    });
  });
});

// ── AC 6: Python single package ───────────────────────────────────────────────

describe("scanSourceRoots — Python single package", () => {
  test("returns [{ path: '.', language: 'python', framework: '', testRunner: 'pytest' }]", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), '[project]\nname = "my-app"\n');
      const roots = await scanSourceRoots(dir);
      expect(roots).toEqual([{ path: ".", language: "python", framework: "", testRunner: "pytest" }]);
    });
  });
});

// ── AC 7: No language markers ─────────────────────────────────────────────────

describe("scanSourceRoots — no language markers", () => {
  test("returns [{ path: '.', language: undefined, framework: '', testRunner: '' }]", async () => {
    await withTempDir(async (dir) => {
      const roots = await scanSourceRoots(dir);
      expect(roots).toEqual([{ path: ".", language: undefined, framework: "", testRunner: "" }]);
    });
  });
});

// ── ACs 8 & 9: Package count > 30 ────────────────────────────────────────────

describe("scanSourceRoots — package count exceeds 30", () => {
  withDepsRestore(_scannerDeps);

  test("returns at most 30 entries when discovered package count exceeds 30", async () => {
    await withTempDir(async (dir) => {
      const packages = Array.from({ length: 31 }, (_, i) => `packages/pkg${i}`);
      _scannerDeps.discoverWorkspacePackages = mock(() => Promise.resolve(packages));
      _scannerDeps.detectLanguage = mock(() => Promise.resolve(undefined));
      _scannerDeps.readPackageJson = mock(() => Promise.resolve(null));

      const roots = await scanSourceRoots(dir);
      expect(roots).toHaveLength(30);
    });
  });

  test("logs warning with count and truncatedTo fields when package count exceeds 30", async () => {
    await withTempDir(async (dir) => {
      const logger = makeLogger();
      const packages = Array.from({ length: 35 }, (_, i) => `packages/pkg${i}`);
      _scannerDeps.discoverWorkspacePackages = mock(() => Promise.resolve(packages));
      _scannerDeps.detectLanguage = mock(() => Promise.resolve(undefined));
      _scannerDeps.readPackageJson = mock(() => Promise.resolve(null));
      _scannerDeps.logger = () => logger;

      await scanSourceRoots(dir);

      const warnCall = logger.calls.find((c) => c.level === "warn");
      expect(warnCall).toBeDefined();
      expect(warnCall?.data).toMatchObject({ count: 35, truncatedTo: 30 });
    });
  });
});

// ── ACs 10 & 11: discoverWorkspacePackages rejects ───────────────────────────

describe("scanSourceRoots — discoverWorkspacePackages rejects", () => {
  withDepsRestore(_scannerDeps);

  test("returns the single-root fallback and does not throw when discoverWorkspacePackages rejects", async () => {
    await withTempDir(async (dir) => {
      _scannerDeps.discoverWorkspacePackages = mock(() => Promise.reject(new Error("network error")));
      _scannerDeps.detectLanguage = mock(() => Promise.resolve(undefined));
      _scannerDeps.readPackageJson = mock(() => Promise.resolve(null));
      _scannerDeps.logger = () => ({ warn: () => {} });

      const roots = await scanSourceRoots(dir);
      expect(roots).toHaveLength(1);
      expect(roots[0].path).toBe(".");
    });
  });

  test("logs warning with the error message when discoverWorkspacePackages rejects", async () => {
    await withTempDir(async (dir) => {
      const logger = makeLogger();
      const errorMessage = "workspace detection failed";
      _scannerDeps.discoverWorkspacePackages = mock(() => Promise.reject(new Error(errorMessage)));
      _scannerDeps.detectLanguage = mock(() => Promise.resolve(undefined));
      _scannerDeps.readPackageJson = mock(() => Promise.resolve(null));
      _scannerDeps.logger = () => logger;

      await scanSourceRoots(dir);

      const warnCall = logger.calls.find((c) => c.level === "warn");
      expect(warnCall).toBeDefined();
      expect(warnCall?.data?.error).toBe(errorMessage);
    });
  });
});
