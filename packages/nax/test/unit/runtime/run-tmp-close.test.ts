import { afterEach, describe, expect, mock, test } from "bun:test";
import { withWarnSpy } from "@test/helpers";
import { STALE_RUN_TMP_MAX_AGE_MS } from "@/execution/lifecycle/run-tmp-sweep";
import { _runTmpCloseDeps, closeRunTmp } from "@/runtime/run-tmp-close";

const saved = { ..._runTmpCloseDeps };
afterEach(() => Object.assign(_runTmpCloseDeps, saved));

describe("closeRunTmp", () => {
  test("wipes before sweeping with the run id, clock and age", async () => {
    const calls: string[] = [];
    _runTmpCloseDeps.now = () => 123;
    _runTmpCloseDeps.wipeRunTmp = async (id) => {
      calls.push(`wipe:${id}`);
    };
    const sweep = mock(async () => {
      calls.push("sweep");
    });
    _runTmpCloseDeps.sweepStaleRunTmpRoots = sweep;
    await closeRunTmp({ runId: "r1", dryRun: false });
    expect(calls).toEqual(["wipe:r1", "sweep"]);
    expect(sweep).toHaveBeenCalledWith({ currentRunId: "r1", now: 123, maxAgeMs: STALE_RUN_TMP_MAX_AGE_MS });
  });
  test("dry runs do nothing", async () => {
    const wipe = mock(async () => {});
    const sweep = mock(async () => {});
    _runTmpCloseDeps.wipeRunTmp = wipe;
    _runTmpCloseDeps.sweepStaleRunTmpRoots = sweep;
    await closeRunTmp({ runId: "r1", dryRun: true });
    expect(wipe).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });
  test("continues after wipe failure and absorbs sweep failure", async () => {
    _runTmpCloseDeps.wipeRunTmp = async () => {
      throw new Error("wipe");
    };
    const sweep = mock(async () => {
      throw new Error("sweep");
    });
    _runTmpCloseDeps.sweepStaleRunTmpRoots = sweep;
    await withWarnSpy(async (warn) => {
      await expect(closeRunTmp({ runId: "r1", dryRun: false })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]?.[1]).toContain("Failed to sweep");
    });
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
