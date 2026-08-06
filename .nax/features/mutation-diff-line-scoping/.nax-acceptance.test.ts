import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withWarnSpy } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────
// AC-1..AC-10: extractDiffLineRanges (src/utils/diff-files.ts)
// ─────────────────────────────────────────────────────────────────────────

describe("extractDiffLineRanges", () => {
  test("AC-1: returns a Map instance with callable get/has", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const result = extractDiffLineRanges("");
    expect(result instanceof Map).toBe(true);
    expect(typeof Map.prototype.get.call(result, "x")).toBe("undefined");
    expect(typeof Map.prototype.has.call(result, "x")).toBe("boolean");
  });

  test("AC-2: new-file hunk '+1,5' produces a single range {start:1,end:5}", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const diff = "+++ b/src/a.ts\n@@ -0,0 +1,5 @@";
    const map = extractDiffLineRanges(diff);
    const ranges = map.get("src/a.ts");
    expect(Array.isArray(ranges)).toBe(true);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(1);
    expect(ranges[0].end).toBe(5);
  });

  test("AC-3: omitted-count hunk '@@ -1 +1 @@' means a single 1-line range", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const diff = "+++ b/file.ts\n@@ -1 +1 @@";
    const map = extractDiffLineRanges(diff);
    const ranges = map.get("file.ts");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ start: 1, end: 1 });
  });

  test("AC-4: pure-deletion hunk (new-side count 0) contributes no range", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const diff = "+++ b/file.ts\n@@ -5,3 +0,0 @@";
    const map = extractDiffLineRanges(diff);
    const ranges = map.get("file.ts");
    if (ranges !== undefined) {
      expect(ranges).toEqual([]);
    } else {
      expect(ranges).toBeUndefined();
    }
  });

  test("AC-5: two-file diff keys each file to only its own hunks", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const diff = "+++ b/a.ts\n@@ -1 +1 @@\n+++ b/b.ts\n@@ -1 +1 @@";
    const map = extractDiffLineRanges(diff);
    expect(map.size).toBe(2);
    expect(map.get("a.ts")).toEqual([{ start: 1, end: 1 }]);
    expect(map.get("b.ts")).toEqual([{ start: 1, end: 1 }]);
  });

  test("AC-6: '/dev/null' header is never keyed", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const diff = "--- /dev/null\n+++ /dev/null";
    const map = extractDiffLineRanges(diff);
    expect(map.has("/dev/null")).toBe(false);
  });

  test("AC-7: two hunks for one file produce ordered ranges [{11,12},{40,40}]", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const diff = "+++ b/file.ts\n@@ -10,0 +11,2 @@\n@@ -30,0 +40,1 @@";
    const map = extractDiffLineRanges(diff);
    const ranges = map.get("file.ts");
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({ start: 11, end: 12 });
    expect(ranges[1]).toEqual({ start: 40, end: 40 });
  });

  test("AC-8: CRLF and LF diffs parse to deeply equal Maps", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const lf = "+++ b/a.ts\n@@ -1 +1 @@\n+++ b/b.ts\n@@ -2,0 +3,4 @@";
    const crlf = lf.replace(/\n/g, "\r\n");
    const map1 = extractDiffLineRanges(crlf);
    const map2 = extractDiffLineRanges(lf);
    expect(JSON.stringify(Array.from(map1))).toBe(JSON.stringify(Array.from(map2)));
  });

  test("AC-9: empty input returns an empty Map", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const map = extractDiffLineRanges("");
    expect(map.size).toBe(0);
    expect(Array.from(map.entries()).length).toBe(0);
  });

  test("AC-10: invalid/unrecognised lines are ignored without throwing", () => {
    const { extractDiffLineRanges } = require("@/utils/diff-files");
    const diff = "+++ b/a.ts\n@@ -1 +1 @@\nINVALID_LINE\nanother bad line";
    let map: any;
    expect(() => {
      map = extractDiffLineRanges(diff);
    }).not.toThrow();
    const ranges = map.get("a.ts");
    expect(Array.isArray(ranges)).toBe(true);
    expect(ranges[0].start).toBe(1);
    expect(ranges[0].end).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-11..AC-19: getChangedLineRanges (src/verification/changed-line-ranges.ts)
// ─────────────────────────────────────────────────────────────────────────

describe("getChangedLineRanges", () => {
  let originalDeps: any;

  afterEach(() => {
    if (originalDeps) {
      const { _changedLineRangesDeps } = require("@/verification/changed-line-ranges");
      Object.assign(_changedLineRangesDeps, originalDeps);
      originalDeps = undefined;
    }
  });

  function stubDeps(overrides: Record<string, unknown> = {}) {
    const { _changedLineRangesDeps } = require("@/verification/changed-line-ranges");
    originalDeps = { ..._changedLineRangesDeps };
    Object.assign(_changedLineRangesDeps, {
      gitRunner: async () => ({ code: 0, stdout: "" }),
      getGitRoot: async () => null,
      ...overrides,
    });
    return _changedLineRangesDeps;
  }

  test("AC-11: exit code 0 resolves to a Map (not null)", async () => {
    stubDeps({ gitRunner: async () => ({ code: 0, stdout: "+++ b/a.ts\n@@ -1 +1 @@" }) });
    const { getChangedLineRanges } = require("@/verification/changed-line-ranges");
    const result = await getChangedLineRanges("/repo");
    expect(typeof result === "object" && result instanceof Map).toBe(true);
    expect(result).not.toBeNull();
  });

  test("AC-12: baseRef 'feature branch' invokes the git runner with exact args", async () => {
    let capturedArgs: string[] | undefined;
    stubDeps({
      gitRunner: async (args: string[]) => {
        capturedArgs = args;
        return { code: 0, stdout: "" };
      },
    });
    const { getChangedLineRanges } = require("@/verification/changed-line-ranges");
    await getChangedLineRanges("/repo", "feature branch");
    expect(capturedArgs).toEqual(["diff", "--unified=0", "feature branch"]);
  });

  test("AC-13: no baseRef defaults the third args element to 'HEAD~1'", async () => {
    let capturedArgs: string[] | undefined;
    stubDeps({
      gitRunner: async (args: string[]) => {
        capturedArgs = args;
        return { code: 0, stdout: "" };
      },
    });
    const { getChangedLineRanges } = require("@/verification/changed-line-ranges");
    await getChangedLineRanges("/repo");
    expect(capturedArgs?.[2]).toBe("HEAD~1");
  });

  test("AC-14: non-zero exit code resolves to null", async () => {
    stubDeps({ gitRunner: async () => ({ code: 1, stdout: "" }) });
    const { getChangedLineRanges } = require("@/verification/changed-line-ranges");
    const result = await getChangedLineRanges("/repo");
    expect(result).toBeNull();
  });

  test("AC-15: git runner rejection resolves to null without throwing", async () => {
    stubDeps({
      gitRunner: async () => {
        throw new Error("git spawn failed");
      },
    });
    const { getChangedLineRanges } = require("@/verification/changed-line-ranges");
    let result: unknown;
    let threw = false;
    try {
      result = await getChangedLineRanges("/repo");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeNull();
  });

  test("AC-16: exit code 0 with empty stdout returns an empty (non-null) Map", async () => {
    stubDeps({ gitRunner: async () => ({ code: 0, stdout: "" }) });
    const { getChangedLineRanges } = require("@/verification/changed-line-ranges");
    const result = await getChangedLineRanges("/repo");
    expect(result).not.toBeNull();
    expect(result.size).toBe(0);
  });

  test("AC-17: workdir '/repo' resolves diff paths to absolute keys under it", async () => {
    stubDeps({
      gitRunner: async () => ({ code: 0, stdout: "+++ b/src/a.ts\n@@ -1 +1 @@" }),
      getGitRoot: async () => "/repo",
    });
    const { getChangedLineRanges } = require("@/verification/changed-line-ranges");
    const result = await getChangedLineRanges("/repo");
    expect(Map.prototype.has.call(result, "/repo/src/a.ts")).toBe(true);
    expect(result.get("/repo/src/a.ts")).toBeDefined();
  });

  test("AC-18: null git root falls back to workdir for absolute keys", async () => {
    stubDeps({
      gitRunner: async () => ({ code: 0, stdout: "+++ b/src/a.ts\n@@ -1 +1 @@" }),
      getGitRoot: async () => null,
    });
    const { getChangedLineRanges } = require("@/verification/changed-line-ranges");
    const result = await getChangedLineRanges("/work");
    expect(result.has("/work/src/a.ts")).toBe(true);
  });

  test("AC-19: new-side hunk '+2,3' yields end = start + linesAdded - 1", async () => {
    stubDeps({
      gitRunner: async () => ({ code: 0, stdout: "+++ b/src/a.ts\n@@ -0,0 +2,3 @@" }),
      getGitRoot: async () => "/repo",
    });
    const { getChangedLineRanges } = require("@/verification/changed-line-ranges");
    const result = await getChangedLineRanges("/repo");
    expect(result.get("/repo/src/a.ts")).toEqual([{ start: 2, end: 4 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-20..AC-25: generateMutants line-range filtering (src/verification/mutation/mutator.ts)
// ─────────────────────────────────────────────────────────────────────────

function comparisonSource(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, i) => `if (x${i + 1} == y${i + 1}) { return ${i + 1}; }`).join("\n");
}

describe("generateMutants — lineRanges filtering", () => {
  test("AC-20: every mutant respects a single-line range {start:5,end:5}", () => {
    const { generateMutants } = require("@/verification/mutation");
    const result = generateMutants({
      source: comparisonSource(20),
      language: "typescript",
      file: "x.ts",
      lineRanges: [{ start: 5, end: 5 }],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((m: any) => m.line === 5)).toBe(true);
  });

  test("AC-21: range [10,20] includes the mutable statement at line 10", () => {
    const { generateMutants } = require("@/verification/mutation");
    const result = generateMutants({
      source: comparisonSource(20),
      language: "typescript",
      file: "x.ts",
      lineRanges: [{ start: 10, end: 20 }],
    });
    expect(result.some((m: any) => m.line === 10)).toBe(true);
  });

  test("AC-22: range [10,20] includes the mutable statement at line 20", () => {
    const { generateMutants } = require("@/verification/mutation");
    const result = generateMutants({
      source: comparisonSource(20),
      language: "typescript",
      file: "x.ts",
      lineRanges: [{ start: 10, end: 20 }],
    });
    expect(result.some((m: any) => m.line === 20)).toBe(true);
  });

  test("AC-23: disjoint ranges [1,5] and [10,15] exclude the gap [6,9]", () => {
    const { generateMutants } = require("@/verification/mutation");
    const result = generateMutants({
      source: comparisonSource(20),
      language: "typescript",
      file: "x.ts",
      lineRanges: [
        { start: 1, end: 5 },
        { start: 10, end: 15 },
      ],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((m: any) => (m.line >= 1 && m.line <= 5) || (m.line >= 10 && m.line <= 15))).toBe(true);
    expect(result.some((m: any) => m.line >= 6 && m.line <= 9)).toBe(false);
  });

  test("AC-24: no lineRanges property mutates every mutable line", () => {
    const { generateMutants } = require("@/verification/mutation");
    const source = comparisonSource(20);
    const result = generateMutants({ source, language: "typescript", file: "x.ts" });
    expect(result.length).toBe(20);
    const linesCovered = new Set(result.map((m: any) => m.line));
    expect(linesCovered.size).toBe(20);
  });

  test("AC-25: an empty lineRanges array yields zero mutants", () => {
    const { generateMutants } = require("@/verification/mutation");
    const result = generateMutants({
      source: comparisonSource(20),
      language: "typescript",
      file: "x.ts",
      lineRanges: [],
    });
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-26..AC-39: mutationCheckOp diff-scoped wiring (src/operations/mutation-check.ts)
// ─────────────────────────────────────────────────────────────────────────

describe("mutationCheckOp — diff-line scoping", () => {
  const FAKE_STORY = { id: "US-DLS", title: "diff-line-scoping" } as any;

  function ctxWithConfig(execution: Record<string, unknown> = {}, runtime: Record<string, unknown> = {}): any {
    const config = { execution, quality: { commands: { test: "bun test" } } } as any;
    return {
      runtime: { mutationSummaries: new Map(), ...runtime },
      storyId: "US-DLS",
      packageView: {
        packageDir: ".",
        repoRoot: "/repo",
        hasOverride: false,
        config,
        select: (s: any) => s.select(config),
      },
    };
  }

  function fakeDeps(overrides: Record<string, unknown> = {}) {
    const { generateMutants } = require("@/verification/mutation");
    return {
      detectLanguage: async () => "typescript",
      getChangedNonTestFiles: async () => [],
      selectScopedTests: async () => ({
        effectiveCommand: "bun test",
        isFullSuite: true,
        thresholdFallback: false,
        isMonorepoOrchestrator: false,
      }),
      regression: async () => ({
        status: "SUCCESS" as const,
        success: true,
        countsTowardEscalation: true,
        output: "",
      }),
      getChangedLineRanges: async () => null,
      generateMutants,
      ...overrides,
    };
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      story: FAKE_STORY,
      workdir: "/tmp/nax-dls-test",
      storyId: "US-DLS",
      storyGitRef: "abc123",
      repoRoot: "/tmp/nax-dls-test",
      resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
      ...overrides,
    };
  }

  test("AC-26: null diff map -> success true, zero outcomes", async () => {
    const { mutationCheckOp } = require("@/operations");
    const deps = fakeDeps({
      getChangedLineRanges: async () => null,
      getChangedNonTestFiles: async () => ["/tmp/nax-dls-test/src/a.ts"],
    });
    const out = await mutationCheckOp.execute(
      baseInput(),
      ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
      deps,
    );
    expect(out.success).toBe(true);
    expect(out.outcomes).toEqual({ killed: 0, survived: 0, errored: 0 });
  });

  test("AC-27: null diff map -> regression is never called", async () => {
    const { mutationCheckOp } = require("@/operations");
    let regressionCalled = false;
    const deps = fakeDeps({
      getChangedLineRanges: async () => null,
      getChangedNonTestFiles: async () => ["/tmp/nax-dls-test/src/a.ts"],
      regression: async () => {
        regressionCalled = true;
        return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
      },
    });
    await mutationCheckOp.execute(
      baseInput(),
      ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
      deps,
    );
    expect(regressionCalled).toBe(false);
  });

  test("AC-28: null diff map -> a warning is logged with storyId", async () => {
    await withWarnSpy(async (warnSpy) => {
      const { mutationCheckOp } = require("@/operations");
      const deps = fakeDeps({
        getChangedLineRanges: async () => null,
        getChangedNonTestFiles: async () => ["/tmp/nax-dls-test/src/a.ts"],
      });
      await mutationCheckOp.execute(
        baseInput(),
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );
      const found = warnSpy.mock.calls.some((c: any[]) => {
        const data = c[2];
        return data && typeof data === "object" && data.storyId === "US-DLS";
      });
      expect(found).toBe(true);
    });
  });

  test("AC-29: an excluded file generates zero mutants, run still succeeds", async () => {
    const dir = makeTempDir("nax-dls-");
    try {
      const included = join(dir, "src", "included.ts");
      const excluded = join(dir, "src", "excluded.ts");
      await Bun.write(included, "if (a == b) { return 1; }\n");
      await Bun.write(excluded, "if (c == d) { return 2; }\n");

      const { mutationCheckOp } = require("@/operations");
      let capturedInputs: any[] = [];
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [included, excluded],
        getChangedLineRanges: async () => new Map([[included, [{ start: 1, end: 1 }]]]),
        generateMutants: (input: any) => {
          capturedInputs.push(input);
          const { generateMutants: real } = require("@/verification/mutation");
          return real(input);
        },
      });

      const out = await mutationCheckOp.execute(
        baseInput({ workdir: dir, repoRoot: dir }),
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 5, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      const excludedCall = capturedInputs.find((c) => c.file === excluded);
      expect(excludedCall).toBeUndefined();
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("AC-30: excluded file logs a debug entry containing storyId and the file path", async () => {
    const dir = makeTempDir("nax-dls-");
    try {
      const excluded = join(dir, "src", "excluded.ts");
      await Bun.write(excluded, "if (c == d) { return 2; }\n");

      const { resetLogger, initLogger } = require("@/logger");
      resetLogger();
      const debugSpy = spyOn(initLogger({ level: "silent" }), "debug");
      try {
        const { mutationCheckOp } = require("@/operations");
        const deps = fakeDeps({
          getChangedNonTestFiles: async () => [excluded],
          getChangedLineRanges: async () => new Map(),
        });

        await mutationCheckOp.execute(
          baseInput({ workdir: dir, repoRoot: dir }),
          ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 5, timeoutSeconds: 60 } }),
          deps,
        );

        const found = debugSpy.mock.calls.some((c: any[]) => {
          const data = c[2];
          const msg = String(c[1] ?? "");
          const dataStr = data ? JSON.stringify(data) : "";
          return (msg.includes("US-DLS") || dataStr.includes("US-DLS")) && dataStr.includes(excluded);
        });
        expect(found).toBe(true);
      } finally {
        debugSpy.mockRestore();
        resetLogger();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("AC-31: generateMutants receives the file's line ranges from the diff map", async () => {
    const dir = makeTempDir("nax-dls-");
    try {
      const file = join(dir, "src", "file.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n".repeat(1));

      const { mutationCheckOp } = require("@/operations");
      let capturedLineRanges: unknown;
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 5, end: 10 }]]]),
        generateMutants: (input: any) => {
          capturedLineRanges = input.lineRanges;
          const { generateMutants: real } = require("@/verification/mutation");
          return real(input);
        },
      });

      await mutationCheckOp.execute(
        baseInput({ workdir: dir, repoRoot: dir }),
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 5, timeoutSeconds: 60 } }),
        deps,
      );

      expect(capturedLineRanges).toEqual([{ start: 5, end: 10 }]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("AC-32: getChangedLineRanges is called exactly once with workdir and storyGitRef", async () => {
    const { mutationCheckOp } = require("@/operations");
    let callCount = 0;
    let capturedArg: any;
    const deps = fakeDeps({
      getChangedLineRanges: async (input: any) => {
        callCount += 1;
        capturedArg = input;
        return null;
      },
    });

    await mutationCheckOp.execute(
      baseInput({ workdir: "/tmp/nax-dls-story", storyGitRef: "deadbeef" }),
      ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
      deps,
    );

    expect(callCount).toBe(1);
    expect(capturedArg).toEqual({ workdir: "/tmp/nax-dls-story", storyGitRef: "deadbeef" });
  });

  test("AC-33: an all-non-mutable diff range succeeds without calling regression", async () => {
    const dir = makeTempDir("nax-dls-");
    try {
      const file = join(dir, "src", "immutable.ts");
      await Bun.write(file, Array.from({ length: 5 }, (_, i) => `const label${i} = "hello";`).join("\n") + "\n");

      const { mutationCheckOp } = require("@/operations");
      let regressionCalled = false;
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 100 }]]]),
        regression: async () => {
          regressionCalled = true;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      const out = await mutationCheckOp.execute(
        baseInput({ workdir: dir, repoRoot: dir }),
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 5, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(regressionCalled).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("AC-34: an all-non-mutable diff range logs no warning mentioning the file", async () => {
    const dir = makeTempDir("nax-dls-");
    try {
      const file = join(dir, "src", "immutable.ts");
      await Bun.write(file, Array.from({ length: 5 }, (_, i) => `const label${i} = "hello";`).join("\n") + "\n");

      await withWarnSpy(async (warnSpy) => {
        const { mutationCheckOp } = require("@/operations");
        const deps = fakeDeps({
          getChangedNonTestFiles: async () => [file],
          getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 100 }]]]),
        });

        await mutationCheckOp.execute(
          baseInput({ workdir: dir, repoRoot: dir }),
          ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 5, timeoutSeconds: 60 } }),
          deps,
        );

        const mentionsFile = warnSpy.mock.calls.some((c: any[]) => {
          const data = c[2];
          return data && typeof data === "object" && JSON.stringify(data).includes(file);
        });
        expect(mentionsFile).toBe(false);
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("AC-35: enabled with a non-null diff records checked:true on the summary", async () => {
    const mutationSummaries = new Map();
    const { mutationCheckOp } = require("@/operations");
    const deps = fakeDeps({ getChangedLineRanges: async () => new Map() });

    await mutationCheckOp.execute(
      baseInput(),
      ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }, { mutationSummaries }),
      deps,
    );

    expect(mutationSummaries.get("US-DLS")?.checked).toBe(true);
  });

  test("AC-36: mutationCheck.enabled false records checked:false on the summary", async () => {
    const mutationSummaries = new Map();
    const { mutationCheckOp } = require("@/operations");
    const deps = fakeDeps();

    await mutationCheckOp.execute(
      baseInput(),
      ctxWithConfig({ mutationCheck: { enabled: false } }, { mutationSummaries }),
      deps,
    );

    expect(mutationSummaries.get("US-DLS")?.checked).toBe(false);
  });

  test("AC-37: no resolvable test command records checked:false on the summary", async () => {
    const mutationSummaries = new Map();
    const { mutationCheckOp } = require("@/operations");
    const ctx = ctxWithConfig(
      { mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } },
      { mutationSummaries },
    );
    ctx.packageView.config.quality.commands.test = undefined;
    const deps = fakeDeps();

    await mutationCheckOp.execute(baseInput(), ctx, deps);

    expect(mutationSummaries.get("US-DLS")?.checked).toBe(false);
  });

  test("AC-38: null diff map records checked:true and candidates:0", async () => {
    const mutationSummaries = new Map();
    const { mutationCheckOp } = require("@/operations");
    const deps = fakeDeps({
      getChangedLineRanges: async () => null,
      getChangedNonTestFiles: async () => ["/tmp/nax-dls-test/src/a.ts"],
    });

    await mutationCheckOp.execute(
      baseInput(),
      ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }, { mutationSummaries }),
      deps,
    );

    const summary = mutationSummaries.get("US-DLS");
    expect(summary?.checked).toBe(true);
    expect(summary?.candidates).toBe(0);
  });

  test("AC-39: candidates records the pre-selection mutant count", async () => {
    const dir = makeTempDir("nax-dls-");
    try {
      const file = join(dir, "src", "five.ts");
      await Bun.write(file, Array.from({ length: 5 }, (_, i) => `if (a${i} == b${i}) { return ${i}; }`).join("\n") + "\n");

      const mutationSummaries = new Map();
      const { mutationCheckOp } = require("@/operations");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 5 }]]]),
      });

      await mutationCheckOp.execute(
        baseInput({ workdir: dir, repoRoot: dir }),
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 2, timeoutSeconds: 60 } }, { mutationSummaries }),
        deps,
      );

      expect(mutationSummaries.get("US-DLS")?.candidates).toBe(5);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-40..AC-45: formatMutationSummary NOT CHECKED block (src/log-format/mutation-summary.ts)
