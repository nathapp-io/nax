import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig, makeSpawn } from "@test/helpers";
import {
  _worktreeDependencyDeps,
  prepareWorktreeDependencies,
  WorktreeDependencyPreparationError,
} from "@/worktree/dependencies";

function textStream(text = ""): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

const originalSpawn = _worktreeDependencyDeps.spawn;

describe("prepareWorktreeDependencies", () => {
  afterEach(() => {
    _worktreeDependencyDeps.spawn = originalSpawn;
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
      opts: { cwd: "/repo/.nax-wt/US-002", stdout: "pipe", stderr: "pipe" },
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
  test("provision times out and SIGKILLs a hung install", async () => {
    let killed = false;
    let resolveExited: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    const spawnMock = mock(() => ({
      exited,
      stdout: textStream(),
      stderr: textStream(),
      pid: 456,
      // Simulates real Bun.spawn behaviour: killing the process resolves `exited`.
      kill: (_signal?: string) => {
        killed = true;
        resolveExited(137); // 128 + SIGKILL(9)
      },
    }));
    _worktreeDependencyDeps.spawn = spawnMock as unknown as typeof _worktreeDependencyDeps.spawn; // test-ratchet-allow: as-unknown-as

    await expect(
      prepareWorktreeDependencies({
        projectRoot: "/repo",
        worktreeRoot: "/repo/.nax-wt/US-004",
        storyId: "US-004",
        storyWorkdir: "packages/hung",
        // Schema minimum (1s) — the contract under test is "arms a timer,
        // SIGKILLs on expiry, throws" not the production 300s default.
        config: makeNaxConfig({
          execution: { worktreeDependencies: { mode: "provision", setupCommand: "bun install", timeoutSeconds: 1 } },
        }),
      }),
    ).rejects.toThrow(/timed out after 1s/);

    expect(killed).toBe(true);
  });
});
