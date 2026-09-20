/**
 * run-cleanup.ts — US-004: the end-of-run scratchpad wipe.
 *
 * Split out of run-cleanup.test.ts, which these cases pushed past the 800-line
 * test limit, and kept as the paired half of scratchpad-wipe.test.ts: that file
 * pins the wipe at run start, this one pins the wipe at successful completion.
 *
 * `cleanupRun` is the finally block of `runner.run()`. The scratchpad tools
 * advertise throwaway storage, so on a successful run the directory has to
 * actually go away — a stale scratchpad from a prior run is now backstopped
 * only by the next run's start wipe. The end-of-run wipe is gated on
 * `runCompleted && !dryRun` because:
 *   - a failed run's scratchpad is retained for inspection (the next run's
 *     start wipe clears it, bounded);
 *   - a dry run never wrote anything to wipe (preview is not a mutation).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makePluginRegistry, makePRD, makeTempDir, withWarnSpy } from "@test/helpers";
import { _runCleanupDeps, cleanupRun } from "@/execution";
import type { RunCleanupOptions } from "@/execution/lifecycle/run-cleanup";
import { SCRATCHPAD_DIR } from "@/tools";

function makeCleanupOptions(overrides: Partial<RunCleanupOptions> = {}): RunCleanupOptions {
  return {
    runId: "run-us004",
    startTime: Date.now() - 1000,
    totalCost: 0,
    storiesCompleted: 0,
    prd: makePRD({ feature: "us004-scratchpad" }),
    pluginRegistry: makePluginRegistry(),
    workdir: "/tmp/us004",
    interactionChain: null,
    feature: "us004-scratchpad",
    prdPath: "/tmp/us004/.nax/features/us004-scratchpad/prd.json",
    branch: "feat/us004",
    version: "1.0.0",
    hooks: { hooks: {} },
    // Required, not optional: the runner always has the flag in scope, so the
    // wipe gate is never decided by a default.
    dryRun: false,
    ...overrides,
  };
}

describe("cleanupRun — US-004: end-of-run scratchpad wipe", () => {
  // The seam under test is `_runCleanupDeps.wipeScratchpad`; the tests below
  // inject a fake and assert whether, and with what, it was invoked. Saved and
  // restored per-test so no sibling suite inherits the stub.
  const originalWipeScratchpad = _runCleanupDeps.wipeScratchpad;
  let wipeCalls: Array<{ workdir: string; opts?: { dryRun?: boolean } }>;

  beforeEach(() => {
    wipeCalls = [];
  });

  afterEach(() => {
    _runCleanupDeps.wipeScratchpad = originalWipeScratchpad;
  });

  function stubWipe() {
    _runCleanupDeps.wipeScratchpad = mock(async (workdir: string, opts?: { dryRun?: boolean }) => {
      wipeCalls.push({ workdir, opts });
    }) as typeof _runCleanupDeps.wipeScratchpad;
  }

  test("AC1: runCompleted: true and dryRun: false → invokes scratchpad removal once with <workdir>/.nax/scratchpad", async () => {
    stubWipe();
    const workdir = "/tmp/us004-end-wipe-success";

    await cleanupRun(makeCleanupOptions({ workdir, runCompleted: true, dryRun: false }));

    expect(wipeCalls).toHaveLength(1);
    // Resolved against the cleanup caller-supplied workdir — never against
    // process.cwd() or any global path.
    expect(wipeCalls[0]?.workdir).toBe(workdir);
  });

  test("AC2: runCompleted: false → does not invoke scratchpad removal", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ workdir: "/tmp/us004-end-wipe-failed", runCompleted: false, dryRun: false }));

    // Failed-run scratchpads are retained for inspection, bounded by the
    // next run's start wipe. cleanupRun must not preempt that contract.
    expect(wipeCalls).toHaveLength(0);
  });

  test("AC3: no runCompleted → does not invoke scratchpad removal", async () => {
    stubWipe();

    // No runCompleted at all — covers abnormal-exit / aborted / SIGTERM paths
    // that bypass the run-completion gate. Same retention contract as a
    // declared `runCompleted: false`.
    await cleanupRun(makeCleanupOptions({ workdir: "/tmp/us004-end-wipe-unset", dryRun: false }));

    expect(wipeCalls).toHaveLength(0);
  });

  test("AC4: dryRun: true → does not invoke scratchpad removal even when runCompleted: true", async () => {
    stubWipe();

    // A dry run never wrote to the scratchpad (no story dispatched, no tool
    // invocation) and the runner treats a preview as not a mutation. The
    // wipe must therefore stay skipped — even on the success path.
    await cleanupRun(makeCleanupOptions({ workdir: "/tmp/us004-end-wipe-dryrun", runCompleted: true, dryRun: true }));

    expect(wipeCalls).toHaveLength(0);
  });

  test("AC5: end-of-run scratchpad removal rejection → cleanupRun resolves and logs at warn", async () => {
    // Fail-open: a busy handle / permission error on the wipe must not
    // re-throw out of the finally block. The warn log is the only signal
    // that the directory survived; the caller's run still resolves cleanly.
    _runCleanupDeps.wipeScratchpad = mock(async () => {
      throw new Error("EBUSY: resource busy or locked");
    }) as typeof _runCleanupDeps.wipeScratchpad;

    await withWarnSpy(async (warnSpy) => {
      const result = await cleanupRun(
        makeCleanupOptions({ workdir: "/tmp/us004-end-wipe-fail-open", runCompleted: true, dryRun: false }),
      );

      expect(result).toBeUndefined();

      // A warn record naming the scratchpad so the operator can see which
      // directory survived — naming only "cleanup failed" would not tell
      // them where to look.
      const wipeWarn = warnSpy.mock.calls.find((call) => call[1] !== undefined && /scratchpad/i.test(call[1]));
      expect(wipeWarn).toBeDefined();
    });
  });

  test("AC1: the real wipe removes <workdir>/.nax/scratchpad and nothing beside it", async () => {
    // The AC1 test above asserts the call; this one drives the production
    // `wipeScratchpad` (left unstubbed) so the path AC1 names literally —
    // `<workdir>/.nax/scratchpad` — is what actually leaves the disk, resolved
    // against cleanupRun's workdir rather than process.cwd().
    const workdir = makeTempDir("nax-test-us004-end-wipe-");
    try {
      const parked = join(workdir, SCRATCHPAD_DIR, "notes.md");
      const siblingRunState = join(workdir, ".nax", "keep.txt");
      const projectFile = join(workdir, "keep.txt");
      await Bun.write(parked, "parked note");
      await Bun.write(siblingRunState, "not scratchpad state");
      await Bun.write(projectFile, "not scratchpad state");
      expect(existsSync(parked)).toBe(true);

      await cleanupRun(makeCleanupOptions({ workdir, runCompleted: true, dryRun: false }));

      expect(existsSync(join(workdir, SCRATCHPAD_DIR))).toBe(false);
      // Scoped to the scratchpad: run state beside it, and the project's own
      // files, are not collateral of the end-of-run wipe.
      expect(existsSync(siblingRunState)).toBe(true);
      expect(existsSync(projectFile)).toBe(true);
    } finally {
      cleanupTempDir(workdir);
    }
  });
});
