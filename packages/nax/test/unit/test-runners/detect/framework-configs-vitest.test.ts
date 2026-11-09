/**
 * Tier 1 — Vitest / Vite config parsing (M15).
 *
 * `test.include` is read only from the top level of the `test: {}` block, so a
 * nested `coverage.include` — or an `include` outside any test block — is never
 * mistaken for the test-file pattern.
 *
 * The parsers themselves are file-local; the two entry points below
 * (`detectFromFrameworkConfigs`, `detectTestFilePatterns`) are the public seams.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { _cacheDeps } from "@/test-runners/detect/cache";
import { _directoryScanDeps } from "@/test-runners/detect/directory-scan";
import { _fileScanDeps } from "@/test-runners/detect/file-scan";
import { _frameworkConfigDeps, detectFromFrameworkConfigs } from "@/test-runners/detect/framework-configs";
import { _frameworkDefaultsDeps } from "@/test-runners/detect/framework-defaults";
import { detectTestFilePatterns } from "@/test-runners/detect/index";
import type { DetectionSource } from "@/test-runners/detect/types";

const WORKDIR = "/fake/workdir";

// ─── Save/restore helpers ─────────────────────────────────────────────────────

type Orig = {
  readText: typeof _frameworkConfigDeps.readText;
  defaultsReadText: typeof _frameworkDefaultsDeps.readText;
  defaultsFileExists: typeof _frameworkDefaultsDeps.fileExists;
  fileScanSpawn: typeof _fileScanDeps.spawn;
  cacheReadJson: typeof _cacheDeps.readJson;
  cacheWriteJson: typeof _cacheDeps.writeJson;
  cacheFileMtime: typeof _cacheDeps.fileMtime;
  dirExists: typeof _directoryScanDeps.dirExists;
  dirSpawn: typeof _directoryScanDeps.spawn;
};

let orig: Orig;

beforeEach(() => {
  orig = {
    readText: _frameworkConfigDeps.readText,
    defaultsReadText: _frameworkDefaultsDeps.readText,
    defaultsFileExists: _frameworkDefaultsDeps.fileExists,
    fileScanSpawn: _fileScanDeps.spawn,
    cacheReadJson: _cacheDeps.readJson,
    cacheWriteJson: _cacheDeps.writeJson,
    cacheFileMtime: _cacheDeps.fileMtime,
    dirExists: _directoryScanDeps.dirExists,
    dirSpawn: _directoryScanDeps.spawn,
  };
  // Cache isolation — a miss on read, a no-op write: nothing touches disk.
  _cacheDeps.readJson = mock(async () => {
    throw new Error("not found");
  });
  _cacheDeps.writeJson = mock(async () => {});
  _cacheDeps.fileMtime = mock(async () => null);
  // No manifest → Tier 2 stays silent; no test dirs → Tier 4 stays silent.
  _frameworkDefaultsDeps.readText = mock(async () => null);
  _frameworkDefaultsDeps.fileExists = mock(async () => false);
  _directoryScanDeps.dirExists = mock(async () => false);
  _directoryScanDeps.spawn = makeSpawn(() => ({ exitCode: 1 })).spawn;
  // Tier 3 — an empty `git ls-files` listing.
  _fileScanDeps.spawn = makeSpawn(() => "").spawn;
});

afterEach(() => {
  _frameworkConfigDeps.readText = orig.readText;
  _frameworkDefaultsDeps.readText = orig.defaultsReadText;
  _frameworkDefaultsDeps.fileExists = orig.defaultsFileExists;
  _fileScanDeps.spawn = orig.fileScanSpawn;
  _cacheDeps.readJson = orig.cacheReadJson;
  _cacheDeps.writeJson = orig.cacheWriteJson;
  _cacheDeps.fileMtime = orig.cacheFileMtime;
  _directoryScanDeps.dirExists = orig.dirExists;
  _directoryScanDeps.spawn = orig.dirSpawn;
});

/** Serve one config file per workdir; every other path is absent. */
function serveConfig(fileName: string, content: string): void {
  _frameworkConfigDeps.readText = mock(async (path: string) => (path.endsWith(fileName) ? content : null));
}