// ─────────────────────────────────────────────────────────────────────────

describe("formatMutationSummary — NOT CHECKED block", () => {
  function summary(overrides: Record<string, unknown> = {}) {
    return {
      storyId: "ST-001",
      survivors: [],
      outcomes: { killed: 0, survived: 0, errored: 0 },
      candidates: 0,
      checked: true,
      ...overrides,
    };
  }

  test("AC-40: checked:true with zero candidates renders NOT CHECKED and the story id", () => {
    const { formatMutationSummary } = require("@/log-format");
    const result = formatMutationSummary([summary({ storyId: "ST-001", candidates: 0, checked: true })]);
    expect(result).toContain("NOT CHECKED");
    expect(result).toContain("ST-001");
  });

  test("AC-41: checked:false does not render NOT CHECKED", () => {
    const { formatMutationSummary } = require("@/log-format");
    const result = formatMutationSummary([summary({ storyId: "ST-001", candidates: 0, checked: false })]);
    expect(result).not.toContain("NOT CHECKED");
  });

  test("AC-42: checked:true with candidates present does not render NOT CHECKED", () => {
    const { formatMutationSummary } = require("@/log-format");
    const result = formatMutationSummary([summary({ storyId: "ST-001", candidates: 5, checked: true })]);
    expect(result).not.toContain("NOT CHECKED");
  });

  test("AC-43: SURVIVING MUTANTS section appears before NOT CHECKED", () => {
    const { formatMutationSummary } = require("@/log-format");
    const result = formatMutationSummary([
      summary({
        storyId: "ST-001",
        survivors: [{ id: "mut-1", filename: "a.ts", replacement: "x" }],
        outcomes: { killed: 0, survived: 1, errored: 0 },
        candidates: 1,
        checked: true,
      }),
      summary({ storyId: "ST-002", candidates: 0, checked: true }),
    ]);
    expect(result).toContain("SURVIVING MUTANTS");
    expect(result).toContain("NOT CHECKED");
    expect(result.indexOf("SURVIVING MUTANTS")).toBeLessThan(result.indexOf("NOT CHECKED"));
  });

  test("AC-44: both not-checked stories appear in the output", () => {
    const { formatMutationSummary } = require("@/log-format");
    const result = formatMutationSummary([
      summary({ storyId: "ST-001", candidates: 0, checked: true }),
      summary({ storyId: "ST-002", candidates: 0, checked: true }),
    ]);
    expect(result).toContain("ST-001");
    expect(result).toContain("ST-002");
  });

  test("AC-45: two checked:false summaries with no survivors render an empty string", () => {
    const { formatMutationSummary } = require("@/log-format");
    const result = formatMutationSummary([
      summary({ storyId: "ST-001", candidates: 0, checked: false }),
      summary({ storyId: "ST-002", candidates: 0, checked: false }),
    ]);
    expect(result).toBe("");
  });
});