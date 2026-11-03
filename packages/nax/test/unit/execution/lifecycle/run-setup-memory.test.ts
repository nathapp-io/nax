/**
 * run-setup-memory.test.ts — run setup creates the run's memory (US-006).
 *
 * Covers AC-1..AC-7: `setupRun` creates the run memory once, from the run's own
 * config, workdir and logger, before it builds the runtime; hands that memory to
 * `createRuntime` as its `memory` option (and no key at all when there is none to
 * hand over); and creates nothing at all on the two paths that have no memory to
 * speak of — a dry run, and pipeline mode.
 *
 * The real `setupRun` runs in every case, with the two seams it reaches for
 * stubbed: `_runSetupDeps.createRunMemory` (so no mirror is composed) and
 * `_runSetupDeps.createRuntime` (so no runtime is built). The assertions are on
 * what `setupRun` passes those seams and in which order, which is the whole of
 * this story.
 *
 * `setupRun` is driven with a PRD path that does not exist, so it throws at
 * `loadPRD` — after both seams have been called, which is what every case here
 * measures. That is the fixture `run-setup.test.ts` uses for the same reason: the
 * wiring under test is complete before the first setup step that needs a real
 * repository. `driveSetupRun` asserts that this is the failure it got, so a setup
 * that threw for any other reason fails the case instead of being swallowed.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  assertNaxError,
  makeFakeRunMemory,
  makeMockRuntime,
  makeNaxConfig,
  withDepsRestore,
  withTempDir,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import { getLogger } from "@/logger";
import type { CreateRunMemoryInput, RunMemory } from "@/memory";
import type { CreateRuntimeOptions } from "@/runtime";

/** What one driven `setupRun` was observed to do. */
interface SetupRunCalls {
  /** Seam names in call order. */
  readonly order: string[];
  /** Every input the stubbed `createRunMemory` received. */
  readonly memoryInputs: CreateRunMemoryInput[];
  /** Every options object the stubbed `createRuntime` received. */
  readonly runtimeOptions: CreateRuntimeOptions[];
}

/** The options `setupRun` needs, with the PRD path deliberately missing. */
function runSetupOptions(workdir: string, config: NaxConfig, dryRun: boolean): RunSetupOptions {
  return {
    prdPath: join(workdir, "does-not-exist.json"),
    workdir,
    config,
    hooks: { hooks: {} },
    feature: "memory-setup-feature",
    dryRun,
    statusFile: join(workdir, "status.json"),
    runId: `run-memory-setup-${Date.now()}`,
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    skipPrecheck: true,
    headless: true,
    formatterMode: "quiet",
    getTotalCost: () => 0,
    getIterations: () => 0,
    getStoriesCompleted: () => 0,
    getTotalStories: () => 0,
  };
}

/**
 * Drive the real `setupRun` with both seams stubbed, recording what it passed them.
 *
 * `setupRun` is driven with a PRD path that does not exist, so it stops at `loadPRD`
 * — after both seams, which is what every case here measures. That stop is the *only*
 * failure the fixture accepts: it is a `PRD_NOT_FOUND` for the path this file made up,
 * so a run that failed for any other reason fails the case that drove it instead of
 * quietly returning the recordings a later assertion happens to accept.
 *
 * @param workdir - The run's workdir (also the repository root memory is composed from)
 * @param config - The run config
 * @param resolved - What the stubbed `createRunMemory` answers
 * @param dryRun - The run's dry-run flag
 */
