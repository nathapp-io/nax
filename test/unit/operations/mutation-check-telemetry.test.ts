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

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _mutationCheckDeps, mutationCheckOp } from "@/operations";
import type { MutationCheckDeps } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import {
  cleanupTempDir,
  makeMutationCheckDeps as fakeDeps,
  makeMutationCheckCtx,
  makeResolvedTestPatterns,
  makeTempDir,
  withInfoSpy,
} from "@test/helpers";

const FAKE_STORY = { id: "US-004", title: "mutation-check telemetry" } as any;
const ENABLED = { enabled: true, maxMutants: 3, timeoutSeconds: 60 };

const ctxWithConfig = (
  execution: Record<string, unknown> = {},
  runtime: Partial<NaxRuntime> = {},
  quality?: Record<string, unknown>,
) => makeMutationCheckCtx(execution, { runtime, ...(quality ? { quality } : {}) });

const originalMutationCheckDeps = { ..._mutationCheckDeps };
afterEach(() => Object.assign(_mutationCheckDeps, originalMutationCheckDeps));

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
  mutationsConfig: Record<string, unknown> = ENABLED,
  opts: { depsOverrides?: Partial<MutationCheckDeps>; quality?: Record<string, unknown> } = {},
): Promise<{ calls: unknown[][]; out: any }> {
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
  test("emits one mutation-check info record when the gate ran", async () => {
    const { calls } = await runAndCaptureInfo({ status: "TEST_FAILURE", failCount: 1 });
    expect(calls.length).toBe(1);
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
    expect((calls[0]?.[2] as { killed: number }).killed).toBe(out.outcomes.killed);
  });

  test("storyId is the first key in the record's data object", async () => {
    const { calls } = await runAndCaptureInfo({ status: "TEST_FAILURE", failCount: 1 });
    expect(Object.keys(calls[0]?.[2] as object)[0]).toBe("storyId");
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
    const { calls, out } = await runAndCaptureInfo({ status: "SUCCESS" }, ENABLED, { quality: {} });
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
    const { calls, out } = await runAndCaptureInfo({ status: "SUCCESS" }, ENABLED, {
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

  test("a completed check carries no skipReason", async () => {
    const { calls } = await runAndCaptureInfo({ status: "TEST_FAILURE", failCount: 1 });
    expect(calls[0]?.[2]).not.toHaveProperty("skipReason");
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
          ctxWithConfig({ mutationCheck: ENABLED }),
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
