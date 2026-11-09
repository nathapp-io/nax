import { describe, expect, test } from "bun:test";
import { withDepsRestore, withWarnSpy } from "@test/helpers";
import { _scopedSelectionDeps, selectScopedTests } from "@/test-runners";
import { _bunDeps, importGrepFallback } from "@/verification/smart-runner";

/**
 * The import-grep cap (M17).
 *
 * A scan that holds more than `maxScanFiles` test files is an incomplete view
 * of the suite: scoping the run to what it found would silently skip the
 * tests it never read. The fallback therefore refuses partial results and
 * lets the caller escalate to the full suite.
 */

/** Relative test-file paths the glob stub yields. */
function makeTestFiles(count: number, dir = "test"): string[] {
  return Array.from({ length: count }, (_, i) => `${dir}/a${i}.test.ts`);
}

/** Stub the glob so each pattern yields the files `resolve` returns for it. */
function stubGlob(resolve: (pattern: string) => string[]): { scanned: number } {
  const counter = { scanned: 0 };
  Object.assign(_bunDeps, {
    glob: (pattern: string) => ({
      async *scan() {
        for (const file of resolve(pattern)) {
          counter.scanned++;
          yield file;
        }
      },
    }),
  });
  return counter;
}

/** Stub file reads, counting them. Every file contains the search term. */
function stubFileReads(reads: { count: number } = { count: 0 }): { count: number } {
  Object.assign(_bunDeps, {
    file: (_path: string) => ({
      async text() {
        reads.count++;
        return 'import { x } from "/x";';
      },
      async exists() {
        return true;
      },
    }),
  });
  return reads;
}

describe("importGrepFallback — maxScanFiles cap", () => {
  withDepsRestore(_bunDeps);

  test("returns [] when the scan holds more files than the cap", async () => {
    stubGlob(() => makeTestFiles(6));
    stubFileReads();

    const result = await importGrepFallback(["src/x.ts"], "/repo", ["test/**/*.test.ts"], 5);

    expect(result).toEqual([]);
  });

  test("reads no test file when the scan overflows the cap", async () => {
    stubGlob(() => makeTestFiles(6));
    const reads = stubFileReads();

    await importGrepFallback(["src/x.ts"], "/repo", ["test/**/*.test.ts"], 5);

    expect(reads.count).toBe(0);
  });

  test("warns once on the smart-runner stage when the scan overflows the cap", async () => {
    stubGlob(() => makeTestFiles(6));
    stubFileReads();

    await withWarnSpy(async (warnSpy) => {
      await importGrepFallback(["src/x.ts"], "/repo", ["test/**/*.test.ts"], 5);

      const warns = warnSpy.mock.calls.filter((call) => call[0] === "smart-runner");
      expect(warns.length).toBe(1);
      expect(warns[0]?.[1]).toContain("cap");
      expect(warns[0]?.[1]).toContain("full suite");
      expect(warns[0]?.[2]).toEqual({ cap: 5 });
    });
  });

  test("returns every matching file when the scan holds exactly the cap", async () => {
    stubGlob(() => makeTestFiles(5));
    const reads = stubFileReads();

    const result = await importGrepFallback(["src/x.ts"], "/repo", ["test/**/*.test.ts"], 5);

    expect(result).toEqual([
      "/repo/test/a0.test.ts",
      "/repo/test/a1.test.ts",
      "/repo/test/a2.test.ts",
      "/repo/test/a3.test.ts",
      "/repo/test/a4.test.ts",
    ]);
    expect(reads.count).toBe(5);
  });

  test("does not warn when the scan holds exactly the cap", async () => {
    stubGlob(() => makeTestFiles(5));
    stubFileReads();

    await withWarnSpy(async (warnSpy) => {
      await importGrepFallback(["src/x.ts"], "/repo", ["test/**/*.test.ts"], 5);

      expect(warnSpy.mock.calls.filter((call) => call[0] === "smart-runner")).toHaveLength(0);
    });
  });

  test("counts files across patterns against the cap", async () => {
    stubGlob((pattern) => makeTestFiles(3, pattern.includes("one") ? "test/one" : "test/two"));
    const reads = stubFileReads();

    // Two patterns, three files each — six files against a cap of five.
    const result = await importGrepFallback(
      ["src/x.ts"],
      "/repo",
      ["test/one/**/*.test.ts", "test/two/**/*.test.ts"],
      5,
    );

    expect(result).toEqual([]);
    expect(reads.count).toBe(0);
  });
});

describe("selectScopedTests — import-grep overflow escalates to the full suite", () => {
  withDepsRestore(_bunDeps);
  withDepsRestore(_scopedSelectionDeps, ["getChangedTestFiles", "getChangedNonTestFiles", "mapSourceToTests"]);

  test("runs the full suite when the real import-grep fallback overflows its cap", async () => {
    const scanned = stubGlob(() => makeTestFiles(3));
    stubFileReads();
    Object.assign(_scopedSelectionDeps, {
      getChangedTestFiles: async () => [],
      getChangedNonTestFiles: async () => ["src/x.ts"],
      mapSourceToTests: async () => [],
    });

    const result = await selectScopedTests({
      workdir: "/repo",
      storyId: "US-003",
      storyGitRef: "abc123",
      testCommand: "bun test",
      fallbackFullSuiteCommand: "bun test --all",
      smartRunnerConfig: { enabled: true, fallback: "import-grep", maxScanFiles: 2 },
    });

    // The real import-grep fallback drove the scan — it is not stubbed out.
    expect(scanned.scanned).toBeGreaterThan(0);
    expect(result.isFullSuite).toBe(true);
    expect(result.effectiveCommand).toBe("bun test --all");
  });
});
