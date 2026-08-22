/**
 * Tests for src/cli/setup-fill.ts (US-004)
 *
 * Hermetic: all file I/O injected via _fillScriptsDeps.
 * AC5 uses real file ops within withTempDir.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { _analyzeRepoDeps, analyzeRepo } from "@/cli/setup-analyze";
import { _fillScriptsDeps, fillScripts } from "@/cli/setup-fill";
import type { RepoAnalysis } from "@/cli/setup-types";
import type { ProjectProfile } from "@/config";
import type { DetectionResult } from "@/test-runners/detect";
import { withTempDir } from "@test/helpers";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SINGLE_MISSING_TYPE_CHECK: RepoAnalysis = {
  shape: "single",
  packages: [{ relativeDir: "", testFramework: undefined, testFilePatterns: [], missingScripts: ["type-check"] }],
  pmRunPrefix: "bun run",
  pmDlx: "bunx",
  orchestrator: "none",
};

const MONO_TURBO_MISSING: RepoAnalysis = {
  shape: "mono",
  packages: [{ relativeDir: "packages/a", testFramework: "bun", testFilePatterns: [], missingScripts: ["type-check"] }],
  pmRunPrefix: "bun run",
  pmDlx: "bunx",
  orchestrator: "turbo",
};

// ─── Save / restore deps ───────────────────────────────────────────────────────

type FillDeps = typeof _fillScriptsDeps;
let savedFill: FillDeps;

beforeEach(() => {
  savedFill = { ..._fillScriptsDeps };
  _fillScriptsDeps.readJson = mock(async () => null);
  _fillScriptsDeps.writeFile = mock(async () => {});
});

afterEach(() => {
  Object.assign(_fillScriptsDeps, savedFill);
});

// ─── AC1: writes type-check script and preserves existing scripts ─────────────

describe("fillScripts — AC1: writes type-check script into package.json", () => {
  test("AC1: writes type-check equal to 'tsc --noEmit -p tsconfig.json'", async () => {
    _fillScriptsDeps.readJson = mock(
      async () =>
        ({
          scripts: { build: "tsc", test: "bun test" },
        }) as Record<string, unknown>,
    );

    const written = new Map<string, string>();
    _fillScriptsDeps.writeFile = mock(async (path: string, content: string) => {
      written.set(path, content);
    });

    await fillScripts("/work", SINGLE_MISSING_TYPE_CHECK);

    const pkgPath = "/work/package.json";
    expect(written.has(pkgPath)).toBe(true);
    const pkg = JSON.parse(written.get(pkgPath)!);
    expect(pkg.scripts["type-check"]).toBe("tsc --noEmit -p tsconfig.json");
  });

  test("AC1: existing scripts are preserved after fill", async () => {
    _fillScriptsDeps.readJson = mock(
      async () =>
        ({
          scripts: { build: "tsc", test: "bun test" },
        }) as Record<string, unknown>,
    );

    const written = new Map<string, string>();
    _fillScriptsDeps.writeFile = mock(async (path: string, content: string) => {
      written.set(path, content);
    });

    await fillScripts("/work", SINGLE_MISSING_TYPE_CHECK);

    const pkg = JSON.parse(written.get("/work/package.json")!);
    expect(pkg.scripts.build).toBe("tsc");
    expect(pkg.scripts.test).toBe("bun test");
  });
});

// ─── AC2: idempotent — second run does not duplicate ─────────────────────────

describe("fillScripts — AC2: idempotent on repeated runs", () => {
  test("AC2: writeFile is not called when type-check already present in the file", async () => {
    _fillScriptsDeps.readJson = mock(
      async () =>
        ({
          scripts: { "type-check": "tsc --noEmit -p tsconfig.json", build: "tsc" },
        }) as Record<string, unknown>,
    );

    await fillScripts("/work", SINGLE_MISSING_TYPE_CHECK);

    expect(_fillScriptsDeps.writeFile).not.toHaveBeenCalled();
  });

  test("AC2: package.json has single type-check key after two runs with mutable state", async () => {
    let diskPkg: Record<string, unknown> = { scripts: { build: "tsc" } };
    _fillScriptsDeps.readJson = mock(async () => diskPkg);
    _fillScriptsDeps.writeFile = mock(async (_path: string, content: string) => {
      diskPkg = JSON.parse(content) as Record<string, unknown>;
    });

    await fillScripts("/work", SINGLE_MISSING_TYPE_CHECK);
    await fillScripts("/work", SINGLE_MISSING_TYPE_CHECK);

    const scripts = diskPkg.scripts as Record<string, string>;
    const typeCheckEntries = Object.keys(scripts).filter((k) => k === "type-check");
    expect(typeCheckEntries).toHaveLength(1);
  });
});

// ─── AC3: mono + turbo → turbo.json task + root passthrough ──────────────────

describe("fillScripts — AC3: mono+turbo writes turbo.json and root passthrough", () => {
  test("AC3: adds type-check task to turbo.json pipeline", async () => {
    _fillScriptsDeps.readJson = mock(async (path: string) => {
      if (path.endsWith("turbo.json")) return { pipeline: { build: {} } } as Record<string, unknown>;
      return { scripts: {} } as Record<string, unknown>;
    });

    const written = new Map<string, string>();
    _fillScriptsDeps.writeFile = mock(async (path: string, content: string) => {
      written.set(path, content);
    });

    await fillScripts("/work", MONO_TURBO_MISSING);

    const turboPath = "/work/turbo.json";
    expect(written.has(turboPath)).toBe(true);
    const turbo = JSON.parse(written.get(turboPath)!);
    expect(turbo.pipeline["type-check"]).toBeDefined();
  });

  test("AC3: adds type-check task to turbo.json tasks when no pipeline key", async () => {
    _fillScriptsDeps.readJson = mock(async (path: string) => {
      if (path.endsWith("turbo.json")) return { tasks: { build: {} } } as Record<string, unknown>;
      return { scripts: {} } as Record<string, unknown>;
    });

    const written = new Map<string, string>();
    _fillScriptsDeps.writeFile = mock(async (path: string, content: string) => {
      written.set(path, content);
    });

    await fillScripts("/work", MONO_TURBO_MISSING);

    const turbo = JSON.parse(written.get("/work/turbo.json")!);
    expect(turbo.tasks["type-check"]).toBeDefined();
  });

  test("AC3: adds turbo passthrough script to root package.json", async () => {
    _fillScriptsDeps.readJson = mock(async (path: string) => {
      if (path.endsWith("turbo.json")) return { pipeline: {} } as Record<string, unknown>;
      return { scripts: {} } as Record<string, unknown>;
    });

    const written = new Map<string, string>();
    _fillScriptsDeps.writeFile = mock(async (path: string, content: string) => {
      written.set(path, content);
    });

    await fillScripts("/work", MONO_TURBO_MISSING);

    const rootPkgPath = "/work/package.json";
    expect(written.has(rootPkgPath)).toBe(true);
    const rootPkg = JSON.parse(written.get(rootPkgPath)!);
    expect(rootPkg.scripts["type-check"]).toBe("turbo run type-check");
  });
});

// ─── AC4: single shape writes only to root package.json ──────────────────────

describe("fillScripts — AC4: single shape writes to root package.json only", () => {
  test("AC4: writes exactly one file and it is root package.json", async () => {
    _fillScriptsDeps.readJson = mock(async () => ({ scripts: {} }) as Record<string, unknown>);

    const writtenPaths: string[] = [];
    _fillScriptsDeps.writeFile = mock(async (path: string) => {
      writtenPaths.push(path);
    });

    await fillScripts("/work", SINGLE_MISSING_TYPE_CHECK);

    expect(writtenPaths).toHaveLength(1);
    expect(writtenPaths[0]).toBe("/work/package.json");
  });

  test("AC4: does not write turbo.json for single shape", async () => {
    _fillScriptsDeps.readJson = mock(async () => ({ scripts: {} }) as Record<string, unknown>);

    const writtenPaths: string[] = [];
    _fillScriptsDeps.writeFile = mock(async (path: string) => {
      writtenPaths.push(path);
    });

    await fillScripts("/work", SINGLE_MISSING_TYPE_CHECK);

    expect(writtenPaths.some((p) => p.endsWith("turbo.json"))).toBe(false);
  });
});

// ─── AC5: re-analysis reflects filled scripts ─────────────────────────────────

describe("fillScripts — AC5: analyzeRepo no longer reports filled scripts as missing", () => {
  test("AC5: missingScripts excludes type-check after fillScripts runs on real fixture", async () => {
    // Restore real file ops for fillScripts within this test
    Object.assign(_fillScriptsDeps, savedFill);

    const savedAnalyze = { ..._analyzeRepoDeps };

    const EMPTY_DETECTION: DetectionResult = { patterns: [], confidence: "empty", sources: [] };
    const EMPTY_PROFILE: ProjectProfile = {
      language: undefined,
      type: undefined,
      testFramework: undefined,
      lintTool: undefined,
    };

    await withTempDir(async (dir) => {
      // Write fixture package.json without type-check
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { build: "tsc", test: "bun test" } }, null, 2),
      );

      const analysis: RepoAnalysis = {
        shape: "single",
        packages: [{ relativeDir: "", testFramework: undefined, testFilePatterns: [], missingScripts: ["type-check"] }],
        pmRunPrefix: "bun run",
        pmDlx: "bunx",
        orchestrator: "none",
      };

      // fillScripts uses real deps — writes to the temp dir
      await fillScripts(dir, analysis);

      // analyzeRepo with real readJson but mocked non-file deps
      _analyzeRepoDeps.fileExists = mock(async () => false);
      _analyzeRepoDeps.discoverWorkspacePackages = mock(async () => []);
      _analyzeRepoDeps.detectProjectProfile = mock(async () => ({ ...EMPTY_PROFILE }));
      _analyzeRepoDeps.detectTestFilePatternsForWorkspace = mock(async () => ({ "": EMPTY_DETECTION }));
      _analyzeRepoDeps.readJson = savedAnalyze.readJson;

      const result = await analyzeRepo(dir);
      expect(result.packages[0]?.missingScripts).not.toContain("type-check");
    });

    Object.assign(_analyzeRepoDeps, savedAnalyze);
  });
});
