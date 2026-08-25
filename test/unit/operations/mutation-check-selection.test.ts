/**
 * mutationCheckOp — US-002 selection coverage.
 *
 * Verifies the operation applies `selectEvenlySpaced` over the combined
 * candidate list after gathering mutants from every changed file:
 *  - caps regression invocations to `maxMutants` exactly (AC11)
 *  - spreads survivors across files when budget is tight (AC12)
 *  - never invokes regression when no candidates are produced (AC13)
 *  - returns the all-zero outcomes contract for an empty selection (AC14)
 *
 * Separate from mutation-check.test.ts because co-locating would push that
 * file over the 800-line test limit; the shared fixtures both use live in
 * test/helpers/mutation-check.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMutationCheckCtx as ctxWithConfig,
  makeMutationCheckDeps as fakeDeps,
  makeResolvedTestPatterns,
  makeTempDir,
} from "@test/helpers";
import { _mutationCheckDeps, mutationCheckOp } from "@/operations";

const FAKE_STORY = { id: "US-004", title: "mutation-check op" } as any;

const originalMutationCheckDeps = { ..._mutationCheckDeps };
afterEach(() => Object.assign(_mutationCheckDeps, originalMutationCheckDeps));

describe("mutationCheckOp — US-002 AC11: regression capped to maxMutants even with many candidates in one file", () => {
  test("maxMutants 2, one file with 8 candidates, regression TEST_FAILURE failCount 1 — regression invoked exactly twice", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(
        file,
        `${["a == b", "c == d", "e == f", "g == h", "i == j", "k == l", "m == n", "o == p"].join("\n")}\n`,
      );

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 8 }]]]),
        selectScopedTests: async () => ({
          effectiveCommand: "bun test",
          isFullSuite: true,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async () => {
          regressionCalls += 1;
          return {
            status: "TEST_FAILURE" as const,
            success: false,
            countsTowardEscalation: true,
            output: "1 test failed",
            passCount: 0,
            failCount: 1,
          };
        },
      });

      await mutationCheckOp.execute(
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
      expect(regressionCalls).toBe(2);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-002 AC12: even-spread selection across multiple files", () => {
  test("maxMutants 2, two files each with 8 candidates, regression SUCCESS — two survivors have distinct file values", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const fileA = join(dir, "src", "a.ts");
      const fileB = join(dir, "src", "b.ts");
      await Bun.write(
        fileA,
        `${["a == b", "c == d", "e == f", "g == h", "i == j", "k == l", "m == n", "o == p"].join("\n")}\n`,
      );
      await Bun.write(
        fileB,
        `${["q == r", "s == t", "u == v", "w == x", "y == z", "aa == bb", "cc == dd", "ee == ff"].join("\n")}\n`,
      );

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [fileA, fileB],
        getChangedLineRanges: async () =>
          new Map([
            [fileA, [{ start: 1, end: 8 }]],
            [fileB, [{ start: 1, end: 8 }]],
          ]),
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
      expect(out.survivors).toHaveLength(2);
      expect(out.survivors[0]?.file).not.toBe(out.survivors[1]?.file);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — US-002 AC13: no candidates means regression never invoked", () => {
  test("one changed file that yields no candidates — regression is never invoked", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "// just a comment\nconst x = 1;\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
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

describe("mutationCheckOp — US-002 AC14: empty selection returns all-zero outcomes and runs no tests", () => {
  test("no candidates after selection — success:true, empty survivors, all-zero outcomes, regression never invoked, scoped tests never invoked", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let regressionCalls = 0;
    let selectCalls = 0;
    try {
      const fileA = join(dir, "src", "a.ts");
      const fileB = join(dir, "src", "b.ts");
      await Bun.write(fileA, "// just a comment\nconst x = 1;\n");
      await Bun.write(fileB, "// another comment\nconst y = 2;\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [fileA, fileB],
        getChangedLineRanges: async () =>
          new Map([
            [fileA, [{ start: 1, end: 1 }]],
            [fileB, [{ start: 1, end: 1 }]],
          ]),
        selectScopedTests: async () => {
          selectCalls += 1;
          return {
            effectiveCommand: "bun test",
            isFullSuite: true,
            thresholdFallback: false,
            isMonorepoOrchestrator: false,
          };
        },
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
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );
      expect(out.success).toBe(true);
      expect(out.survivors).toEqual([]);
      expect(out.outcomes).toEqual({ killed: 0, survived: 0, errored: 0 });
      expect(regressionCalls).toBe(0);
      expect(selectCalls).toBe(0);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("scoped test selection is resolved once per story, not once per mutant", async () => {
    // Every argument comes from the op's input, none from the mutant, so this
    // is loop-invariant — N mutants used to mean N git-diff + import-grep
    // passes for an identical answer.
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\nif (c == d) { return 2; }\nif (e == f) { return 3; }\n");

      let selectCalls = 0;
      let regressionCalls = 0;
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 3 }]]]),
        selectScopedTests: async () => {
          selectCalls += 1;
          return {
            effectiveCommand: "bun test src/foo.test.ts",
            isFullSuite: false,
            thresholdFallback: false,
            isMonorepoOrchestrator: false,
          };
        },
        regression: async () => {
          regressionCalls += 1;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      await mutationCheckOp.execute(
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

      expect(regressionCalls).toBeGreaterThan(1);
      expect(selectCalls).toBe(1);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("a failed scoped selection errors every mutant without touching the worktree", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      const original = "if (a == b) { return 1; }\nif (c == d) { return 2; }\n";
      await Bun.write(file, original);

      let regressionCalls = 0;
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 2 }]]]),
        selectScopedTests: async () => {
          throw new Error("smart runner exploded");
        },
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
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      // Fail-open, and the same outcome shape as when this threw per-mutant
      // inside the loop — except no mutation was ever written to disk.
      expect(out.success).toBe(true);
      expect(out.outcomes.errored).toBeGreaterThan(0);
      expect(out.outcomes.killed + out.outcomes.survived).toBe(0);
      expect(regressionCalls).toBe(0);
      expect(await Bun.file(file).text()).toBe(original);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
