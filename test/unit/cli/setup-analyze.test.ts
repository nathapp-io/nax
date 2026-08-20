/**
 * Unit tests for src/cli/setup-analyze.ts
 *
 * Tests are fully hermetic: all file I/O and external calls are injected via
 * _analyzeRepoDeps and replaced with mock functions in beforeEach/afterEach.
 * No real disk access or process spawning occurs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _analyzeRepoDeps, analyzeRepo } from "@/cli/setup-analyze";
import type { DetectionResult } from "@/test-runners/detect";
import type { ProjectProfile } from "@/config";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_DETECTION: DetectionResult = { patterns: [], confidence: "empty", sources: [] };

const EMPTY_PROFILE: ProjectProfile = {
  language: undefined,
  type: undefined,
  testFramework: undefined,
  lintTool: undefined,
};

// ─── Save / restore original deps ────────────────────────────────────────────

type Deps = typeof _analyzeRepoDeps;
let saved: Deps;

beforeEach(() => {
  saved = { ..._analyzeRepoDeps };

  _analyzeRepoDeps.fileExists = mock(async () => false);
  _analyzeRepoDeps.readJson = mock(async () => null);
  _analyzeRepoDeps.discoverWorkspacePackages = mock(async () => []);
  _analyzeRepoDeps.detectProjectProfile = mock(async () => ({ ...EMPTY_PROFILE }));
  _analyzeRepoDeps.detectTestFilePatternsForWorkspace = mock(async () => ({
    "": EMPTY_DETECTION,
  }));
});

afterEach(() => {
  Object.assign(_analyzeRepoDeps, saved);
});

// ─── AC1: single package shape ────────────────────────────────────────────────

describe("analyzeRepo — AC1: single-package fixture", () => {
  test("returns shape 'single' and packages of length 1 when no workspace packages discovered", async () => {
    _analyzeRepoDeps.discoverWorkspacePackages = mock(async () => []);
    const result = await analyzeRepo("/repo");
    expect(result.shape).toBe("single");
    expect(result.packages).toHaveLength(1);
  });
});

// ─── AC2: mono shape with N packages ─────────────────────────────────────────

describe("analyzeRepo — AC2: mono fixture with N member packages", () => {
  test("returns shape 'mono' and packages array of length N", async () => {
    const pkgDirs = ["packages/a", "packages/b", "packages/c"];
    _analyzeRepoDeps.discoverWorkspacePackages = mock(async () => pkgDirs);
    _analyzeRepoDeps.detectTestFilePatternsForWorkspace = mock(async () =>
      Object.fromEntries(pkgDirs.map((d) => [d, EMPTY_DETECTION])),
    );
    const result = await analyzeRepo("/repo");
    expect(result.shape).toBe("mono");
    expect(result.packages).toHaveLength(3);
  });
});

// ─── AC3: bun.lock → bun run / bunx ──────────────────────────────────────────

describe("analyzeRepo — AC3: bun.lock lockfile", () => {
  test("returns pmRunPrefix 'bun run' and pmDlx 'bunx'", async () => {
    _analyzeRepoDeps.fileExists = mock(async (path: string) => path.endsWith("bun.lock"));
    const result = await analyzeRepo("/repo");
    expect(result.pmRunPrefix).toBe("bun run");
    expect(result.pmDlx).toBe("bunx");
  });
});

// ─── AC4: package-lock.json → npm run / npx ──────────────────────────────────

describe("analyzeRepo — AC4: package-lock.json lockfile", () => {
  test("returns pmRunPrefix 'npm run' and pmDlx 'npx'", async () => {
    _analyzeRepoDeps.fileExists = mock(async (path: string) => path.endsWith("package-lock.json"));
    const result = await analyzeRepo("/repo");
    expect(result.pmRunPrefix).toBe("npm run");
    expect(result.pmDlx).toBe("npx");
  });
});

// ─── AC5: missing scripts ─────────────────────────────────────────────────────

describe("analyzeRepo — AC5: missingScripts detection", () => {
  test("includes 'type-check' and 'lint:fix' when absent from package.json scripts", async () => {
    _analyzeRepoDeps.readJson = mock(async () => ({
      scripts: { build: "bun run build", test: "bun test", lint: "bun run lint" },
    }));
    const result = await analyzeRepo("/repo");
    expect(result.packages[0]!.missingScripts).toContain("type-check");
    expect(result.packages[0]!.missingScripts).toContain("lint:fix");
  });

  test("does not include scripts that are present in package.json", async () => {
    _analyzeRepoDeps.readJson = mock(async () => ({
      scripts: {
        build: "bun run build",
        test: "bun test",
        lint: "bun run lint",
        "type-check": "tsc --noEmit",
        "lint:fix": "bun run lint:fix",
      },
    }));
    const result = await analyzeRepo("/repo");
    expect(result.packages[0]!.missingScripts).not.toContain("type-check");
    expect(result.packages[0]!.missingScripts).not.toContain("lint:fix");
  });
});

// ─── AC6: turbo.json → orchestrator "turbo" ──────────────────────────────────

describe("analyzeRepo — AC6: turbo.json orchestrator", () => {
  test("returns orchestrator 'turbo' when turbo.json is present", async () => {
    _analyzeRepoDeps.fileExists = mock(async (path: string) => path.endsWith("turbo.json"));
    const result = await analyzeRepo("/repo");
    expect(result.orchestrator).toBe("turbo");
  });
});

// ─── AC7: no orchestrator config → "none" ────────────────────────────────────

describe("analyzeRepo — AC7: no orchestrator config", () => {
  test("returns orchestrator 'none' when neither turbo.json nor nx.json exist", async () => {
    _analyzeRepoDeps.fileExists = mock(async () => false);
    const result = await analyzeRepo("/repo");
    expect(result.orchestrator).toBe("none");
  });
});

// ─── AC8: jest testFramework + testFilePatterns from detection ────────────────

describe("analyzeRepo — AC8: jest testFramework and testFilePatterns", () => {
  test("PackageFacts.testFramework is 'jest' and testFilePatterns matches detection result", async () => {
    const jestDetection: DetectionResult = {
      patterns: ["**/*.test.js", "**/*.spec.js"],
      confidence: "medium",
      sources: [
        {
          type: "manifest",
          path: "package.json",
          patterns: ["**/*.test.js", "**/*.spec.js"],
          framework: "jest",
        },
      ],
    };
    _analyzeRepoDeps.detectProjectProfile = mock(async () => ({
      language: "javascript" as const,
      type: undefined,
      testFramework: "jest",
      lintTool: undefined,
    }));
    _analyzeRepoDeps.detectTestFilePatternsForWorkspace = mock(async () => ({
      "": jestDetection,
    }));
    const result = await analyzeRepo("/repo");
    expect(result.packages[0]!.testFramework).toBe("jest");
    expect(result.packages[0]!.testFilePatterns).toEqual(jestDetection.patterns);
  });
});

// ─── AC9: relativeDir is relative, not absolute ───────────────────────────────

describe("analyzeRepo — AC9: relativeDir is relative", () => {
  test("PackageFacts.relativeDir is 'packages/foo' and is not an absolute path", async () => {
    _analyzeRepoDeps.discoverWorkspacePackages = mock(async () => ["packages/foo"]);
    _analyzeRepoDeps.detectTestFilePatternsForWorkspace = mock(async () => ({
      "packages/foo": EMPTY_DETECTION,
    }));
    const result = await analyzeRepo("/repo");
    const fooFacts = result.packages.find((p) => p.relativeDir === "packages/foo");
    expect(fooFacts).toBeDefined();
    expect(fooFacts!.relativeDir).toBe("packages/foo");
    expect(fooFacts!.relativeDir.startsWith("/")).toBe(false);
  });
});
