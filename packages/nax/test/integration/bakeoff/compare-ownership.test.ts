/**
 * US-001: comparison-wide checkout lock and ownership-aware contestant cleanup,
 * against a disposable git repository.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { BakeoffCliDeps, BakeoffResult } from "@/bakeoff";
import { _bakeoffCliDeps, handleRunAction, runBakeoff, runContestant } from "@/bakeoff";
import { acquireLock, releaseLock } from "@/execution/lock";
import { deriveBakeoffWorktreeId, storyWorktreePath, WorktreeManager } from "@/worktree";

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

const EMPTY_RESULT: BakeoffResult = {
  feature: "f",
  completedAt: "now",
  outcome: 0,
  ranking: [],
  contestants: [],
};

describe("run --compare ownership (US-001)", () => {
  let testDir: string;
  let projectRoot: string;
  let saved: BakeoffCliDeps;

  beforeEach(async () => {
    testDir = makeTempDir("compare-own-");
    projectRoot = join(testDir, "project");
    mkdirSync(projectRoot, { recursive: true });
    await git(["init"], projectRoot);
    await git(["config", "user.email", "t@e.com"], projectRoot);
    await git(["config", "user.name", "T"], projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "x");
    await git(["add", "README.md"], projectRoot);
    await git(["commit", "-m", "init"], projectRoot);
    saved = { ..._bakeoffCliDeps };
  });

  afterEach(async () => {
    Object.assign(_bakeoffCliDeps, saved);
    await releaseLock(projectRoot);
    cleanupTempDir(testDir);
  });

  const options = () => ({
    compare: "agent",
    feature: "f",
    projectRoot,
    outputDir: join(testDir, "out"),
    config: makeNaxConfig(),
  });

  it("AC-2: a competing compare reports a lock conflict before sweep or any create", async () => {
    expect((await acquireLock(projectRoot)).acquired).toBe(true);
    const runBakeoffSpy = mock(async () => EMPTY_RESULT);
    const guard = mock(async () => {});
    await expect(
      handleRunAction(options(), {
        ..._bakeoffCliDeps,
        acquireLock,
        releaseLock,
        runBakeoff: runBakeoffSpy,
        assertPrdCommitted: guard,
      }),
    ).rejects.toMatchObject({ code: "LOCK_ACQUISITION_FAILED" });
    expect(runBakeoffSpy).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
  });

  it("AC-8: after a contestant failure a later compare can acquire the released lock", async () => {
    const failing = mock(async () => {
      throw new Error("contestant failed");
    });
    await expect(
      handleRunAction(options(), {
        ..._bakeoffCliDeps,
        acquireLock,
        releaseLock,
        runBakeoff: failing,
        assertPrdCommitted: async () => {},
      }),
    ).rejects.toThrow("contestant failed");

    const later = mock(async () => EMPTY_RESULT);
    await handleRunAction(options(), {
      ..._bakeoffCliDeps,
      acquireLock,
      releaseLock,
      runBakeoff: later,
      assertPrdCommitted: async () => {},
    });
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("AC-7: a successful contestant cleans up its own worktree", async () => {
    const manager = new WorktreeManager();
    let seen = "";
    await runContestant(
      "agent",
      { projectRoot, config: makeNaxConfig(), feature: "f" },
      {
        worktreeManager: manager,
        pipeline: async (ctx) => {
          seen = ctx.worktree;
          expect(existsSync(ctx.worktree)).toBe(true);
          return { results: [{ status: "passed" }], metrics: [] };
        },
      },
    );
    expect(seen).toBe(storyWorktreePath(projectRoot, deriveBakeoffWorktreeId("f", "agent")));
    expect(existsSync(seen)).toBe(false);
  });

  it("AC-5/AC-9: a seeded legacy nax/bakeoff-f-agent tree survives preflight and contestant cleanup", async () => {
    const legacyPath = join(projectRoot, ".nax-wt", "bakeoff-f-agent");
    await git(["worktree", "add", legacyPath, "-b", "nax/bakeoff-f-agent"], projectRoot);
    writeFileSync(join(legacyPath, "unique.txt"), "legacy");
    await git(["add", "unique.txt"], legacyPath);
    await git(["commit", "-m", "legacy work"], legacyPath);
    const tip = await git(["rev-parse", "nax/bakeoff-f-agent"], projectRoot);
    writeFileSync(join(legacyPath, "sentinel.txt"), "dirty");

    const manager = new WorktreeManager();
    const removeSpy = mock(manager.remove.bind(manager));
    manager.remove = removeSpy;

    await runBakeoff(
      { agents: ["agent"], feature: "f", projectRoot, outputDir: join(testDir, "out"), config: makeNaxConfig() },
      {
        validateContestants: async (names) => ({ errors: [], validAgents: names, profileData: {} }),
        persistBakeoffResult: async () => {},
        runContestant: (agent, opts) =>
          runContestant(agent, opts, {
            worktreeManager: manager,
            pipeline: async () => ({ results: [{ status: "passed" }], metrics: [] }),
          }),
      },
    );

    expect(await Bun.file(join(legacyPath, "sentinel.txt")).text()).toBe("dirty");
    expect(await git(["rev-parse", "nax/bakeoff-f-agent"], projectRoot)).toBe(tip);
    // The new-ID allocation was created and removed by its own owner only.
    for (const call of removeSpy.mock.calls) {
      expect(call[1]).toBe(deriveBakeoffWorktreeId("f", "agent"));
      expect(call[2]).toBeDefined();
    }
  });
});
