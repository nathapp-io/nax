/**
 * US-004 — `wipeRunTmp` removes the run's own temp root.
 *
 * Mirrors `wipeScratchpad` (src/execution/lifecycle/scratchpad-wipe.ts): a
 * `_runTmpWipeDeps.remove` seam, absence tolerated, and any other failure
 * logged at warn and swallowed. A temp directory must never wedge a run, and a
 * failure to remove one is worth a record but not a failure verdict.
 *
 * Only the run's OWN `runTmpRoot(runId)` is removed — never a `/tmp/nax-*`
 * sweep, because a concurrent run's live directories share that prefix.
 */
import { describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { withDepsRestore, withWarnSpy } from "@test/helpers";
import { _runTmpWipeDeps, wipeRunTmp } from "@/execution/lifecycle/run-tmp-wipe";

describe("wipeRunTmp (US-004)", () => {
  withDepsRestore(_runTmpWipeDeps);

  test("US-004 AC15: removes the run's temp root", async () => {
    const remove = mock(async (_path: string) => {});
    _runTmpWipeDeps.remove = remove as typeof _runTmpWipeDeps.remove;

    await wipeRunTmp("r1");

    // `runTmpRoot("r1")` — never a prefix sweep, never another run's directory.
    expect(remove.mock.calls.map((call) => call[0])).toEqual(["/tmp/nax-r1"]);
  });

  test("US-004 AC15 boundary: a dry run removes nothing", async () => {
    const remove = mock(async (_path: string) => {});
    _runTmpWipeDeps.remove = remove as typeof _runTmpWipeDeps.remove;

    await wipeRunTmp("r1", { dryRun: true });

    expect(remove).not.toHaveBeenCalled();
  });

  test("US-004 AC15 boundary: wiping a run whose directory does not exist resolves", async () => {
    // The production removal primitive stays in place: absence is the ordinary
    // case for a run that never spawned a command.
    expect(existsSync("/tmp/nax-us004-no-such-run")).toBe(false);

    await expect(wipeRunTmp("us004-no-such-run")).resolves.toBeUndefined();
  });

  test("US-004 AC16: a rejected removal is warned about and swallowed", async () => {
    _runTmpWipeDeps.remove = mock(async () => {
      throw new Error("EBUSY: resource busy or locked");
    }) as typeof _runTmpWipeDeps.remove;

    await withWarnSpy(async (warnSpy) => {
      // Fail-open: the caller has no decision to make either way.
      await expect(wipeRunTmp("r1")).resolves.toBeUndefined();
      expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    });
  });
});
