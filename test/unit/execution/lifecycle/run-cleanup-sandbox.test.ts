/**
 * run-cleanup.ts — P4: the end-of-run sandbox reset.
 *
 * The sandbox backend keeps proxy servers and (Linux) bridge processes alive
 * per process; cleanupRun is the finally block, so it is where those must come
 * down. Fail-open by design: a reset that rejects is logged at warn and the
 * run's verdict is unaffected.
 */

import { describe, expect, test } from "bun:test";
import { makePluginRegistry, makePRD, withDepsRestore } from "@test/helpers";
import { _runCleanupDeps, cleanupRun } from "@/execution";
import type { RunCleanupOptions } from "@/execution/lifecycle/run-cleanup";

function options(): RunCleanupOptions {
  return {
    runId: "run-p4",
    startTime: Date.now() - 1000,
    totalCost: 0,
    storiesCompleted: 0,
    prd: makePRD({ feature: "p4-sandbox" }),
    pluginRegistry: makePluginRegistry(),
    workdir: "/tmp/p4-sandbox",
    interactionChain: null,
    feature: "p4-sandbox",
    prdPath: "/tmp/p4-sandbox/.nax/features/p4-sandbox/prd.json",
    branch: "feat/p4",
    version: "1.0.0",
    hooks: { hooks: {} },
    dryRun: true,
  };
}

describe("cleanupRun -- P4 sandbox reset", () => {
  withDepsRestore(_runCleanupDeps, ["resetSandbox", "wipeScratchpad"]);

  test("resets the sandbox backend once", async () => {
    let resets = 0;
    _runCleanupDeps.resetSandbox = async () => {
      resets += 1;
    };
    _runCleanupDeps.wipeScratchpad = async () => {};
    await cleanupRun(options());
    expect(resets).toBe(1);
  });

  test("a failing reset does not fail cleanup", async () => {
    _runCleanupDeps.resetSandbox = async () => {
      throw new Error("bridge did not exit");
    };
    _runCleanupDeps.wipeScratchpad = async () => {};
    await expect(cleanupRun(options())).resolves.toBeUndefined();
  });
});
