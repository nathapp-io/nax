import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeSpawn, makeSpawnResult } from "@test/helpers";
import {
  _worktreeDependencyDeps,
  prepareWorktreeDependencies,
  WorktreeDependencyPreparationError,
} from "@/worktree/dependencies";

const originalSpawn = _worktreeDependencyDeps.spawn;
const originalKillProcessGroup = _worktreeDependencyDeps.killProcessGroup;

describe("prepareWorktreeDependencies", () => {
  afterEach(() => {
    _worktreeDependencyDeps.spawn = originalSpawn;
    _worktreeDependencyDeps.killProcessGroup = originalKillProcessGroup;
  });

  // #574: `off` is the only no-install mode now that `inherit` is gone, and it is
  // what a dependency-managed worktree gets. There is deliberately no manifest
  // fixture here — `prepareWorktreeDependencies` no longer touches the filesystem,
  // so writing a package.json would assert nothing.
  test("off returns the story package cwd without spawning setup", async () => {
    const spawnMock = makeSpawn(() => {
      throw new Error("spawn should not be called");
    });
    _worktreeDependencyDeps.spawn = spawnMock.spawn;

    const result = await prepareWorktreeDependencies({
      projectRoot: "/repo",
      worktreeRoot: "/repo/.nax-wt/US-001",
      storyId: "US-001",
      storyWorkdir: "packages/app",
      config: makeNaxConfig({ execution: { worktreeDependencies: { mode: "off" } } }),
    });

    expect(result).toEqual({ cwd: "/repo/.nax-wt/US-001/packages/app" });
    expect(spawnMock.calls).toHaveLength(0);
  });

  test("provision parses setupCommand to argv and runs it from the worktree root", async () => {
    const spawnMock = makeSpawn(() => ({}));
    _worktreeDependencyDeps.spawn = spawnMock.spawn;

    const result = await prepareWorktreeDependencies({
      projectRoot: "/repo",
      worktreeRoot: "/repo/.nax-wt/US-002",
      storyId: "US-002",
      storyWorkdir: "packages/web",
      config: makeNaxConfig({
        execution: { worktreeDependencies: { mode: "provision", setupCommand: "bun install --frozen-lockfile" } },
      }),
    });

    expect(result).toEqual({ cwd: "/repo/.nax-wt/US-002/packages/web" });
    expect(spawnMock.calls[0]).toEqual({
      cmd: ["bun", "install", "--frozen-lockfile"],
      // MEM-4: detached so killProcessGroup(-pid) below can actually reach a
      // pnpm/npm postinstall grandchild — see the "detached: true" test below.
      opts: { cwd: "/repo/.nax-wt/US-002", stdout: "pipe", stderr: "pipe", detached: true },
    });
  });

  test("provision without setupCommand fails clearly", async () => {
    await expect(
      prepareWorktreeDependencies({
        projectRoot: "/repo",
        worktreeRoot: "/repo/.nax-wt/US-003",
        storyId: "US-003",
        config: makeNaxConfig({ execution: { worktreeDependencies: { mode: "provision" } } }),
      }),
    ).rejects.toThrow(WorktreeDependencyPreparationError);
  });

  // BUG-13: a hung install (registry/NFS stall) must not block the story
  // forever — unlike every git call (routed through gitWithTimeout), this
  // spawn previously had no deadline at all.
  //
  // MEM-4: the timeout handler used to call `proc.kill()`, which reaches only
  // the direct child — a pnpm/npm postinstall grandchild survives and keeps
  // running against a worktree nax is about to delete. It must go through
  // killProcessGroup(pid, "SIGKILL") instead (matching verification/executor.ts's
  // established pattern), so the whole process group dies.
  test("provision times out and kills the whole process group via killProcessGroup", async () => {
    const proc = makeSpawnResult({ hang: true, pid: 456, killResolvesExited: true });
    _worktreeDependencyDeps.spawn = makeSpawn(() => proc).spawn;

    let killedPid: number | undefined;
    let killedSignal: NodeJS.Signals | number | undefined;
    _worktreeDependencyDeps.killProcessGroup = ((pid, signal) => {
      killedPid = pid;
      killedSignal = signal;
      // Simulate the OS reaping the process once its group is killed — the fake
      // spawn result has no real OS process behind it, so nothing else resolves
      // `exited` in this test.
      proc.kill();
      return true;
    }) as typeof _worktreeDependencyDeps.killProcessGroup;

    await expect(
      prepareWorktreeDependencies({
        projectRoot: "/repo",
        worktreeRoot: "/repo/.nax-wt/US-004",
        storyId: "US-004",
        storyWorkdir: "packages/hung",
        // Schema minimum (1s) — the contract under test is "arms a timer,
        // group-kills on expiry, throws" not the production 300s default.
        config: makeNaxConfig({
          execution: { worktreeDependencies: { mode: "provision", setupCommand: "bun install", timeoutSeconds: 1 } },
        }),
      }),
    ).rejects.toThrow(/timed out after 1s/);

    expect(killedPid).toBe(456);
    expect(killedSignal).toBe("SIGKILL");
  });
});
