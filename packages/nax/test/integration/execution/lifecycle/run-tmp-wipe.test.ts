/**
 * A dispatched session and runtime.close must agree on the run temp root.
 * The shared /tmp/nax parent is unavailable in confined test runs, so these
 * real-filesystem integration checks run only on an unconfined host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  _launcherDeps,
  _resetSandboxRegistryForTests,
  _sessionSandboxDeps,
  _sessionTmpDeps,
  runTmpRoot,
  sessionTmpDirUnder,
} from "@nathapp/nax-agent/internal";
import {
  assertDefined,
  cleanupTempDir,
  isConfinedTestRun,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeTempDir,
  stubSessionSandboxDeps,
  stubSessionTmpDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "@test/helpers";
import { resolveDispatchLauncher } from "@/agents/coding-tool-support-resolve";
import { cleanupRun, type RunCleanupOptions } from "@/execution/lifecycle/run-cleanup";
import { createRuntime, type NaxRuntime } from "@/runtime";

/** Bash is what makes `resolveDispatchLauncher` ask for a launcher at all. */
const DECLARED = ["Bash"] as const;
/** The ledger session name the dispatch derives for a story + role. */
const SESSION_NAME = "US-2300-implementer";

/**
 * Skipped in a confined test run: the subject is the SHARED `/tmp/nax` parent,
 * which the confined sandbox withholds (`/tmp` is a denied write root there);
 * `stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" })` below is what
 * pins the parent for the host run. There is no confined equivalent of this
 * assertion — the run's own temp root lives elsewhere inside the sandbox — so
 * the suite skips rather than asserting a path the sandbox denies.
 */
describe.skipIf(isConfinedTestRun())("#2300 — runtime.close removes the dispatched run temp root", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);
  withDepsRestore(_sessionTmpDeps);
  withDepsRestore(_launcherDeps);

  let root: string;
  /** The runtime's uuid-shaped id — the one the create side uses. */
  let runtime: NaxRuntime;
  /** The runner's workdir-hashed id — the one the buggy wipe used. */
  const runnerRunId = "run-8a1b05ad-2026-09-29T07-32-15.243";
  let runRoot: string;

  beforeEach(() => {
    root = makeTempDir("run-tmp-lifecycle-");
    // US-001: `/tmp/nax` absent, so the run root of any id is `<tmp>/nax/<id>`.
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });
    runtime = createRuntime(makeNaxConfig({ outputDir: root }), root);
    runRoot = runTmpRoot(runtime.runId);
    // The command itself is not the subject; the directory `ensureTmpDir` creates
    // before it is. runArgv is stubbed so nothing is spawned.
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    stubSessionSandboxDeps(_sessionSandboxDeps);
  });

  afterEach(async () => {
    await runtime.close();
    cleanupTempDir(root);
    cleanupTempDir(runRoot);
    _resetSandboxRegistryForTests();
  });

  /** Complete cleanup options for the run. */
  function cleanupOptions(overrides: Partial<RunCleanupOptions> = {}): RunCleanupOptions {
    return {
      runId: runnerRunId,
      startTime: Date.now() - 1000,
      totalCost: 0,
      storiesCompleted: 0,
      prd: makePRD({ feature: "us-2300" }),
      pluginRegistry: makePluginRegistry(),
      workdir: root,
      interactionChain: null,
      feature: "us-2300",
      prdPath: `${root}/.nax/features/us-2300/prd.json`,
      branch: "feat/us-2300",
      version: "1.0.0",
      hooks: { hooks: {} },
      runCompleted: false,
      dryRun: false,
      ...overrides,
    };
  }

  /**
   * Dispatch one command the way a real story does, so the run's own session
   * temp dir is really created. Asserts the confined launcher as a precondition
   * both tests rest on: an unconfined launcher would mean the create side never
   * addressed this run's root at all.
   */
  async function dispatchSession(): Promise<void> {
    const launcher = await resolveDispatchLauncher(
      {
        codingToolRoot: root,
        runId: runtime.runId,
        storyId: "US-2300",
        sessionRole: "implementer",
        config: makeNaxConfig({ execution: { sandbox: { enabled: true } } }),
      },
      DECLARED,
      SESSION_NAME,
    );
    assertDefined(launcher, "the dispatch launcher");
    expect(launcher.state).toEqual({ kind: "available", backend: "srt", network: "open", sharedTmp: false });

    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
  }

  test("cleanupRun leaves the run temp root for runtime.close", async () => {
    await dispatchSession();
    await cleanupRun(cleanupOptions({ runId: runtime.runId }));
    expect(existsSync(runRoot)).toBe(true);
  });

  test("#2300: the directory a dispatched session creates is gone after runtime.close", async () => {
    // ── create side: the production dispatch path, sandbox confinement on ──
    await dispatchSession();

    // The run's own root, with a real session dir under it.
    expect(existsSync(sessionTmpDirUnder(runRoot, SESSION_NAME))).toBe(true);

    // Runtime close performs the real wipe.
    await runtime.close();

    expect(existsSync(runRoot)).toBe(false);
  });

  test("#2300: a second run's root under the same parent survives the wipe", async () => {
    // The wipe is run-scoped. A sibling run's directory shares the `/tmp/nax`
    // prefix, and a sweep that reached past the run's own id would take it with
    // the run that ended. It is created here through the same dispatch the first
    // test uses, so the wipe has real work to do and this is a genuine
    // sibling-beside-a-live-root case rather than a wipe that early-returned.
    const siblingRoot = runTmpRoot(`${runtime.runId}-sibling`);
    await mkdir(siblingRoot, { recursive: true });

    try {
      await dispatchSession();
      await runtime.close();

      // The run's own root went, and only that one: the sibling's id extends
      // this run's id, so an over-reaching prefix match takes both.
      expect(existsSync(runRoot)).toBe(false);
      expect(existsSync(siblingRoot)).toBe(true);
    } finally {
      cleanupTempDir(siblingRoot);
    }
  });
});
