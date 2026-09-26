/**
 * run-cleanup.ts — US-004: the end-of-run temp-directory wipe.
 *
 * `cleanupRun` is the finally block of `runner.run()`. The run's temp root
 * (`/tmp/nax-<runId>`) must go away at the end of EVERY real run — completed
 * or failed — because a failed run's `/tmp` files are not kept for inspection:
 * no later run can find them to clear. That is the one gate that differs from
 * the scratchpad wipe, which retains a failed run's scratchpad for inspection.
 *
 * A dry run is a preview, not a mutation, so it is skipped outright.
 *
 * The seam under test is `_runCleanupDeps.wipeRunTmp`; each test injects a fake
 * and asserts whether it was invoked, and with which run id.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makePluginRegistry, makePRD } from "@test/helpers";
import { _runCleanupDeps, cleanupRun } from "@/execution";
import type { RunCleanupOptions } from "@/execution/lifecycle/run-cleanup";

function makeCleanupOptions(overrides: Partial<RunCleanupOptions> = {}): RunCleanupOptions {
  return {
    runId: "r1",
    startTime: Date.now() - 1000,
    totalCost: 0,
    storiesCompleted: 0,
    prd: makePRD({ feature: "us004-run-tmp" }),
    pluginRegistry: makePluginRegistry(),
    workdir: "/tmp/us004-run-tmp",
    interactionChain: null,
    feature: "us004-run-tmp",
    prdPath: "/tmp/us004-run-tmp/.nax/features/us004-run-tmp/prd.json",
    branch: "feat/us004",
    version: "1.0.0",
    hooks: { hooks: {} },
    dryRun: false,
    ...overrides,
  };
}

describe("cleanupRun — US-004: end-of-run temp-directory wipe", () => {
  const originalWipeRunTmp = _runCleanupDeps.wipeRunTmp;
  let wipeCalls: Array<{ runId: string; opts?: { dryRun?: boolean } }>;

  beforeEach(() => {
    wipeCalls = [];
  });

  afterEach(() => {
    _runCleanupDeps.wipeRunTmp = originalWipeRunTmp;
  });

  function stubWipe() {
    _runCleanupDeps.wipeRunTmp = mock(async (runId: string, opts?: { dryRun?: boolean }) => {
      wipeCalls.push({ runId, opts });
    }) as typeof _runCleanupDeps.wipeRunTmp;
  }

  test("US-004 AC17: a failed run still wipes its temp root", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ runId: "r1", runCompleted: false, dryRun: false }));

    // Unlike the scratchpad wipe, this one is NOT gated on runCompleted: a
    // failed run's /tmp files are unreachable by any later run.
    expect(wipeCalls.map((call) => call.runId)).toEqual(["r1"]);
  });

  test("US-004 AC17 boundary: a completed run also wipes its temp root", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ runId: "r1", runCompleted: true, dryRun: false }));

    expect(wipeCalls.map((call) => call.runId)).toEqual(["r1"]);
  });

  test("US-004 AC17 boundary: no runCompleted (abnormal exit) also wipes its temp root", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ runId: "r1", dryRun: false }));

    expect(wipeCalls.map((call) => call.runId)).toEqual(["r1"]);
  });

  test("US-004 AC18: a dry run does not wipe", async () => {
    stubWipe();

    await cleanupRun(makeCleanupOptions({ runId: "r1", runCompleted: true, dryRun: true }));

    expect(wipeCalls).toHaveLength(0);
  });
});
