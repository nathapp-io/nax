// RE-ARCH: keep
/**
 * Smart Test Runner — discovery, package scoping, and git-failure handling
 *
 * Tests:
 * - Pass 1: path convention mapping (mapSourceToTests)
 * - Pass 2: import-grep fallback (importGrepFallback)
 * - Pass 3: full-suite fallback
 * - Custom testFilePatterns
 * - packagePrefix / co-located test discovery (testFilePatterns)
 * - US-001: surface swallowed git failures
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withWarnSpy } from "@test/helpers";
import {
  _gitUtilDeps,
  clearGitRootCache,
  getChangedNonTestFiles,
  getChangedTestFiles,
  importGrepFallback,
  mapSourceToTests,
} from "@/verification/smart-runner";

function mockFileExists(existingPaths: string[]) {
  Object.assign(Bun, {
    file: (path: string) => ({
      exists: () => Promise.resolve(existingPaths.includes(path)),
    }),
  });
}

describe("Pass 1: mapSourceToTests (path convention)", () => {
  let originalFile: typeof Bun.file;

  beforeEach(() => {
    originalFile = Bun.file;
  });

  afterEach(() => {
    Object.assign(Bun, { file: originalFile });
  });

  test("maps src/foo/bar.ts to test/unit/foo/bar.test.ts", async () => {
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);
    const result = await mapSourceToTests(["src/foo/bar.ts"], "/repo");
    expect(result).toEqual(["/repo/test/unit/foo/bar.test.ts"]);
  });

  test("also checks test/integration/ path", async () => {
    mockFileExists(["/repo/test/integration/foo/bar.test.ts"]);
    const result = await mapSourceToTests(["src/foo/bar.ts"], "/repo");
    expect(result).toEqual(["/repo/test/integration/foo/bar.test.ts"]);
  });

  test("returns empty array when no test files exist (triggers Pass 2 at caller)", async () => {
    mockFileExists([]);
    const result = await mapSourceToTests(["src/routing/strategies/llm.ts"], "/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array for empty sourceFiles", async () => {
    mockFileExists([]);
    const result = await mapSourceToTests([], "/repo");
    expect(result).toEqual([]);
  });

  // ── Identity guard (#1207): a suffix-only pattern like "tests/**/*.py"
  // degrades to suffix ".py", whose co-located candidate reconstructs the
  // source file itself. The source file must never be returned as its own test.
  test("never maps a source file to itself (Python suffix degeneration)", async () => {
    mockFileExists(["/repo/src/stock_api/_agent.py"]);
    const result = await mapSourceToTests(["src/stock_api/_agent.py"], "/repo", undefined, ["tests/**/*.py"]);
    expect(result).toEqual([]);
  });

  test("never maps a source file to itself with packagePrefix (monorepo)", async () => {
    mockFileExists(["/repo/apps/api/src/stock_api/_agent.py"]);
    const result = await mapSourceToTests(["apps/api/src/stock_api/_agent.py"], "/repo", "apps/api", ["tests/**/*.py"]);
    expect(result).toEqual([]);
  });

  // ── Prefix patterns (#1207): pytest's test_*.py convention is prefix-based;
  // candidates must carry the basename prefix, not just a suffix.
  test("prefix pattern maps to mirrored test under derived test dir", async () => {
    mockFileExists(["/repo/tests/stock_api/_tools/test_sizing.py"]);
    const result = await mapSourceToTests(["src/stock_api/_tools/sizing.py"], "/repo", undefined, [
      "tests/**/test_*.py",
    ]);
    expect(result).toEqual(["/repo/tests/stock_api/_tools/test_sizing.py"]);
  });

  test("prefix pattern maps to flat test under derived test dir", async () => {
    mockFileExists(["/repo/tests/test_sizing.py"]);
    const result = await mapSourceToTests(["src/stock_api/_tools/sizing.py"], "/repo", undefined, [
      "tests/**/test_*.py",
    ]);
    expect(result).toEqual(["/repo/tests/test_sizing.py"]);
  });

  test("prefix pattern maps to co-located test next to the source", async () => {
    mockFileExists(["/repo/src/stock_api/_tools/test_sizing.py"]);
    const result = await mapSourceToTests(["src/stock_api/_tools/sizing.py"], "/repo", undefined, ["test_*.py"]);
    expect(result).toEqual(["/repo/src/stock_api/_tools/test_sizing.py"]);
  });

  test("prefix pattern maps under packagePrefix (monorepo)", async () => {
    mockFileExists(["/repo/apps/api/tests/stock_api/_tools/test_sizing.py"]);
    const result = await mapSourceToTests(["apps/api/src/stock_api/_tools/sizing.py"], "/repo", "apps/api", [
      "tests/**/test_*.py",
    ]);
    expect(result).toEqual(["/repo/apps/api/tests/stock_api/_tools/test_sizing.py"]);
  });

  test("suffix pattern also probes test dirs derived from the glob (tests/ mirror)", async () => {
    mockFileExists(["/repo/tests/foo/bar_test.py"]);
    const result = await mapSourceToTests(["src/foo/bar.py"], "/repo", undefined, ["tests/**/*_test.py"]);
    expect(result).toEqual(["/repo/tests/foo/bar_test.py"]);
  });
});

