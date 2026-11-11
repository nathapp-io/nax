/**
 * run-cleanup.ts — the end-of-run approvals seal (US-002 AC7/AC8).
 *
 * `cleanupRun` awaits `options.sealApprovals?.()` after the post-run actions
 * and plugin teardown and before the interaction chain is destroyed, so the
 * re-taint lands before anything else can run — and a run that was handed no
 * seal still tears down exactly as before.
 *
 * Split out of run-cleanup.test.ts, which is at the 800-line test limit.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanupTempDir, makeInteractionChain, makePluginRegistry, makePRD, makeTempDir } from "@test/helpers";
import { cleanupRun } from "@/execution";
import type { RunCleanupOptions } from "@/execution/lifecycle/run-cleanup";
import type { IPostRunAction } from "@/plugins/extensions";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

/**
 * Cleanup options that also carry the US-002 seal. The intersection keeps this
 * file compiling both before and after `RunCleanupOptions` grows the optional
 * `sealApprovals` field.
 */
type CleanupOptionsWithSeal = RunCleanupOptions & { sealApprovals?: () => Promise<void> };

/** Base options for a cleanup that touches no plugin, lock or scratchpad state. */
function makeCleanupOptions(overrides: Partial<CleanupOptionsWithSeal>): CleanupOptionsWithSeal {
  const workdir = makeTempDir("run-cleanup-seal-");
  tempDirs.push(workdir);
  return {
    runId: "run-seal-cleanup",
    startTime: Date.now() - 1000,
    totalCost: 0,
    storiesCompleted: 0,
    prd: makePRD({ userStories: [] }),
    pluginRegistry: makePluginRegistry(),
    workdir,
    interactionChain: null,
    feature: "seal-feature",
    prdPath: `${workdir}/prd.json`,
    branch: "main",
    version: "1.0.0",
    hooks: { hooks: {} },
    dryRun: false,
    ...overrides,
  };
}

/** One post-run action plus an interaction chain, both recording into `order`. */
function makeOrderedTeardown(order: string[]): {
  action: IPostRunAction;
  interactionChain: ReturnType<typeof makeInteractionChain>;
} {
  const action: IPostRunAction = {
    name: "publisher",
    description: "records that it ran",
    shouldRun: async () => true,
    execute: async () => {
      order.push("execute");
      return { success: true, message: "published" };
    },
  };
  const interactionChain = makeInteractionChain({
    destroy: mock(async () => {
      order.push("destroy");
    }),
  });
  return { action, interactionChain };
}

describe("cleanupRun — US-002 end-of-run approvals seal", () => {
  test("US-002 AC7: seals once, after the post-run action and before the interaction chain is destroyed", async () => {
    const order: string[] = [];
    const { action, interactionChain } = makeOrderedTeardown(order);
    const sealApprovals = mock(async () => {
      order.push("sealApprovals");
    });
    const pluginRegistry = makePluginRegistry({
      getPostRunActionRegistrations: mock(() => [{ pluginName: "publisher", action }]),
    });

    await cleanupRun(makeCleanupOptions({ pluginRegistry, interactionChain, sealApprovals }));

    expect(sealApprovals).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["execute", "sealApprovals", "destroy"]);
  });

  test("US-002 AC8: without a seal it still completes and destroys the interaction chain once", async () => {
    const order: string[] = [];
    const { action, interactionChain } = makeOrderedTeardown(order);
    const pluginRegistry = makePluginRegistry({
      getPostRunActionRegistrations: mock(() => [{ pluginName: "publisher", action }]),
    });

    await expect(cleanupRun(makeCleanupOptions({ pluginRegistry, interactionChain }))).resolves.toBeUndefined();

    expect(order).toEqual(["execute", "destroy"]);
    expect(interactionChain.destroy).toHaveBeenCalledTimes(1);
  });
});
