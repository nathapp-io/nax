import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _mutationCheckDeps, mutationCheckOp } from "@/operations";
import type { MutationCheckDeps } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { applyMutant, journalPathFor, recordInFlight } from "@/verification";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const FAKE_STORY = { id: "US-004", title: "mutation-check op" } as any;

function ctxWithConfig(execution: Record<string, unknown> = {}, runtime: Partial<NaxRuntime> = {}): any {
  const config = { execution, quality: { commands: { test: "bun test" } } } as any;
  return {
    runtime: { mutationSummaries: new Map(), ...runtime },
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
    getChangedLineRanges: async () => new Map(),
    getGitRoot: async () => null,
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

describe("mutationCheckOp — AC9: regression throw still reverts and reports success", () => {
  test("restores file when regression throws and returns success=true", async () => {
    const dir = makeTempDir("nax-mutation-test-");
    try {
      const file = join(dir, "src", "foo.ts");
      const originalLine = "if (a == b) { return 1; }";
      await Bun.write(file, `${originalLine}\n`);

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

const PATTERNS = {
  globs: ["**/*.test.ts"],
  regex: [/\.test\.ts$/],
  pathspec: [":!*.test.ts"],
  testDirs: ["test"],
};

function runInput(dir: string) {
  return {
    story: FAKE_STORY,
    workdir: dir,
    storyId: "US-004",
    storyGitRef: "abc",
    repoRoot: dir,
    resolvedTestPatterns: PATTERNS,
  } as any;
}

const ENABLED = { mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 } };

describe("mutationCheckOp — an unconfirmed revert stops the check", () => {
  test("a test run that rewrites the mutated line leaves the file alone and flags the story", async () => {
    const dir = makeTempDir("nax-mutation-dirty-");
    try {
      const file = join(dir, "src", "foo.ts");
      // Three mutable lines, so a second mutant would follow if we didn't stop.
      await Bun.write(file, "if (a == b) { return 1; }\nif (c == d) { return 2; }\nif (e == f) { return 3; }\n");
      const hijacked = "SOMEONE ELSE WROTE THIS\nif (c == d) { return 2; }\nif (e == f) { return 3; }\n";

      let regressionCalls = 0;
      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 3 }]]]),
        regression: async () => {
          regressionCalls += 1;
          // Simulate a formatter/codegen step rewriting the mutated line.
          await Bun.write(file, hijacked);
          return { status: "FAILURE" as const, success: false, countsTowardEscalation: true, output: "1 fail" };
        },
      });

      const ctx = ctxWithConfig(ENABLED);
      const out = await mutationCheckOp.execute(runInput(dir), ctx, deps);

      expect(out.success).toBe(true);
      expect(out.revertFailed).toBe(true);
      // The foreign write survives — nothing was restored over it.
      expect(await Bun.file(file).text()).toBe(hijacked);
      // Stopped after the first mutant rather than compounding.
      expect(regressionCalls).toBe(1);
      expect(ctx.runtime.mutationSummaries.get("US-004")?.revertFailed).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("a clean run reports no revertFailed and leaves no journal behind", async () => {
    const dir = makeTempDir("nax-mutation-clean-");
    try {
      const file = join(dir, "src", "foo.ts");
      const original = "if (a == b) { return 1; }\n";
      await Bun.write(file, original);

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
      });

      const ctx = ctxWithConfig(ENABLED);
      const out = await mutationCheckOp.execute(runInput(dir), ctx, deps);

      expect(out.revertFailed).toBeUndefined();
      expect(await Bun.file(file).text()).toBe(original);
      expect(await Bun.file(journalPathFor(dir, "US-004")).exists()).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("mutationCheckOp — leftover mutations from an interrupted run", () => {
  test("a journalled mutation is restored on the next run", async () => {
    const dir = makeTempDir("nax-mutation-leftover-");
    try {
      const file = join(dir, "src", "foo.ts");
      const original = "if (a == b) { return 1; }\n";
      await Bun.write(file, original);

      // Exactly the state a SIGKILL between apply and revert leaves.
      await recordInFlight(dir, {
        storyId: "US-999",
        file,
        line: 1,
        before: "if (a == b) { return 1; }",
        after: "if (a != b) { return 1; }",
        operatorId: "ts:cmp-flip",
      });
      await applyMutant({
        file,
        line: 1,
        before: "if (a == b) { return 1; }",
        after: "if (a != b) { return 1; }",
        operatorId: "ts:cmp-flip",
      });

      const deps = fakeDeps({ getChangedNonTestFiles: async () => [] });
      await mutationCheckOp.execute(runInput(dir), ctxWithConfig(ENABLED), deps);

      expect(await Bun.file(file).text()).toBe(original);
      expect(await Bun.file(journalPathFor(dir, "US-999")).exists()).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("the journal follows the worktree, not the shared project root", async () => {
    // Parallel mode: every story gets its own git worktree, but repoRoot
    // (ctx.projectDir) stays the shared main repo. Anchoring the journal there
    // gives all concurrent stories ONE journal directory, so one story's sweep
    // restores another story's in-flight mutation.
    //
    // The journal is deleted once the revert is confirmed, so asserting after
    // the run proves nothing — both anchors look identical by then. The only
    // moment the journal is observable is while a mutant is applied, which is
    // exactly when `regression` is called.
    const projectRoot = makeTempDir("nax-mutation-project-");
    const worktree = join(projectRoot, ".nax-wt", "US-004");
    try {
      const file = join(worktree, "src", "a.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const seen: Array<{ inWorktree: boolean; inProjectRoot: boolean }> = [];
      const deps = fakeDeps({
        getGitRoot: async (dir: string) => dir,
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        regression: async () => {
          seen.push({
            inWorktree: await Bun.file(journalPathFor(worktree, "US-004")).exists(),
            inProjectRoot: await Bun.file(journalPathFor(projectRoot, "US-004")).exists(),
          });
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: worktree,
          storyId: "US-004",
          storyGitRef: "abc",
          repoRoot: projectRoot,
          resolvedTestPatterns: PATTERNS,
        } as any,
        ctxWithConfig(ENABLED),
        deps,
      );

      expect(seen.length).toBeGreaterThan(0);
      for (const observation of seen) {
        expect(observation.inWorktree).toBe(true);
        expect(observation.inProjectRoot).toBe(false);
      }
    } finally {
      cleanupTempDir(projectRoot);
    }
  });

  test("a monorepo workdir still journals into the worktree root, not the package dir", async () => {
    // `workdir` is `join(worktreePath, story.workdir)` — the PACKAGE dir, not
    // the worktree root. Anchoring through getGitRoot is what absorbs that:
    // `git rev-parse --show-toplevel` from inside a linked worktree returns
    // the worktree, whatever subdirectory it is run from. This stub mimics
    // that containment rather than echoing its argument.
    const projectRoot = makeTempDir("nax-mutation-mono-");
    const worktree = join(projectRoot, ".nax-wt", "US-004");
    const packageDir = join(worktree, "packages", "api");
    try {
      const file = join(packageDir, "src", "a.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");

      const seen: Array<{ atWorktree: boolean; atPackage: boolean; atProjectRoot: boolean }> = [];
      const deps = fakeDeps({
        getGitRoot: async (dir: string) => (dir.startsWith(worktree) ? worktree : projectRoot),
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        regression: async () => {
          seen.push({
            atWorktree: await Bun.file(journalPathFor(worktree, "US-004")).exists(),
            atPackage: await Bun.file(journalPathFor(packageDir, "US-004")).exists(),
            atProjectRoot: await Bun.file(journalPathFor(projectRoot, "US-004")).exists(),
          });
          return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" };
        },
      });

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: packageDir,
          storyId: "US-004",
          storyGitRef: "abc",
          repoRoot: projectRoot,
          packagePrefix: "packages/api",
          resolvedTestPatterns: PATTERNS,
        } as any,
        ctxWithConfig(ENABLED),
        deps,
      );

      expect(seen.length).toBeGreaterThan(0);
      for (const observation of seen) {
        expect(observation.atWorktree).toBe(true);
        expect(observation.atPackage).toBe(false);
        expect(observation.atProjectRoot).toBe(false);
      }
    } finally {
      cleanupTempDir(projectRoot);
    }
  });

  test("a sweep never reaches into a sibling worktree's journal", async () => {
    const projectRoot = makeTempDir("nax-mutation-siblings-");
    const worktreeA = join(projectRoot, ".nax-wt", "US-004");
    const worktreeB = join(projectRoot, ".nax-wt", "US-005");
    try {
      const fileB = join(worktreeB, "src", "b.ts");
      const mutatedB = "if (a != b) { return 1; }\n";
      await Bun.write(fileB, mutatedB);
      // Story B is mid-check: journalled and applied, not yet reverted.
      await recordInFlight(worktreeB, {
        storyId: "US-005",
        file: fileB,
        line: 1,
        before: "if (a == b) { return 1; }",
        after: "if (a != b) { return 1; }",
        operatorId: "ts:cmp-flip",
      });

      const fileA = join(worktreeA, "src", "a.ts");
      await Bun.write(fileA, "if (c == d) { return 2; }\n");

      await mutationCheckOp.execute(
        {
          story: FAKE_STORY,
          workdir: worktreeA,
          storyId: "US-004",
          storyGitRef: "abc",
          repoRoot: projectRoot,
          resolvedTestPatterns: PATTERNS,
        } as any,
        ctxWithConfig(ENABLED),
        fakeDeps({
          getGitRoot: async (dir: string) => dir,
          getChangedNonTestFiles: async () => [fileA],
          getChangedLineRanges: async () => new Map([[fileA, [{ start: 1, end: 1 }]]]),
        }),
      );

      // B's in-flight mutation and its journal survive A's sweep untouched.
      expect(await Bun.file(fileB).text()).toBe(mutatedB);
      expect(await Bun.file(journalPathFor(worktreeB, "US-005")).exists()).toBe(true);
    } finally {
      cleanupTempDir(projectRoot);
    }
  });

  test("the sweep still runs when the check is disabled", async () => {
    const dir = makeTempDir("nax-mutation-leftover-off-");
    try {
      const file = join(dir, "src", "foo.ts");
      const original = "if (a == b) { return 1; }\n";
      await Bun.write(file, original);
      const mutant = {
        file,
        line: 1,
        before: "if (a == b) { return 1; }",
        after: "if (a != b) { return 1; }",
        operatorId: "ts:cmp-flip",
      };
      await recordInFlight(dir, { ...mutant, storyId: "US-999" });
      await applyMutant(mutant);

      // Turning the feature off must not strand a mutation in the worktree.
      const out = await mutationCheckOp.execute(
        runInput(dir),
        ctxWithConfig({ mutationCheck: { enabled: false, maxMutants: 3, timeoutSeconds: 60 } }),
        fakeDeps(),
      );

      expect(out.checked).toBe(false);
      expect(await Bun.file(file).text()).toBe(original);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