// ---------------------------------------------------------------------------
// Pass 2: import-grep fallback
// ---------------------------------------------------------------------------

describe("Pass 2: importGrepFallback", () => {
  let originalFile: typeof Bun.file;
  let originalGlob: typeof Bun.Glob;

  beforeEach(() => {
    originalFile = Bun.file;
    originalGlob = Bun.Glob;
  });

  afterEach(() => {
    Object.assign(Bun, { file: originalFile });
    Object.assign(Bun, { Glob: originalGlob });
  });

  function mockGlob(files: string[]) {
    const MockGlob = class {
      scan(_workdir: string): AsyncIterable<string> {
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i < files.length) return { value: files[i++], done: false };
                return { value: undefined, done: true };
              },
            };
          },
        };
      }
    };
    Object.assign(Bun, { Glob: MockGlob });
  }

  function mockFileContent(contentMap: Record<string, string>) {
    Object.assign(Bun, {
      file: (path: string) => ({
        exists: () => Promise.resolve(path in contentMap),
        text: () => Promise.resolve(contentMap[path] ?? ""),
      }),
    });
  }

  test("returns empty array when sourceFiles is empty", async () => {
    const result = await importGrepFallback([], "/repo", ["test/**/*.test.ts"]);
    expect(result).toEqual([]);
  });

  test("returns empty array when testFilePatterns is empty", async () => {
    const result = await importGrepFallback(["src/foo/bar.ts"], "/repo", []);
    expect(result).toEqual([]);
  });

  test("matches test file that imports the source by basename path", async () => {
    mockGlob(["test/unit/routing.test.ts"]);
    mockFileContent({
      "/repo/test/unit/routing.test.ts": `import { route } from "../../../src/routing/strategies/llm";`,
    });

    const result = await importGrepFallback(["src/routing/strategies/llm.ts"], "/repo", ["test/**/*.test.ts"]);

    expect(result).toEqual(["/repo/test/unit/routing.test.ts"]);
  });

  test("matches test file that imports by full path segment", async () => {
    mockGlob(["test/unit/routing.test.ts"]);
    mockFileContent({
      "/repo/test/unit/routing.test.ts": `import something from "../../../routing/strategies/llm";`,
    });

    const result = await importGrepFallback(["src/routing/strategies/llm.ts"], "/repo", ["test/**/*.test.ts"]);

    expect(result).toEqual(["/repo/test/unit/routing.test.ts"]);
  });

  test("does not match test file with no import reference", async () => {
    mockGlob(["test/unit/other.test.ts"]);
    mockFileContent({
      "/repo/test/unit/other.test.ts": `import { something } from "../../../src/other/module";`,
    });

    const result = await importGrepFallback(["src/routing/strategies/llm.ts"], "/repo", ["test/**/*.test.ts"]);

    expect(result).toEqual([]);
  });

  test("returns multiple matching test files", async () => {
    mockGlob(["test/unit/a.test.ts", "test/unit/b.test.ts"]);
    mockFileContent({
      "/repo/test/unit/a.test.ts": `import { fn } from "../../../src/utils/helper";`,
      "/repo/test/unit/b.test.ts": `import { fn } from "../../../src/utils/helper";`,
    });

    const result = await importGrepFallback(["src/utils/helper.ts"], "/repo", ["test/**/*.test.ts"]);

    expect(result).toContain("/repo/test/unit/a.test.ts");
    expect(result).toContain("/repo/test/unit/b.test.ts");
    expect(result).toHaveLength(2);
  });

  test("skips test files that cannot be read", async () => {
    mockGlob(["test/unit/broken.test.ts", "test/unit/ok.test.ts"]);
    Object.assign(Bun, {
      file: (path: string) => ({
        exists: () => Promise.resolve(true),
        text: () => {
          if (path.includes("broken")) throw new Error("read error");
          return Promise.resolve(`import { fn } from "../../../src/utils/helper";`);
        },
      }),
    });

    const result = await importGrepFallback(["src/utils/helper.ts"], "/repo", ["test/**/*.test.ts"]);

    // broken.test.ts is skipped, ok.test.ts matches
    expect(result).toEqual(["/repo/test/unit/ok.test.ts"]);
  });

  test("does not add the same file twice if multiple terms match", async () => {
    mockGlob(["test/unit/routing.test.ts"]);
    // Content contains both "/llm" and "routing/strategies/llm"
    mockFileContent({
      "/repo/test/unit/routing.test.ts": `import { classify } from "../../../src/routing/strategies/llm";`,
    });

    const result = await importGrepFallback(["src/routing/strategies/llm.ts"], "/repo", ["test/**/*.test.ts"]);

    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pass 3: full-suite fallback (empty return triggers full-suite at caller)
// ---------------------------------------------------------------------------

describe("Pass 3: full-suite fallback (empty return from both passes)", () => {
  let originalFile: typeof Bun.file;
  let originalGlob: typeof Bun.Glob;

  beforeEach(() => {
    originalFile = Bun.file;
    originalGlob = Bun.Glob;
  });

  afterEach(() => {
    Object.assign(Bun, { file: originalFile });
    Object.assign(Bun, { Glob: originalGlob });
  });

  test("importGrepFallback returns empty array when no test files match any pattern", async () => {
    const MockGlob = class {
      scan(_workdir: string): AsyncIterable<string> {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { value: undefined, done: true };
              },
            };
          },
        };
      }
    };
    Object.assign(Bun, { Glob: MockGlob });

    const result = await importGrepFallback(["src/foo/bar.ts"], "/repo", ["test/**/*.test.ts"]);

    expect(result).toEqual([]);
  });

  test("importGrepFallback returns empty array when no scanned test files import the module", async () => {
    const MockGlob = class {
      scan(_workdir: string): AsyncIterable<string> {
        let done = false;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (!done) {
                  done = true;
                  return { value: "test/unit/unrelated.test.ts", done: false };
                }
                return { value: undefined, done: true };
              },
            };
          },
        };
      }
    };
    Object.assign(Bun, { Glob: MockGlob });
    Object.assign(Bun, {
      file: (_path: string) => ({
        text: () => Promise.resolve(`import { x } from "../../../src/completely/different";`),
      }),
    });

    const result = await importGrepFallback(["src/foo/bar.ts"], "/repo", ["test/**/*.test.ts"]);

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Custom testFilePatterns
// ---------------------------------------------------------------------------

