/**
 * Run-start main-checkout gitignore reconcile (Fix 1(a)).
 *
 * `WorktreeManager.ensureGitExcludes()` already reconciles `NAX_GITIGNORE_ENTRIES`
 * into `.git/info/exclude`, but only ever gets called for a story worktree
 * (src/execution/iteration-runner.ts, gated on `storyIsolation === "worktree"`).
 * An already-initialised MAIN checkout — the common case — never receives an
 * entry added to the list after its `nax init` ran. This module closes that
 * gap by reusing the same method against the main checkout at run start.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeTempDir,
  withDepsRestore,
  withTempDir,
} from "@test/helpers";
import { _gitignoreReconcileDeps, reconcileMainGitignore } from "@/execution/lifecycle/gitignore-reconcile";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import type { NaxRuntime } from "@/runtime";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { WorktreeManager } from "@/worktree";

withDepsRestore(_gitignoreReconcileDeps);

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

describe("reconcileMainGitignore", () => {
  test("adds a missing NAX_GITIGNORE_ENTRIES entry to the main checkout's .git/info/exclude", async () => {
    await withTempDir(async (dir) => {
      git(dir, "init", "-q");

      await reconcileMainGitignore(dir);

      const excludePath = join(dir, ".git", "info", "exclude");
      const content = readFileSync(excludePath, "utf8");
      for (const entry of NAX_GITIGNORE_ENTRIES) {
        expect(content).toContain(entry);
      }
    });
  });

  test("is idempotent — a second call does not duplicate entries", async () => {
    await withTempDir(async (dir) => {
      git(dir, "init", "-q");

      await reconcileMainGitignore(dir);
      await reconcileMainGitignore(dir);

      const excludePath = join(dir, ".git", "info", "exclude");
      const content = readFileSync(excludePath, "utf8");
      const scratchpadLines = content.split("\n").filter((l) => l.trim() === "**/.nax/scratchpad/");
      expect(scratchpadLines).toHaveLength(1);
    });
  });

  test("does nothing under dryRun — a preview must not touch the tree", async () => {
    await withTempDir(async (dir) => {
      git(dir, "init", "-q");
      const excludePath = join(dir, ".git", "info", "exclude");

      await reconcileMainGitignore(dir, { dryRun: true });

      // `git init` seeds the file with its own boilerplate comments, so
      // absence isn't the right signal — nax's entries specifically must not
      // have been added.
      const content = readFileSync(excludePath, "utf8");
      expect(content).not.toContain("**/.nax/scratchpad/");
    });
  });

  test("reuses WorktreeManager.ensureGitExcludes rather than re-spelling the reconciler", async () => {
    const manager = new WorktreeManager();
    const ensureGitExcludes = mock(async (_projectRoot: string) => {});
    manager.ensureGitExcludes = ensureGitExcludes as typeof manager.ensureGitExcludes;
    _gitignoreReconcileDeps.worktreeManager = manager;

    await reconcileMainGitignore("/some/workdir");

    expect(ensureGitExcludes).toHaveBeenCalledTimes(1);
    expect(ensureGitExcludes).toHaveBeenCalledWith("/some/workdir");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring: setupRun calls reconcileMainGitignore (Fix 1(a))
// ─────────────────────────────────────────────────────────────────────────────

describe("setupRun — main-checkout gitignore reconcile wiring", () => {
  withDepsRestore(_runSetupDeps);

  const createdRuntimes: NaxRuntime[] = [];
  const createdWorkdirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(createdRuntimes.map((runtime) => runtime.close()));
    createdRuntimes.length = 0;
    for (const workdir of createdWorkdirs) cleanupTempDir(workdir);
    createdWorkdirs.length = 0;
  });

  async function makeRun(prefix: string): Promise<{ workdir: string; options: RunSetupOptions }> {
    const workdir = makeTempDir(prefix);
    createdWorkdirs.push(workdir);
    git(workdir, "init", "-q");

    const feature = "gitignore-reconcile";
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
      runId: "run-gitignore-reconcile",
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

  test("a real setupRun call reconciles the main checkout's .git/info/exclude", async () => {
    const { workdir, options } = await makeRun("nax-test-gitignore-reconcile-");
    const excludePath = join(workdir, ".git", "info", "exclude");

    await setupRun(options);

    const content = readFileSync(excludePath, "utf8");
    expect(content).toContain("**/.nax/scratchpad/");
  });

  test("a dry run does not touch .git/info/exclude", async () => {
    const { workdir, options } = await makeRun("nax-test-gitignore-reconcile-dryrun-");
    const excludePath = join(workdir, ".git", "info", "exclude");

    await setupRun({ ...options, dryRun: true });

    const content = readFileSync(excludePath, "utf8");
    expect(content).not.toContain("**/.nax/scratchpad/");
  });
});
