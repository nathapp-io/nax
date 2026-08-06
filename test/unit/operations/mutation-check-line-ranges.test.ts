/**
 * mutationCheckOp — diff-scoped candidate filtering (US-003).
 *
 * Covers AC7–AC15: the op fetches line ranges once via `_mutationCheckDeps.getChangedLineRanges`,
 * skips files without map entries, threads the ranges to `generateMutants`,
 * and emits the expected warn/debug log lines. All tests in this file are red
 * — the implementation has not yet been written; the field has been added
 * to the deps interface and the default wired in.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as loggerModule from "@/logger";
import { mutationCheckOp } from "@/operations";
import type { MutationCheckDeps } from "@/operations";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const FAKE_STORY = { id: "US-003", title: "scope mutation candidates" } as any;

function ctxWithConfig(execution: Record<string, unknown> = {}): any {
  const config = { execution, quality: { commands: { test: "bun test" } } } as any;
  return {
    runtime: { mutationSummaries: new Map() },
    storyId: "US-003",
    packageView: {
      packageDir: "packages/agent",
      repoRoot: "/repo",
      hasOverride: false,
      config,
      select: (s: any) => s.select(config),
    },
  } as any;
}

function fakeDeps(overrides: Partial<MutationCheckDeps> = {}): MutationCheckDeps {
  return {
    detectLanguage: async () => "typescript" as any,
    getChangedNonTestFiles: async () => [],
    getChangedLineRanges: async () => new Map(),
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
    ...overrides,
  };
}

describe("mutationCheckOp — US-003 AC7: getChangedLineRanges resolves to null", () => {
  test("returns success:true with outcomes { killed: 0, survived: 0, errored: 0 }", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const deps = fakeDeps({
        getChangedLineRanges: async () => null,
        getChangedNonTestFiles: async () => [join(dir, "src", "foo.ts")],
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.outcomes).toEqual({ killed: 0, survived: 0, errored: 0 });
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC8: null range result never invokes regression", () => {
  test("regression is not called when getChangedLineRanges returns null", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");
      const deps = fakeDeps({
        getChangedLineRanges: async () => null,
        getChangedNonTestFiles: async () => [file],
        regression: async () => {
          regressionCalls += 1;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );
      expect(regressionCalls).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC9: null range result emits a warning with storyId", () => {
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    initLogger({ level: "silent" });
    warnSpy = spyOn(loggerModule.getLogger(), "warn");
  });

  afterEach(async () => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    const { resetLogger } = await import("@/logger");
    resetLogger();
  });

  test("logger.warn is called with storyId='US-003' and a message mentioning the diff/range fallback", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const deps = fakeDeps({
        getChangedLineRanges: async () => null,
        getChangedNonTestFiles: async () => [join(dir, "src", "foo.ts")],
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      const calls = warnSpy!.mock.calls as Array<[string, string, Record<string, unknown>]>;
      const matching = calls.filter(
        ([stage, message, data]) =>
          data?.storyId === "US-003" &&
          typeof message === "string" &&
          /diff|range|scope/i.test(message) &&
          (stage === "mutation-check" || data?.stage === "mutation-check"),
      );
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC10: changed file absent from range map is skipped", () => {
  test("generates no mutants for an unmapped file and resolves with success:true", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");
      // Map does NOT include the file.
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map(),
        regression: async () => {
          regressionCalls += 1;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      expect(out.outcomes).toEqual({ killed: 0, survived: 0, errored: 0 });
      expect(regressionCalls).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC11: unmapped file emits a debug log with storyId and file", () => {
  let debugSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    initLogger({ level: "silent" });
    debugSpy = spyOn(loggerModule.getLogger(), "debug");
  });

  afterEach(async () => {
    debugSpy?.mockRestore();
    debugSpy = undefined;
    const { resetLogger } = await import("@/logger");
    resetLogger();
  });

  test("logger.debug is called with storyId='US-003' and the unmapped file path", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map(),
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      const calls = debugSpy!.mock.calls as Array<[string, string, Record<string, unknown>]>;
      const matching = calls.filter(
        ([, , data]) => data?.storyId === "US-003" && data?.file === file,
      );
      expect(matching.length).toBeGreaterThan(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC12: generateMutants receives the file's lineRanges", () => {
  test("the lineRanges returned for a mapped file are forwarded to generateMutants", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      // Use a source where line 1 mutates and line 5 also mutates; ranges cover only line 5.
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, ["a == b", "c == d", "e == f", "g == h", "i == j"].join("\n") + "\n");
      const fileRanges = [{ start: 5, end: 5 }];
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, fileRanges]]),
        regression: async () => ({
          status: "SUCCESS" as const,
          success: true,
          countsTowardEscalation: true,
          output: "",
        }),
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 10, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      // Survivors should all be on line 5 — anything else means generateMutants
      // did not receive the file's lineRanges.
      for (const s of out.survivors) {
        expect(s.line).toBe(5);
      }
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC13: getChangedLineRanges is invoked exactly once", () => {
  test("calls getChangedLineRanges exactly once with story workdir and storyGitRef", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      let calls = 0;
      let capturedWorkdir: string | undefined;
      let capturedRef: string | undefined;
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [join(dir, "src", "foo.ts")],
        getChangedLineRanges: async (wd: string, ref?: string) => {
          calls += 1;
          capturedWorkdir = wd;
          capturedRef = ref;
          return new Map();
        },
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc123",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(calls).toBe(1);
      expect(capturedWorkdir).toBe(dir);
      expect(capturedRef).toBe("abc123");
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC14: file with no mutable content never invokes regression", () => {
  test("a file mapped to comment-only ranges resolves with success:true and no regression", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "// just a comment\n");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        regression: async () => {
          regressionCalls += 1;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      expect(out.outcomes).toEqual({ killed: 0, survived: 0, errored: 0 });
      expect(regressionCalls).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-003 AC15: file with no mutable content emits no warning", () => {
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    initLogger({ level: "silent" });
    warnSpy = spyOn(loggerModule.getLogger(), "warn");
  });

  afterEach(async () => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    const { resetLogger } = await import("@/logger");
    resetLogger();
  });

  test("no warn is emitted for a file whose ranges contain no mutable content", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "// just a comment\n");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-003",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: { globs: [], regex: [], pathspec: [], testDirs: [] },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      const calls = warnSpy!.mock.calls as Array<[string, string, Record<string, unknown>]>;
      const matching = calls.filter(
        ([, message, data]) =>
          data?.storyId === "US-003" && data?.file === file && typeof message === "string",
      );
      expect(matching).toHaveLength(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// Reference `mock` so the import is not flagged as unused.
void mock;