describe("Custom testFilePatterns", () => {
  let originalGlob: typeof Bun.Glob;

  beforeEach(() => {
    originalGlob = Bun.Glob;
  });

  afterEach(() => {
    Object.assign(Bun, { Glob: originalGlob });
  });

  test("passes custom testFilePatterns to Bun.Glob", async () => {
    const capturedPatterns: string[] = [];
    const MockGlob = class {
      constructor(pattern: string) {
        capturedPatterns.push(pattern);
      }
      scan(_workdir: string): AsyncIterable<string> {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { value: undefined, done: true };
              },
            };
          },
        };
      }
    };
    Object.assign(Bun, { Glob: MockGlob });

    await importGrepFallback(["src/foo/bar.ts"], "/repo", ["test/unit/**/*.spec.ts", "test/integration/**/*.spec.ts"]);

    expect(capturedPatterns).toContain("test/unit/**/*.spec.ts");
    expect(capturedPatterns).toContain("test/integration/**/*.spec.ts");
  });

  test("uses each pattern independently", async () => {
    let scanCount = 0;
    const MockGlob = class {
      scan(_workdir: string): AsyncIterable<string> {
        scanCount++;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { value: undefined, done: true };
              },
            };
          },
        };
      }
    };
    Object.assign(Bun, { Glob: MockGlob });

    await importGrepFallback(["src/foo/bar.ts"], "/repo", [
      "test/unit/**/*.test.ts",
      "test/integration/**/*.test.ts",
      "test/e2e/**/*.test.ts",
    ]);

    expect(scanCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// packagePrefix and co-located test discovery
//
// Co-located detection is driven by extractPatternSuffix() — the suffix after
// the last `*` in each configured glob pattern. Examples:
//   "src/**\/*.spec.ts"  → probes <sourceFile>.spec.ts  (NestJS)
//   "**\/*_test.go"      → probes <sourceFile>_test.go   (Go)
//   "test_*.py"          → no suffix (pattern omitted)
// ---------------------------------------------------------------------------

describe("mapSourceToTests — packagePrefix (monorepo)", () => {
  let originalFile: typeof Bun.file;

  beforeEach(() => {
    originalFile = Bun.file;
  });

  afterEach(() => {
    Object.assign(Bun, { file: originalFile });
  });

  test("maps monorepo source to package-local test/unit when packagePrefix is set", async () => {
    mockFileExists(["/repo/apps/api/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests(["apps/api/src/foo/bar.ts"], "/repo", "apps/api");

    expect(result).toEqual(["/repo/apps/api/test/unit/foo/bar.test.ts"]);
  });

  test("maps monorepo source to package-local test/integration when packagePrefix is set", async () => {
    mockFileExists(["/repo/apps/api/test/integration/foo/bar.test.ts"]);

    const result = await mapSourceToTests(["apps/api/src/foo/bar.ts"], "/repo", "apps/api");

    expect(result).toEqual(["/repo/apps/api/test/integration/foo/bar.test.ts"]);
  });

  test("does NOT look in workdir/test/unit when packagePrefix is set", async () => {
    // Only the wrong (root-level) path exists — should not be returned
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests(["apps/api/src/foo/bar.ts"], "/repo", "apps/api");

    expect(result).toEqual([]);
  });

  test("returns empty array when no packagePrefix match exists on disk", async () => {
    mockFileExists([]);

    const result = await mapSourceToTests(["apps/api/src/foo/bar.ts"], "/repo", "apps/api");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Co-located test files — language-agnostic via testFilePatterns
//
// The suffix after the last `*` in each pattern drives which co-located
// candidates are probed. No suffixes are hardcoded in the source.
// ---------------------------------------------------------------------------

describe("mapSourceToTests — co-located test files (testFilePatterns)", () => {
  let originalFile: typeof Bun.file;

  beforeEach(() => {
    originalFile = Bun.file;
  });

  afterEach(() => {
    Object.assign(Bun, { file: originalFile });
  });

  test("finds co-located .spec.ts in monorepo src/ when pattern includes src/**/*.spec.ts (NestJS)", async () => {
    mockFileExists(["/repo/apps/api/src/agents/agents.service.spec.ts"]);

    const result = await mapSourceToTests(["apps/api/src/agents/agents.service.ts"], "/repo", "apps/api", [
      "src/**/*.spec.ts",
    ]);

    expect(result).toEqual(["/repo/apps/api/src/agents/agents.service.spec.ts"]);
  });

  test("finds co-located .test.ts in monorepo src/ when pattern includes test/**/*.test.ts (Vitest/Jest)", async () => {
    mockFileExists(["/repo/apps/api/src/agents/agents.service.test.ts"]);

    const result = await mapSourceToTests(["apps/api/src/agents/agents.service.ts"], "/repo", "apps/api", [
      "test/**/*.test.ts",
    ]);

    expect(result).toEqual(["/repo/apps/api/src/agents/agents.service.test.ts"]);
  });

  test("finds co-located .spec.ts in single-package src/ when pattern includes src/**/*.spec.ts", async () => {
    mockFileExists(["/repo/src/utils/helper.spec.ts"]);

    const result = await mapSourceToTests(["src/utils/helper.ts"], "/repo", undefined, ["src/**/*.spec.ts"]);

    expect(result).toEqual(["/repo/src/utils/helper.spec.ts"]);
  });

  test("does not find co-located .spec.ts when pattern only includes test/**/*.test.ts", async () => {
    // .spec.ts exists but suffix not covered by the configured pattern
    mockFileExists(["/repo/src/utils/helper.spec.ts"]);

    const result = await mapSourceToTests(["src/utils/helper.ts"], "/repo", undefined, ["test/**/*.test.ts"]);

    expect(result).toEqual([]);
  });

  test("returns both separated test/unit/ and co-located .spec.ts when both exist (multi-pattern)", async () => {
    mockFileExists([
      "/repo/apps/api/test/unit/agents/agents.service.test.ts",
      "/repo/apps/api/src/agents/agents.service.spec.ts",
    ]);

    const result = await mapSourceToTests(["apps/api/src/agents/agents.service.ts"], "/repo", "apps/api", [
      "test/**/*.test.ts",
      "src/**/*.spec.ts",
    ]);

    expect(result).toEqual([
      "/repo/apps/api/test/unit/agents/agents.service.test.ts",
      "/repo/apps/api/src/agents/agents.service.spec.ts",
    ]);
  });

  test("deduplicates suffixes — duplicate patterns produce no duplicate candidates", async () => {
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests(
      ["src/foo/bar.ts"],
      "/repo",
      undefined,
      ["test/**/*.test.ts", "test/unit/**/*.test.ts"], // both yield .test.ts
    );

    // Should not return the same file twice
    expect(result).toEqual(["/repo/test/unit/foo/bar.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// US-001: surface swallowed git failures
// ---------------------------------------------------------------------------

describe("US-001 smart-runner — surface swallowed git failures", () => {
  const savedGetGitRoot = _gitUtilDeps.getGitRoot;
  const savedGitWithTimeout = _gitUtilDeps.gitWithTimeout;

  beforeEach(() => {
    clearGitRootCache();
    _gitUtilDeps.getGitRoot = async () => null;
  });

  afterEach(() => {
    _gitUtilDeps.getGitRoot = savedGetGitRoot;
    _gitUtilDeps.gitWithTimeout = savedGitWithTimeout;
    clearGitRootCache();
  });

  test("AC-5: getChangedNonTestFiles warns and fails open on a non-zero git exit", async () => {
    _gitUtilDeps.gitWithTimeout = async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: bad revision 'HEAD~1'",
    });

    await withWarnSpy(async (warnSpy) => {
      const result = await getChangedNonTestFiles("/fake/repo", "HEAD~1");
      expect(result).toEqual([]);
      const call = warnSpy.mock.calls.find((c) => c[0] === "verification");
      expect(call).toBeDefined();
      expect(JSON.stringify(call?.[2] ?? {})).toContain("bad revision");
    });
  });

  test("AC-6: getChangedTestFiles warns and fails open on a non-zero git exit", async () => {
    _gitUtilDeps.gitWithTimeout = async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: bad revision 'HEAD~1'",
    });

    await withWarnSpy(async (warnSpy) => {
      const result = await getChangedTestFiles("/fake/repo", "/fake/repo", "HEAD~1", undefined, [/\.test\.ts$/]);
      expect(result).toEqual([]);
      const call = warnSpy.mock.calls.find((c) => c[0] === "verification");
      expect(call).toBeDefined();
    });
  });

  test("AC-7: getChangedNonTestFiles warns and fails open when the spawn throws", async () => {
    _gitUtilDeps.gitWithTimeout = async () => {
      throw new Error("spawn EACCES");
    };

    await withWarnSpy(async (warnSpy) => {
      const result = await getChangedNonTestFiles("/fake/repo");
      expect(result).toEqual([]);
      const call = warnSpy.mock.calls.find((c) => c[0] === "verification");
      expect(call).toBeDefined();
      expect(JSON.stringify(call?.[2] ?? {})).toContain("spawn EACCES");
    });
  });

  test("AC-8: getChangedNonTestFiles returns real files and stays quiet on success", async () => {
    _gitUtilDeps.gitWithTimeout = async () => ({
      exitCode: 0,
      stdout: "src/a.ts\nsrc/b.ts\n",
      stderr: "",
    });

    await withWarnSpy(async (warnSpy) => {
      const result = await getChangedNonTestFiles("/fake/repo");
      expect(result).toContain("src/a.ts");
      expect(result).toContain("src/b.ts");
      const call = warnSpy.mock.calls.find((c) => c[0] === "verification");
      expect(call).toBeUndefined();
    });
  });
});
