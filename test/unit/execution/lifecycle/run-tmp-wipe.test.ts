/**
 * US-004 — `wipeRunTmp` removes the run's own temp root.
 *
 * Mirrors `wipeScratchpad` (src/execution/lifecycle/scratchpad-wipe.ts): a
 * `_runTmpWipeDeps.remove` seam, absence tolerated, and any other failure
 * logged at warn and swallowed. A temp directory must never wedge a run, and a
 * failure to remove one is worth a record but not a failure verdict.
 *
 * Only the run's OWN `runTmpRoot(runId)` is removed. US-001 moved that root
 * under the shared `/tmp/nax` parent, so the distinction now matters twice
 * over: removing the parent would take a concurrent run's live directories with
 * it, and it would also take the directory the next run is about to use.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { stubSessionTmpDeps, withDepsRestore, withWarnSpy } from "@test/helpers";
import { _runTmpWipeDeps, wipeRunTmp } from "@/execution/lifecycle/run-tmp-wipe";
import { _sessionTmpDeps, runTmpRoot } from "@/sandbox";

describe("wipeRunTmp (US-004)", () => {
  withDepsRestore(_runTmpWipeDeps);
  withDepsRestore(_sessionTmpDeps);

  // A pinned host: `/tmp/nax` absent, so the resolved root is host-independent.
  beforeEach(() => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });
  });

  test("US-001 AC9: removes the run's temp root once, never the shared /tmp/nax parent", async () => {
    const remove = mock(async (_path: string) => {});
    _runTmpWipeDeps.remove = remove as typeof _runTmpWipeDeps.remove;

    await wipeRunTmp("r1");

    // `runTmpRoot("r1")` under the pinned layout — never a prefix sweep, never
    // another run's directory, and never the shared parent those hang off.
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.map((call) => call[0])).toEqual(["/tmp/nax/r1"]);
    expect(remove.mock.calls.map((call) => call[0])).not.toContain("/tmp/nax");
  });

  test("US-001 AC9 boundary: wiping one run leaves a concurrent run's directory alone", async () => {
    const removed: string[] = [];
    _runTmpWipeDeps.remove = mock(async (path: string) => {
      removed.push(path);
    }) as typeof _runTmpWipeDeps.remove;

    await wipeRunTmp("r1");

    expect(removed).toEqual(["/tmp/nax/r1"]);
    expect(removed).not.toContain(runTmpRoot("r2"));
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
    expect(existsSync(runTmpRoot("us004-no-such-run"))).toBe(false);

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
