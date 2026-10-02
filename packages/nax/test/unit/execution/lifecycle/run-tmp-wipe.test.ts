/**
 * US-004 — `wipeRunTmp` removes the run's own temp root.
 *
 * Mirrors `wipeScratchpad` (src/execution/lifecycle/scratchpad-wipe.ts): a
 * `_runTmpWipeDeps.remove` seam, absence tolerated, and any other failure
 * logged at warn and swallowed. A temp directory must never wedge a run, and a
 * failure to remove one is worth a record but not a failure verdict.
 *
 * Since #2300 absence is *recorded* at debug rather than merely tolerated, which
 * needs the `_runTmpWipeDeps.exists` seam: without it an absent target is
 * indistinguishable from a target that was never looked at. The seam reports
 * absence ONLY for ENOENT — every other errno throws, because `rm`'s `force`
 * ignores ENOENT and nothing else, so a check failure has to keep reaching the
 * removal and keep being reported at warn.
 *
 * Only the run's OWN `runTmpRoot(runId)` is removed. US-001 moved that root
 * under the shared `/tmp/nax` parent, so the distinction now matters twice
 * over: removing the parent would take a concurrent run's live directories with
 * it, and it would also take the directory the next run is about to use.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _sessionTmpDeps, runTmpRoot } from "@nathapp/nax-agent/internal";
import {
  assertDefined,
  cleanupTempDir,
  makeTempDir,
  stubSessionTmpDeps,
  withDebugSpy,
  withDepsRestore,
  withWarnSpy,
} from "@test/helpers";
import { _runTmpWipeDeps, wipeRunTmp } from "@/execution/lifecycle/run-tmp-wipe";

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
    _runTmpWipeDeps.exists = () => true;

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
    _runTmpWipeDeps.exists = () => true;

    await wipeRunTmp("r1");

    expect(removed).toEqual(["/tmp/nax/r1"]);
    expect(removed).not.toContain(runTmpRoot("r2"));
  });

  test("US-004 AC15 boundary: a dry run removes nothing", async () => {
    const remove = mock(async (_path: string) => {});
    _runTmpWipeDeps.remove = remove as typeof _runTmpWipeDeps.remove;
    // Pinned present so the pass rests on the `dryRun` guard alone, not on
    // `/tmp/nax/r1` happening to be absent on this host.
    _runTmpWipeDeps.exists = () => true;

    await wipeRunTmp("r1", { dryRun: true });

    expect(remove).not.toHaveBeenCalled();
  });

  test("US-004 AC15 boundary: wiping a run whose directory does not exist resolves", async () => {
    // Absence is the ordinary case for a run that never spawned a command: the
    // production `exists` seam reports it and the wipe returns without calling
    // `remove` at all.
    expect(existsSync(runTmpRoot("us004-no-such-run"))).toBe(false);

    await expect(wipeRunTmp("us004-no-such-run")).resolves.toBeUndefined();
  });

  test("#2300: an absent target is recorded at debug and removed from nothing", async () => {
    const remove = mock(async (_path: string) => {});
    _runTmpWipeDeps.remove = remove as typeof _runTmpWipeDeps.remove;
    _runTmpWipeDeps.exists = mock(() => false) as typeof _runTmpWipeDeps.exists;

    await withDebugSpy(async (debugSpy) => {
      await wipeRunTmp("r1");

      // The record is the whole point of #2300: `rm(..., { force: true })`
      // succeeds on a missing path, so before the guard an absent target left
      // no trace at all and a wrong-id wipe was indistinguishable from a run
      // that never dispatched a command.
      const record = debugSpy.mock.calls.find((call) => call[0] === "sandbox");
      assertDefined(record, "sandbox debug record");
      expect(record[1]).toContain("/tmp/nax/r1");
      expect(record[2]?.runId).toBe("r1");
    });
    expect(remove).not.toHaveBeenCalled();
  });

  test("US-004 AC16: a rejected removal is warned about and swallowed", async () => {
    _runTmpWipeDeps.remove = mock(async () => {
      throw new Error("EBUSY: resource busy or locked");
    }) as typeof _runTmpWipeDeps.remove;
    // The rejection is the subject here, so the guard must not short-circuit
    // ahead of it — pin the target present.
    _runTmpWipeDeps.exists = () => true;

    await withWarnSpy(async (warnSpy) => {
      // Fail-open: the caller has no decision to make either way.
      await expect(wipeRunTmp("r1")).resolves.toBeUndefined();
      expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    });
  });

  // The guard has to be exactly as sure as `rm`: `rm(..., { force: true })`
  // swallows ENOENT and only ENOENT, so anything else is a failure to inspect,
  // not proof of absence. `existsSync` called both "absent" and recorded the
  // case at debug, so a run whose temp root could not be inspected said nothing
  // a reader would act on.
  test("#2300: a presence check that fails is NOT absence — remove is still tried and the failure warned", async () => {
    const remove = mock(async (_path: string) => {});
    _runTmpWipeDeps.remove = remove as typeof _runTmpWipeDeps.remove;
    _runTmpWipeDeps.exists = (): boolean => {
      throw Object.assign(new Error("EACCES: permission denied, lstat '/tmp/nax/r1'"), { code: "EACCES" });
    };

    await withWarnSpy(async (warnSpy) => {
      await expect(wipeRunTmp("r1")).resolves.toBeUndefined();

      // `remove` being reached is the load-bearing half: had the unreadable
      // path read as absent, the removal would be skipped and this warn — the
      // only record the case would leave — would never be written. The debug
      // level is deliberately not spied alongside: `withWarnSpy` resets the
      // logger, so the two cannot nest, and an absent target is already pinned
      // to debug by the test above.
      const record = warnSpy.mock.calls.find((call) => call[0] === "sandbox");
      assertDefined(record, "sandbox warn record");
      expect(record[1]).toContain("/tmp/nax/r1");
      expect(record[2]?.error).toContain("EACCES");
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.map((call) => call[0])).toEqual(["/tmp/nax/r1"]);
  });
});

/**
 * The production presence check itself, on a real filesystem case. Covered here
 * rather than through the stub because the errno split and the link handling are
 * the whole point of the check, and a stub cannot reach either.
 */
describe("_runTmpWipeDeps.exists (production)", () => {
  // Captured before any hook runs, so this is the implementation and not another
  // test's stub.
  const productionExists = _runTmpWipeDeps.exists;
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => cleanupTempDir(dir));

  test("reports a real directory as present and a missing one as absent", () => {
    mkdirSync(join(dir, "run-1"));

    expect(productionExists(join(dir, "run-1"))).toBe(true);
    expect(productionExists(join(dir, "run-none"))).toBe(false);
  });

  // `existsSync` follows the link, so a symlink to a removed target read as
  // absent and was skipped — while `rm` unlinks the link itself. A leaked entry
  // at the path is exactly what the wipe exists to prevent.
  test("a dangling symlink counts as present, because rm unlinks it", () => {
    const link = join(dir, "dangling");
    symlinkSync(join(dir, "target-never-created"), link);

    expect(existsSync(link)).toBe(false);
    expect(productionExists(link)).toBe(true);
  });

  // The errno that must NOT read as absence: an ancestor that is a file makes
  // every lstat of the path below it fail with ENOTDIR, and the path is there.
  test("a path under a non-directory ancestor is not absence — it throws, so the caller reports it", () => {
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");

    expect(() => productionExists(join(file, "run-1"))).toThrow();
  });
});
