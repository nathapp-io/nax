/**
 * US-004 — wipe the scratchpad at run start.
 *
 * The scratchpad tools (src/tools/scratchpad.ts) advertise throwaway storage:
 * "It is never committed and is wiped at the start of each run." The wipe
 * itself is observable only through the production caller, `setupRun`, so every
 * test below drives the real setup flow against a temp workdir — stubbing just
 * the run-container dependencies that would otherwise reach an agent or the
 * developer's machine.
 *
 * The removal primitive (`_scratchpadWipeDeps.remove`) is left real on the
 * success paths and injected only for the failure path, so the record asserted
 * in AC3 is the production one.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeTempDir,
  withDepsRestore,
  withWarnSpy,
} from "@test/helpers";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import { _scratchpadWipeDeps } from "@/execution/lifecycle/scratchpad-wipe";
import type { NaxRuntime } from "@/runtime";
import { SCRATCHPAD_DIR } from "@/tools";

// Both seams are restored after every test: the wipe's removal primitive is
// injected per-test, and the run-container deps are stubbed so setupRun never
// boots a real runtime, installs signal handlers, or looks for an agent.
withDepsRestore(_runSetupDeps);
withDepsRestore(_scratchpadWipeDeps);

const createdRuntimes: NaxRuntime[] = [];
const createdWorkdirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((runtime) => runtime.close()));
  createdRuntimes.length = 0;
  for (const workdir of createdWorkdirs) cleanupTempDir(workdir);
  createdWorkdirs.length = 0;
});

/**
 * A temp workdir holding a zero-story PRD, plus the `setupRun` options and
 * dependency stubs that let the flow complete offline.
 *
 * `acceptance.enabled: false` is required: with it on, `initializeRun` treats
 * the run as agent-using and does a real `which <agent-binary>` lookup
 * (nax#2016), which fails on machines without that agent installed.
 */
async function makeRun(prefix: string): Promise<{ workdir: string; options: RunSetupOptions }> {
  const workdir = makeTempDir(prefix);
  createdWorkdirs.push(workdir);

  const feature = "scratchpad-wipe";
  const prdPath = join(workdir, "prd.json");
  await Bun.write(prdPath, JSON.stringify(makePRD({ feature, userStories: [] }), null, 2));

  _runSetupDeps.createRuntime = ((...args: Parameters<typeof _runSetupDeps.createRuntime>) => {
    const runtime = makeMockRuntime({ config: args[0], workdir: args[1] });
    createdRuntimes.push(runtime);
    return runtime;
  }) as typeof _runSetupDeps.createRuntime;
  _runSetupDeps.installCrashHandlers = (() => () => {}) as typeof _runSetupDeps.installCrashHandlers;
  _runSetupDeps.detectProjectProfile = (async () => ({})) as typeof _runSetupDeps.detectProjectProfile;
  _runSetupDeps.sweepFeatureTranscripts = (async () => 0) as typeof _runSetupDeps.sweepFeatureTranscripts;

  const options: RunSetupOptions = {
    prdPath,
    workdir,
    config: makeNaxConfig({ acceptance: { enabled: false } }),
    hooks: { hooks: {} },
    feature,
    dryRun: false,
    statusFile: join(workdir, "status.json"),
    runId: "run-scratchpad-wipe",
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

  return { workdir, options };
}

describe("setupRun — US-004: run-start scratchpad wipe", () => {
  test("AC1: a file left in the scratchpad is gone once setupRun completes", async () => {
    const { workdir, options } = await makeRun("nax-test-scratchpad-wipe-");
    const parked = join(workdir, SCRATCHPAD_DIR, "notes.md");
    const siblingRunState = join(workdir, ".nax", "keep.txt");
    const projectFile = join(workdir, "keep.txt");
    await Bun.write(parked, "parked note");
    await Bun.write(siblingRunState, "not scratchpad state");
    await Bun.write(projectFile, "not scratchpad state");
    expect(existsSync(parked)).toBe(true);

    await setupRun(options);

    expect(existsSync(parked)).toBe(false);
    // Scoped to the scratchpad: run state beside it, and the project's own
    // files, are not collateral.
    expect(existsSync(siblingRunState)).toBe(true);
    expect(existsSync(projectFile)).toBe(true);
  });

  test("AC2: completes without raising when no scratchpad directory exists", async () => {
    const { workdir, options } = await makeRun("nax-test-scratchpad-absent-");
    expect(existsSync(join(workdir, SCRATCHPAD_DIR))).toBe(false);

    const result = await setupRun(options);

    expect(result.runtime).toBeDefined();
  });

  test("AC3: a rejected directory removal is tolerated and reported at warn", async () => {
    const { workdir, options } = await makeRun("nax-test-scratchpad-busy-");
    const removeMock = mock(async (_path: string) => {
      throw new Error("EBUSY: resource busy or locked, rmdir '.nax/scratchpad'");
    });
    _scratchpadWipeDeps.remove = removeMock as typeof _scratchpadWipeDeps.remove;

    await withWarnSpy(async (warnSpy) => {
      const result = await setupRun(options);

      // The run still comes back with its result rather than propagating the
      // removal failure — a scratch directory must never wedge a run.
      expect(result.runtime).toBeDefined();

      const warnings = warnSpy.mock.calls.filter((call) => call[0] === "setup" && /scratchpad/i.test(call[1]));
      expect(warnings).toHaveLength(1);
      // The record has to name the scratchpad; "cleanup failed" alone would not
      // tell the operator which directory survived.
      expect(warnings[0]?.[1]).toContain(SCRATCHPAD_DIR);
    });

    // Removal targets this run's scratchpad — not the workdir, and not a path
    // resolved against whatever the process cwd happens to be.
    expect(removeMock.mock.calls.map((call) => call[0])).toEqual([join(workdir, SCRATCHPAD_DIR)]);
  });
});
