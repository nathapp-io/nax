import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeMutationCheckDeps as fakeDeps,
  makeMutationCheckCtx,
  makeResolvedTestPatterns,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import type { MutationCheckDeps } from "@/operations";
import { _mutationCheckDeps, mutationCheckOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const FAKE_STORY = makeStory({ id: "US-004", title: "mutation-check op" });

const ctxWithConfig = (execution: Record<string, unknown> = {}, runtime: Partial<NaxRuntime> = {}) =>
  makeMutationCheckCtx(execution, { runtime });

const originalMutationCheckDeps = { ..._mutationCheckDeps };
afterEach(() => Object.assign(_mutationCheckDeps, originalMutationCheckDeps));

describe("mutationCheckOp — AC1: DeterministicOperation shape", () => {
  test("kind is deterministic", () => {
    expect(mutationCheckOp.kind).toBe("deterministic");
  });

  test("name is mutation-check", () => {
    expect(mutationCheckOp.name).toBe("mutation-check");
  });

  test("stage is verify", () => {
    expect(mutationCheckOp.stage).toBe("verify");
  });
});

describe("mutationCheckOp — AC2: disabled short-circuit", () => {
  test("US-004 early-return persistence: records an empty summary when mutation checks are disabled", async () => {
    const mutationSummaries = new Map();
    const ctx = ctxWithConfig({ mutationCheck: { enabled: false } }, { mutationSummaries });

    await mutationCheckOp.execute(
      {
        story: FAKE_STORY,
        workdir: "/tmp/test",
        storyId: "US-004",
        resolvedTestPatterns: makeResolvedTestPatterns({ globs: [], regex: [], pathspec: [], testDirs: [] }),
      },
      ctx,
      fakeDeps(),
    );

    expect(mutationSummaries.get("US-004")).toEqual({
      storyId: "US-004",
      survivors: [],
      outcomes: { killed: 0, survived: 0, errored: 0 },
      candidates: 0,
      checked: false,
    });
  });

  test("US-004 early-return persistence: records an empty summary when no test command exists", async () => {
    const mutationSummaries = new Map();
    const ctx = ctxWithConfig({}, { mutationSummaries });
    ctx.packageView.config.quality.commands.test = undefined;

    await mutationCheckOp.execute(
      {
        story: FAKE_STORY,
        workdir: "/tmp/test",
        storyId: "US-004",
        resolvedTestPatterns: makeResolvedTestPatterns({ globs: [], regex: [], pathspec: [], testDirs: [] }),
      },
      ctx,
      fakeDeps(),
    );

    expect(mutationSummaries.get("US-004")).toEqual({
      storyId: "US-004",
      survivors: [],
      outcomes: { killed: 0, survived: 0, errored: 0 },
      candidates: 0,
      checked: false,
    });
  });

  test("returns success=true with empty survivors and never calls scoped tests/regression", async () => {
    let selectionCalled = false;
    let regressionCalled = false;
    const deps = fakeDeps({
      selectScopedTests: async () => {
        selectionCalled = true;
        return {
          effectiveCommand: "bun test",
          isFullSuite: true,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        };
      },
      regression: async () => {
        regressionCalled = true;
        return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
      },
    });
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          }),
        },
        ctxWithConfig({ mutationCheck: { enabled: false, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );
      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      expect(selectionCalled).toBe(false);
      expect(regressionCalled).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — AC3: surviving mutant (regression SUCCESS)", () => {
  test("records one survivor when regression succeeds against a mutated file", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let capturedRegressionCommand: string | undefined;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        selectScopedTests: async () => ({
          effectiveCommand: "bun test src/foo.test.ts",
          isFullSuite: false,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async (opts) => {
          capturedRegressionCommand = opts.command;
          // BUG-13: SUCCESS needs test-evidence counts or classifyMutant now
          // treats it as inconclusive ("errored"), not "survived" (#1207).
          return {
            status: "SUCCESS" as const,
            success: true,
            countsTowardEscalation: true,
            output: "",
            passCount: 1,
            failCount: 0,
          };
        },
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc123",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          }),
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.survivors.length).toBe(1);
      expect(out.survivors[0].file).toBe(file);
      expect(out.survivors[0].line).toBe(1);
      expect(out.survivors[0].operatorId).toBe("ts:cmp-flip");
      expect(capturedRegressionCommand).toBe("bun test src/foo.test.ts");
      // File must be restored after revert.
      const after = await Bun.file(file).text();
      expect(after).toBe("if (a == b) { return 1; }\n");
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-004 runtime collection", () => {
  test("US-004 AC9: stores one survivor under the call-context story ID", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    const mutationSummaries = new Map();
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
      });
      const ctx = ctxWithConfig(
        { mutationCheck: { enabled: true, maxMutants: 1, timeoutSeconds: 60 } },
        { mutationSummaries },
      );
      ctx.storyId = "US-007";

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({ globs: [], regex: [], pathspec: [], testDirs: [] }),
        },
        ctx,
        deps,
      );

      expect(mutationSummaries.get("US-007")?.survivors).toHaveLength(1);
      expect(mutationSummaries.get("US-007")?.checked).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("US-004 AC4: records checked true with zero candidates when changed ranges are unavailable", async () => {
    const mutationSummaries = new Map();
    const ctx = ctxWithConfig(
      { mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } },
      { mutationSummaries },
    );
    const deps = fakeDeps({ getChangedLineRanges: async () => null });

    await mutationCheckOp.execute(
      {
        story: FAKE_STORY,
        workdir: "/tmp/test",
        storyId: "US-004",
        resolvedTestPatterns: makeResolvedTestPatterns({ globs: [], regex: [], pathspec: [], testDirs: [] }),
      },
      ctx,
      deps,
    );

    expect(mutationSummaries.get("US-004")).toMatchObject({ checked: true, candidates: 0 });
  });
  test("US-004 AC10: leaves the collector empty without a call-context story ID", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    const mutationSummaries = new Map();
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
      });
      const ctx = ctxWithConfig(
        { mutationCheck: { enabled: true, maxMutants: 1, timeoutSeconds: 60 } },
        { mutationSummaries },
      );
      ctx.storyId = undefined;

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({ globs: [], regex: [], pathspec: [], testDirs: [] }),
        },
        ctx,
        deps,
      );

      expect(mutationSummaries.size).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — AC4: TEST_FAILURE kills the mutant", () => {
  test("returns empty survivors when regression returns TEST_FAILURE with failCount = 1", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        selectScopedTests: async () => ({
          effectiveCommand: "bun test src/foo.test.ts",
          isFullSuite: false,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async () => ({
          status: "TEST_FAILURE" as const,
          success: false,
          countsTowardEscalation: true,
          output: "1 test failed",
          passCount: 0,
          failCount: 1,
        }),
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc123",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          }),
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      const after = await Bun.file(file).text();
      expect(after).toBe("if (a == b) { return 1; }\n");
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — outcomes aggregation (US-003)", () => {
  async function runWithRegression(
    regressionResult: {
      status: "SUCCESS" | "TEST_FAILURE" | "TIMEOUT" | "ENVIRONMENTAL_FAILURE" | "ASSET_CHECK_FAILED";
      passCount?: number;
      failCount?: number;
    },
    mutationsConfig: Record<string, unknown> = { enabled: true, maxMutants: 3, timeoutSeconds: 60 },
  ) {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        selectScopedTests: async () => ({
          effectiveCommand: "bun test src/foo.test.ts",
          isFullSuite: false,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async () => ({
          ...regressionResult,
          success: regressionResult.status === "SUCCESS",
          countsTowardEscalation: true,
          output: "",
        }),
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc123",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          }),
        },
        ctxWithConfig({ mutationCheck: mutationsConfig }),
        deps,
      );
      return out;
    } finally {
      cleanupTempDir(dir);
    }
  }

  test("AC9: TEST_FAILURE with both counts 0 -> outcomes.errored is 1", async () => {
    const out = await runWithRegression({ status: "TEST_FAILURE", passCount: 0, failCount: 0 });
    expect(out.outcomes.errored).toBe(1);
  });

  test("AC10: TEST_FAILURE with both counts 0 -> outcomes.killed is 0", async () => {
    const out = await runWithRegression({ status: "TEST_FAILURE", passCount: 0, failCount: 0 });
    expect(out.outcomes.killed).toBe(0);
  });

  test("AC11: TEST_FAILURE with failCount 1 -> outcomes.killed is 1", async () => {
    const out = await runWithRegression({ status: "TEST_FAILURE", passCount: 0, failCount: 1 });
    expect(out.outcomes.killed).toBe(1);
  });

  test("AC12: SUCCESS with executed tests -> outcomes.survived is 1", async () => {
    const out = await runWithRegression({ status: "SUCCESS", passCount: 1, failCount: 0 });
    expect(out.outcomes.survived).toBe(1);
  });

  // BUG-13 (nax review 20260829, #1207): a zero-test SUCCESS run is inconclusive,
  // not a pass — see classify.test.ts for the unit-level coverage.
  test("BUG-13: SUCCESS with zero executed tests -> outcomes.errored is 1, not survived", async () => {
    const out = await runWithRegression({ status: "SUCCESS" });
    expect(out.outcomes.errored).toBe(1);
    expect(out.outcomes.survived).toBe(0);
  });

  test("AC13: TEST_FAILURE with both counts 0 -> survivors has length 0", async () => {
    const out = await runWithRegression({ status: "TEST_FAILURE", passCount: 0, failCount: 0 });
    expect(out.survivors).toHaveLength(0);
  });

  test("regression throw increments outcomes.errored (rectification review)", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        selectScopedTests: async () => ({
          effectiveCommand: "bun test src/foo.test.ts",
          isFullSuite: false,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async () => {
          throw new Error("subprocess exploded");
        },
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          }),
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.outcomes.errored).toBe(1);
      expect(out.outcomes.killed).toBe(0);
      expect(out.outcomes.survived).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — AC5: TIMEOUT is classified errored (not survived)", () => {
  test("returns empty survivors when regression returns TIMEOUT", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        selectScopedTests: async () => ({
          effectiveCommand: "bun test src/foo.test.ts",
          isFullSuite: false,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async () => ({
          status: "TIMEOUT" as const,
          success: false,
          countsTowardEscalation: false,
          output: "",
        }),
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc123",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          }),
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      const after = await Bun.file(file).text();
      expect(after).toBe("if (a == b) { return 1; }\n");
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — AC6: unsupported language no-ops", () => {
  test("python language → empty survivors, regression not called", async () => {
    let regressionCalled = false;
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const deps = fakeDeps({
        detectLanguage: async () => "python",
        getChangedNonTestFiles: async () => ["src/foo.py"],
        regression: async () => {
          regressionCalled = true;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });
      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc",
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["tests"],
          }),
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );
      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      expect(regressionCalled).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("undefined language → empty survivors, regression not called (no operators for unknown language)", async () => {
    let regressionCalled = false;
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const deps = fakeDeps({
        detectLanguage: async () => undefined,
        getChangedNonTestFiles: async () => ["src/foo.unknown"],
        regression: async () => {
          regressionCalled = true;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });
      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc",
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.unknown"],
            regex: [/test_.*\.unknown$/],
            pathspec: [":!test_*.unknown"],
            testDirs: ["tests"],
          }),
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );
      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      expect(regressionCalled).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — AC7: maxMutants caps regression calls", () => {
  test("calls regression at most maxMutants times even when more candidates exist", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const file = join(dir, "src", "foo.ts");
      // 5 candidate mutants — every line has a comparison.
      await Bun.write(file, `${["a == b", "c == d", "e == f", "g == h", "i == j"].join("\n")}\n`);

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 5 }]]]),
        selectScopedTests: async () => ({
          effectiveCommand: "bun test",
          isFullSuite: true,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async () => {
          regressionCalls += 1;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          }),
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 2, timeoutSeconds: 60 } }),
        deps,
      );
      expect(out.success).toBe(true);
      expect(regressionCalls).toBeLessThanOrEqual(2);
      expect(out.candidates).toBe(5);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("maxMutants is a per-story budget — caps total across multiple files", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const fileA = join(dir, "src", "a.ts");
      const fileB = join(dir, "src", "b.ts");
      // 4 candidate mutants per file, 2 files → 8 candidates total.
      await Bun.write(fileA, `${["a == b", "c == d", "e == f", "g == h"].join("\n")}\n`);
      await Bun.write(fileB, `${["i == j", "k == l", "m == n", "o == p"].join("\n")}\n`);

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [fileA, fileB],
        getChangedLineRanges: async () =>
          new Map([
            [fileA, [{ start: 1, end: 4 }]],
            [fileB, [{ start: 1, end: 4 }]],
          ]),
        selectScopedTests: async () => ({
          effectiveCommand: "bun test",
          isFullSuite: true,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async () => {
          regressionCalls += 1;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      const mutationSummaries = new Map();
      const ctx = ctxWithConfig(
        { mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } },
        { mutationSummaries },
      );
      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          }),
        },
        ctx,
        deps,
      );
      expect(mutationSummaries.get("US-004")?.candidates).toBe(8);
      expect(out.candidates).toBe(8);
      expect(out.candidates).toBeGreaterThan(regressionCalls);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — AC8: forwards storyGitRef + configured command; regression receives effectiveCommand", () => {
  test("selectScopedTests receives storyGitRef and the configured base test command; regression receives effectiveCommand", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let capturedSelectInput: Parameters<MutationCheckDeps["selectScopedTests"]>[0] | undefined;
    let capturedRegressionCommand: string | undefined;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        selectScopedTests: async (input) => {
          capturedSelectInput = input;
          return {
            effectiveCommand: "bun test src/foo.test.ts",
            isFullSuite: false,
            thresholdFallback: false,
            isMonorepoOrchestrator: false,
          };
        },
        regression: async (opts) => {
          capturedRegressionCommand = opts.command;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "deadbeef",
          repoRoot: dir,
          resolvedTestPatterns: makeResolvedTestPatterns({
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          }),
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      assertDefined(capturedSelectInput, "selectScopedTests input");
      expect(capturedSelectInput.storyGitRef).toBe("deadbeef");
      expect(capturedSelectInput.testCommand).toBe("bun test");
      expect(capturedRegressionCommand).toBe("bun test src/foo.test.ts");
    } finally {
      cleanupTempDir(dir);
    }
  });
});
