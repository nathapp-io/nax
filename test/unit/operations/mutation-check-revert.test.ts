import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMutationCheckDeps as fakeDeps,
  makeMutationCheckCtx,
  makeResolvedTestPatterns,
  makeStory,
  makeTempDir,
  withInfoSpy,
} from "@test/helpers";
import type { MutationCheckDeps, MutationCheckInput, MutationCheckOutput } from "@/operations";
import { _mutationCheckDeps, mutationCheckOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { applyMutant, journalPathFor, recordInFlight } from "@/verification";

const FAKE_STORY = makeStory({ id: "US-004", title: "mutation-check op" });

const ctxWithConfig = (
  execution: Record<string, unknown> = {},
  runtime: Partial<NaxRuntime> = {},
  quality?: Record<string, unknown>,
) => makeMutationCheckCtx(execution, { runtime, ...(quality ? { quality } : {}) });

const originalMutationCheckDeps = { ..._mutationCheckDeps };
afterEach(() => Object.assign(_mutationCheckDeps, originalMutationCheckDeps));

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
      // File must be restored to its original contents after the throw.
      const after = await Bun.file(file).text();
      expect(after).toBe(`${originalLine}\n`);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

const PATTERNS = makeResolvedTestPatterns({
  globs: ["**/*.test.ts"],
  regex: [/\.test\.ts$/],
  pathspec: [":!*.test.ts"],
  testDirs: ["test"],
});

function runInput(dir: string): MutationCheckInput {
  return {
    story: FAKE_STORY,
    workdir: dir,
    storyId: "US-004",
    storyGitRef: "abc",
    repoRoot: dir,
    resolvedTestPatterns: PATTERNS,
  };
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
          return { status: "TEST_FAILURE" as const, success: false, countsTowardEscalation: true, output: "1 fail" };
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
      // The tree now holds a line this op did not author, so auto-commit must
      // be blocked for it — otherwise `git add -A` sweeps the injected defect
      // into a commit and, under autoPR, a push.
      expect([...ctx.runtime.dirtyWorktrees]).toEqual([dir]);
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
      // A confirmed revert must not block commits.
      expect([...ctx.runtime.dirtyWorktrees]).toEqual([]);
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
        },
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
        },
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
        },
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

  test("a disabled check with a clean tree spawns no git", async () => {
    // The feature is off by default, so every nax user would otherwise pay a
    // `git rev-parse` subprocess per story for a feature they never enabled.
    const dir = makeTempDir("nax-mutation-nospawn-");
    try {
      let gitRootCalls = 0;
      const out = await mutationCheckOp.execute(
        runInput(dir),
        ctxWithConfig({ mutationCheck: { enabled: false, maxMutants: 3, timeoutSeconds: 60 } }),
        fakeDeps({
          getGitRoot: async () => {
            gitRootCalls += 1;
            return dir;
          },
        }),
      );

      expect(out.checked).toBe(false);
      expect(gitRootCalls).toBe(0);
    } finally {
      cleanupTempDir(dir);
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

/**
 * Outcome telemetry for the mutation spot-check (G12).
 *
 * The gate computes `outcomes {killed, survived, errored}` and `candidates`, but
 * before this they reached only an in-memory `NaxRuntime.mutationSummaries` map
 * and stdout. Only survivors were ever written to the run JSONL, so a run where
 * every mutant was killed left no durable trace at all — leaving the kill rate
 * and the false-alarm rate uncomputable from run artifacts, which is exactly
 * what the soft-gate decision needs.
 *
 * These tests pin the durable record: emitted with the full counts whenever the
 * gate actually ran, and silent when it did not.
 */
const TELEMETRY_STORY = makeStory({ id: "US-004", title: "mutation-check telemetry" });
const TELEMETRY_ENABLED = { enabled: true, maxMutants: 3, timeoutSeconds: 60 };

/**
 * Drive the op to completion against a single one-line mutable source file, and
 * return the `mutation-check` info records it emitted.
 */
async function runAndCaptureInfo(
  regressionResult: {
    status: "SUCCESS" | "TEST_FAILURE" | "TIMEOUT" | "ENVIRONMENTAL_FAILURE" | "ASSET_CHECK_FAILED";
    passCount?: number;
    failCount?: number;
  },
  mutationsConfig: Record<string, unknown> = TELEMETRY_ENABLED,
  opts: { depsOverrides?: Partial<MutationCheckDeps>; quality?: Record<string, unknown> } = {},
): Promise<{ calls: unknown[][]; out: MutationCheckOutput }> {
  const dir = makeTempDir("nax-mutation-telemetry-");
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
      ...(opts.depsOverrides ?? {}),
    });

    return await withInfoSpy(async (infoSpy) => {
      const out = await mutationCheckOp.execute(
        {
          story: TELEMETRY_STORY,
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
        ctxWithConfig({ mutationCheck: mutationsConfig }, {}, opts.quality),
        deps,
      );
      const calls = infoSpy.mock.calls.filter((c) => c[0] === "mutation-check");
      return { calls, out };
    });
  } finally {
    cleanupTempDir(dir);
  }
}

describe("mutationCheckOp — outcome telemetry is durable (G12)", () => {
  test("emits one mutation-check info record when the gate ran; storyId is the first key in the record's data object; a completed check carries no skipReason", async () => {
    const { calls } = await runAndCaptureInfo({ status: "TEST_FAILURE", failCount: 1 });
    expect(calls.length).toBe(1);
    expect(Object.keys(calls[0]?.[2] as object)[0]).toBe("storyId");
    expect(calls[0]?.[2]).not.toHaveProperty("skipReason");
  });

  test("the record carries the full outcome counts and the candidate denominator", async () => {
    const { calls, out } = await runAndCaptureInfo({ status: "TEST_FAILURE", failCount: 1 });
    const data = calls[0]?.[2] as Record<string, unknown>;
    expect(data).toMatchObject({
      killed: out.outcomes.killed,
      survived: out.outcomes.survived,
      errored: out.outcomes.errored,
      candidates: out.candidates,
    });
  });

  /**
   * The whole point of the change: an all-killed run previously wrote NOTHING to
   * disk, because only survivors were logged. Without this the numerator has no
   * denominator and the kill rate cannot be computed.
   */
  test("emits even when every mutant was killed and there are no survivors", async () => {
    const { calls, out } = await runAndCaptureInfo({ status: "TEST_FAILURE", failCount: 1 });
    expect(out.survivors.length).toBe(0);
    expect(out.outcomes.killed).toBeGreaterThan(0);
    expect(calls.length).toBe(1);
    expect((calls[0]?.[2] as { killed: number } | undefined)?.killed).toBe(out.outcomes.killed);
  });

  /**
   * The inverse direction. `mutationCheck` is default-off for every repo but
   * nax's own, so a disabled gate must stay silent rather than emit a row of
   * zeroes that would read as a real all-errored measurement.
   */
  test("stays silent when the gate is disabled", async () => {
    const { calls, out } = await runAndCaptureInfo({ status: "SUCCESS" }, { enabled: false });
    expect(out.checked).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("stays silent when no test command is configured", async () => {
    const { calls, out } = await runAndCaptureInfo({ status: "SUCCESS" }, TELEMETRY_ENABLED, { quality: {} });
    expect(out.checked).toBe(false);
    expect(calls.length).toBe(0);
  });

  /**
   * The gate got past the enabled check but bailed before mutating anything, so
   * it reports `checked: true` with nothing measured. The record still has to be
   * emitted — an absent row is indistinguishable from a story the gate never
   * reached — but it must say WHY, or a bail is silently counted as a real
   * zero-candidate measurement.
   */
  test("emits with a skipReason when the gate bailed before mutating anything", async () => {
    const { calls, out } = await runAndCaptureInfo({ status: "SUCCESS" }, TELEMETRY_ENABLED, {
      depsOverrides: { getChangedLineRanges: async () => null },
    });
    expect(out.checked).toBe(true);
    expect(out.candidates).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]?.[2]).toMatchObject({
      killed: 0,
      survived: 0,
      errored: 0,
      candidates: 0,
      skipReason: "changed-line-ranges-unavailable",
    });
  });
});

/**
 * A story whose worktree was left holding an injected mutation is exactly the
 * context an analyst needs beside the counts — the numbers describe a tree that
 * is not the one the tests were written against.
 */
describe("mutationCheckOp — outcome telemetry flags an unrestored worktree", () => {
  test("carries revertFailed when a revert could not be confirmed", async () => {
    const dir = makeTempDir("nax-mutation-telemetry-dirty-");
    try {
      const file = join(dir, "src", "foo.ts");
      await Bun.write(file, "if (a == b) { return 1; }\n");
      const hijacked = "SOMEONE ELSE WROTE THIS\n";

      const deps = fakeDeps({
        getChangedNonTestFiles: async () => [file],
        getChangedLineRanges: async () => new Map([[file, [{ start: 1, end: 1 }]]]),
        regression: async () => {
          // Simulate a formatter rewriting the mutated line mid-check.
          await Bun.write(file, hijacked);
          return { status: "TEST_FAILURE" as const, success: false, countsTowardEscalation: true, output: "1 fail" };
        },
      });

      const { calls, out } = await withInfoSpy(async (infoSpy) => {
        const out = await mutationCheckOp.execute(
          {
            story: TELEMETRY_STORY,
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
          ctxWithConfig({ mutationCheck: TELEMETRY_ENABLED }),
          deps,
        );
        return { calls: infoSpy.mock.calls.filter((c) => c[0] === "mutation-check"), out };
      });

      expect(out.revertFailed).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0]?.[2]).toMatchObject({ revertFailed: true });
    } finally {
      cleanupTempDir(dir);
    }
  });
});