async function driveSetupRun(
  workdir: string,
  config: NaxConfig,
  resolved: RunMemory | undefined,
  dryRun = false,
): Promise<SetupRunCalls> {
  const order: string[] = [];
  const memoryInputs: CreateRunMemoryInput[] = [];
  const runtimeOptions: CreateRuntimeOptions[] = [];

  _runSetupDeps.createRunMemory = async (input: CreateRunMemoryInput) => {
    order.push("createRunMemory");
    memoryInputs.push(input);
    return resolved;
  };
  _runSetupDeps.createRuntime = (_config: NaxConfig, dir: string, opts?: CreateRuntimeOptions) => {
    order.push("createRuntime");
    runtimeOptions.push(opts ?? {});
    return makeMockRuntime({ workdir: dir });
  };

  const options = runSetupOptions(workdir, config, dryRun);
  const thrown = await setupRun(options).then(
    () => undefined,
    (error: unknown) => error,
  );
  assertNaxError(thrown, "the failure setupRun reported");
  expect({ code: thrown.code, path: thrown.context?.path }).toEqual({ code: "PRD_NOT_FOUND", path: options.prdPath });

  return { order, memoryInputs, runtimeOptions };
}

describe("setupRun — the run's memory", () => {
  withDepsRestore(_runSetupDeps);

  test("AC-1 workflow mode creates the run memory once, from the run's config, workdir and logger", async () => {
    await withTempDir(async (workdir) => {
      const config = makeNaxConfig();
      const runLogger = getLogger();

      const calls = await driveSetupRun(workdir, config, makeFakeRunMemory().memory);

      expect(calls.memoryInputs.length).toBe(1);
      const input = calls.memoryInputs[0];
      expect(input?.config).toBe(config);
      expect(input?.repoRoot).toBe(workdir);
      expect(input?.logger).toBe(runLogger);
    });
  });

  test("AC-2 the memory createRunMemory resolves is the runtime's memory option", async () => {
    await withTempDir(async (workdir) => {
      const memory = makeFakeRunMemory().memory;

      const calls = await driveSetupRun(workdir, makeNaxConfig(), memory);

      expect(calls.runtimeOptions.length).toBe(1);
      expect(calls.runtimeOptions[0]?.memory).toBe(memory);
    });
  });

  test("AC-3 with no run memory the runtime gets no memory key at all", async () => {
    await withTempDir(async (workdir) => {
      const calls = await driveSetupRun(workdir, makeNaxConfig(), undefined);

      expect(calls.memoryInputs.length).toBe(1);
      const runtimeOptions = calls.runtimeOptions[0];
      assertDefined(runtimeOptions, "the options setupRun passed createRuntime");
      expect("memory" in runtimeOptions).toBe(false);
    });
  });

  test("AC-4 a dry run creates no run memory and passes none to the runtime", async () => {
    await withTempDir(async (workdir) => {
      const calls = await driveSetupRun(workdir, makeNaxConfig(), makeFakeRunMemory().memory, true);

      expect(calls.memoryInputs.length).toBe(0);
      expect(calls.order).toEqual(["createRuntime"]);
      const runtimeOptions = calls.runtimeOptions[0];
      assertDefined(runtimeOptions, "the options setupRun passed createRuntime");
      expect("memory" in runtimeOptions).toBe(false);
    });
  });

  test("AC-5 pipeline mode creates no run memory", async () => {
    await withTempDir(async (workdir) => {
      const calls = await driveSetupRun(
        workdir,
        makeNaxConfig({ execution: { mode: "pipeline" } }),
        makeFakeRunMemory().memory,
      );

      expect(calls.memoryInputs.length).toBe(0);
      expect(calls.order).toEqual(["createRuntime"]);
    });
  });

  test("AC-6 pipeline mode passes no memory key to the runtime", async () => {
    await withTempDir(async (workdir) => {
      const calls = await driveSetupRun(
        workdir,
        makeNaxConfig({ execution: { mode: "pipeline" } }),
        makeFakeRunMemory().memory,
      );

      const runtimeOptions = calls.runtimeOptions[0];
      assertDefined(runtimeOptions, "the options setupRun passed createRuntime");
      expect("memory" in runtimeOptions).toBe(false);
    });
  });

  test("AC-7 the run memory is created before the runtime is created", async () => {
    await withTempDir(async (workdir) => {
      const calls = await driveSetupRun(workdir, makeNaxConfig(), makeFakeRunMemory().memory);

      expect(calls.order).toEqual(["createRunMemory", "createRuntime"]);
    });
  });
});
