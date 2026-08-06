import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _mutationCheckDeps, mutationCheckOp } from "@/operations";
import type { MutationCheckDeps } from "@/operations";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const FAKE_STORY = { id: "US-004", title: "mutation-check op" } as any;

function ctxWithConfig(execution: Record<string, unknown> = {}): any {
  const config = { execution, quality: { commands: { test: "bun test" } } } as any;
  return {
    runtime: {},
    storyId: "US-004",
    packageView: {
      packageDir: "packages/agent",
      repoRoot: "/repo",
      hasOverride: false,
      config,
      select: (s: any) => s.select(config),
    },
  } as any;
}

const originalMutationCheckDeps = { ..._mutationCheckDeps };
afterEach(() => Object.assign(_mutationCheckDeps, originalMutationCheckDeps));

function fakeDeps(overrides: Partial<MutationCheckDeps> = {}): MutationCheckDeps {
  return {
    detectLanguage: async () => "typescript" as any,
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
    ...overrides,
  };
}

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
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
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
        selectScopedTests: async () => ({
          effectiveCommand: "bun test src/foo.test.ts",
          isFullSuite: false,
          thresholdFallback: false,
          isMonorepoOrchestrator: false,
        }),
        regression: async (opts: any) => {
          capturedRegressionCommand = opts.command;
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      const out = await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc123",
          repoRoot: dir,
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
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

describe("mutationCheckOp — AC4: TEST_FAILURE kills the mutant", () => {
  test("returns empty survivors when regression returns TEST_FAILURE with failCount = 1", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
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
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
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
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
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

  test("AC12: SUCCESS -> outcomes.survived is 1", async () => {
    const out = await runWithRegression({ status: "SUCCESS" });
    expect(out.outcomes.survived).toBe(1);
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
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
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
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
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
        detectLanguage: async () => "python" as any,
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
          resolvedTestPatterns: {
            globs: ["**/*.py"],
            regex: [/test_.*\.py$/],
            pathspec: [":!test_*.py"],
            testDirs: ["tests"],
          },
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
        detectLanguage: async () => undefined as any,
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
          resolvedTestPatterns: {
            globs: ["**/*.unknown"],
            regex: [/test_.*\.unknown$/],
            pathspec: [":!test_*.unknown"],
            testDirs: ["tests"],
          },
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
      await Bun.write(file, ["a == b", "c == d", "e == f", "g == h", "i == j"].join("\n") + "\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
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
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 2, timeoutSeconds: 60 } }),
        deps,
      );
      expect(out.success).toBe(true);
      expect(regressionCalls).toBeLessThanOrEqual(2);
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
      await Bun.write(fileA, ["a == b", "c == d", "e == f", "g == h"].join("\n") + "\n");
      await Bun.write(fileB, ["i == j", "k == l", "m == n", "o == p"].join("\n") + "\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [fileA, fileB],
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

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: dir,
          storyId: "US-004",
          storyGitRef: "abc",
          repoRoot: dir,
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );
      // Per-story budget = 3, NOT per-file. Two files × 3 max = 6 would be wrong.
      expect(regressionCalls).toBeLessThanOrEqual(3);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — AC8: forwards storyGitRef + configured command; regression receives effectiveCommand", () => {
  test("selectScopedTests receives storyGitRef and the configured base test command; regression receives effectiveCommand", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    let capturedSelectInput: any = undefined;
    let capturedRegressionCommand: string | undefined;
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        selectScopedTests: async (input: any) => {
          capturedSelectInput = input;
          return {
            effectiveCommand: "bun test src/foo.test.ts",
            isFullSuite: false,
            thresholdFallback: false,
            isMonorepoOrchestrator: false,
          };
        },
        regression: async (opts: any) => {
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
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(capturedSelectInput).toBeDefined();
      expect(capturedSelectInput.storyGitRef).toBe("deadbeef");
      expect(capturedSelectInput.testCommand).toBe("bun test");
      expect(capturedRegressionCommand).toBe("bun test src/foo.test.ts");
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — AC9: regression throw still reverts and reports success", () => {
  test("restores file when regression throws and returns success=true", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      const originalLine = "if (a == b) { return 1; }";
      await Bun.write(file, `${originalLine}\n`);

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
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
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":!*.test.ts"],
            testDirs: ["test"],
          },
        },
        ctxWithConfig({ mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } }),
        deps,
      );

      expect(out.success).toBe(true);
      // File must be restored to its original contents after the throw.
      const after = await Bun.file(file).text();
      expect(after).toBe(`${originalLine}\n`);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
