/**
 * #2300 — the create side and the wipe side must agree on the run id.
 *
 * `resolveDispatchLauncher` builds every session temp dir under
 * `runTmpRoot(options.runId)` and `cleanupRun` wipes `runTmpRoot(<some id>)`.
 * Two unit suites each pinned one half — `run-tmp-wipe.test.ts` the path
 * resolution, `run-cleanup-run-tmp-wipe.test.ts` the id handed to a STUBBED wipe —
 * and nothing asserted that the two ids were the same. They were not: the create
 * side used `crypto.randomUUID()` (via `runtime.runId`) and the wipe side
 * `buildRunId(workdir, …)`, so `rm(…, { force: true })` targeted a path nothing
 * had created and every run's temp root survived its own wipe.
 *
 * This is the test that closes that gap: real `mkdir` on the create side, real
 * `fs.rm` on the wipe side, `_runCleanupDeps.wipeRunTmp` left unstubbed, and the
 * only assertion that matters — the run's own directory is gone afterwards.
 *
 * `/tmp/nax` is pinned absent through `_sessionTmpDeps`, so `runTmpRoot(id)` is
 * `<real /tmp>/nax/<id>` on any host. The run id carries the pid and a timestamp,
 * so the directory is unique to this test and a concurrent run is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  assertDefined,
  cleanupTempDir,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeTempDir,
  stubSessionSandboxDeps,
  stubSessionTmpDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "@test/helpers";
import { _sessionSandboxDeps } from "@/agents/coding-tool-sandbox";
import { resolveDispatchLauncher } from "@/agents/coding-tool-support-resolve";
import { cleanupRun } from "@/execution/lifecycle/run-cleanup";
import { _launcherDeps, _resetSandboxRegistryForTests, _sessionTmpDeps, runTmpRoot } from "@/sandbox";

/** Bash is what makes `resolveDispatchLauncher` ask for a launcher at all. */
const DECLARED = ["Bash"] as const;
/** The ledger session name the dispatch derives for a story + role. */
const SESSION_NAME = "US-2300-implementer";

describe("#2300 — the run temp root dispatch creates is the root cleanupRun wipes", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);
  withDepsRestore(_sessionTmpDeps);
  withDepsRestore(_launcherDeps);

  let root: string;
  /** The runtime's uuid-shaped id — the one the create side uses. */
  const runtimeRunId = `2300-${process.pid}-${Date.now()}`;
  /** The runner's workdir-hashed id — the one the buggy wipe used. */
  const runnerRunId = "run-8a1b05ad-2026-09-29T07-32-15.243";
  let runRoot: string;

  beforeEach(() => {
    root = makeTempDir("run-tmp-lifecycle-");
    // US-001: `/tmp/nax` absent, so the run root of any id is `<tmp>/nax/<id>`.
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });
    runRoot = runTmpRoot(runtimeRunId);
    // The command itself is not the subject; the directory `ensureTmpDir` creates
    // before it is. runArgv is stubbed so nothing is spawned.
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    // `mkdir: "real"` — the create side must touch the real filesystem.
    stubSessionSandboxDeps(_sessionSandboxDeps, { mkdir: "real" });
  });

  afterEach(() => {
    cleanupTempDir(root);
    cleanupTempDir(runRoot);
    _resetSandboxRegistryForTests();
  });

  test("#2300: the directory a dispatched session creates is gone after cleanupRun", async () => {
    // ── create side: the production dispatch path, sandbox confinement on ──
    const launcher = await resolveDispatchLauncher(
      {
        codingToolRoot: root,
        runId: runtimeRunId,
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

    // The run's own root, with a real session dir under it.
    expect(existsSync(`${runRoot}/${SESSION_NAME}`)).toBe(true);

    // ── wipe side: the REAL wipeRunTmp, not the _runCleanupDeps stub ──
    await cleanupRun({
      runId: runnerRunId,
      runtimeRunId,
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
    });

    expect(existsSync(runRoot)).toBe(false);
  });

  test("#2300: a second run's root under the same parent survives the wipe", async () => {
    // The wipe is run-scoped. A sibling run's directory shares the `/tmp/nax`
    // prefix, and a prefix sweep would take it with the run that ended.
    const siblingId = `${runtimeRunId}-sibling`;
    const siblingRoot = runTmpRoot(siblingId);
    await mkdir(siblingRoot, { recursive: true });

    try {
      await cleanupRun({
        runId: runnerRunId,
        runtimeRunId,
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
      });

      expect(existsSync(siblingRoot)).toBe(true);
    } finally {
      cleanupTempDir(siblingRoot);
    }
  });
});