/** The vitest source among the Tier 1 sources, if any. */
function vitestSource(sources: DetectionSource[]): DetectionSource | undefined {
  return sources.find((s) => s.framework === "vitest");
}

// ─── Tier 1 sources ──────────────────────────────────────────────────────────

describe("detectFromFrameworkConfigs — vitest/vite config sources", () => {
  test("AC-1: a nested coverage.include is not read as the test-file pattern", async () => {
    serveConfig(
      "vitest.config.ts",
      `export default defineConfig({ test: { coverage: { include: ["src/**/*.ts"] } } })`,
    );

    const source = vitestSource(await detectFromFrameworkConfigs(WORKDIR));

    expect(source).toBeDefined();
    expect(source?.patterns).toEqual([]);
  });

  test("AC-4: an include outside any test block is not read", async () => {
    serveConfig("vitest.config.ts", `export default defineConfig({ plugins: [], include: ["src/**/*.ts"] })`);

    const source = vitestSource(await detectFromFrameworkConfigs(WORKDIR));

    expect(source).toBeDefined();
    expect(source?.patterns).toEqual([]);
  });

  test("AC-6: a vite config whose only include is nested yields no patterns", async () => {
    serveConfig("vite.config.ts", `export default defineConfig({ test: { coverage: { include: ["src/**/*.ts"] } } })`);

    const source = vitestSource(await detectFromFrameworkConfigs(WORKDIR));

    expect(source).toBeDefined();
    expect(source?.patterns).toEqual([]);
  });

  test("AC-7: a test block whose braces never close yields no patterns", async () => {
    serveConfig("vitest.config.ts", `export default defineConfig({ test: { include: ["test/**/*.test.ts"]`);

    const source = vitestSource(await detectFromFrameworkConfigs(WORKDIR));

    expect(source).toBeDefined();
    expect(source?.patterns).toEqual([]);
  });
});

// ─── Include forms ────────────────────────────────────────────────────────────

describe("detectFromFrameworkConfigs — include forms", () => {
  test.each([
    ["a variable", "include: myPatterns"],
    ["a spread", "include: [...myPatterns]"],
    ["a call", "include: getPatterns()"],
  ])("a non-literal test.include (%s) yields no patterns", async (_label, includeExpr) => {
    serveConfig("vitest.config.ts", `export default defineConfig({ test: { ${includeExpr} } })`);

    const source = vitestSource(await detectFromFrameworkConfigs(WORKDIR));

    expect(source).toBeDefined();
    expect(source?.patterns).toEqual([]);
  });

  test("a multi-line include array is still read", async () => {
    serveConfig(
      "vitest.config.ts",
      `export default defineConfig({
  test: {
    include: [
      "test/**/*.test.ts",
    ],
  },
});`,
    );

    const source = vitestSource(await detectFromFrameworkConfigs(WORKDIR));

    expect(source?.patterns).toEqual(["test/**/*.test.ts"]);
  });
});

// ─── Detected patterns ───────────────────────────────────────────────────────

describe("detectTestFilePatterns — vitest/vite config patterns", () => {
  test("AC-2: the top-level include wins over a nested coverage.include", async () => {
    serveConfig(
      "vitest.config.ts",
      `export default defineConfig({ test: { coverage: { include: ["src/**/*.ts"] }, include: ["test/**/*.test.ts"] } })`,
    );

    const result = await detectTestFilePatterns(WORKDIR);

    expect(result.patterns).toEqual(["test/**/*.test.ts"]);
  });

  test("AC-3: the top-level include is read when it comes first", async () => {
    serveConfig(
      "vitest.config.ts",
      `export default defineConfig({ test: { include: ["test/**/*.test.ts"], coverage: { include: ["src/**/*.ts"] } } })`,
    );

    const result = await detectTestFilePatterns(WORKDIR);

    expect(result.patterns).toEqual(["test/**/*.test.ts"]);
  });

  test("AC-5: a vite config reads the top-level include, not coverage.include", async () => {
    serveConfig(
      "vite.config.ts",
      `export default defineConfig({ test: { coverage: { include: ["src/**/*.ts"] }, include: ["test/**/*.test.ts"] } })`,
    );

    const result = await detectTestFilePatterns(WORKDIR);

    expect(result.patterns).toEqual(["test/**/*.test.ts"]);
  });
});
