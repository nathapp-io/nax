import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { prepareWorktreeDependencies, WorktreeDependencyPreparationError, _worktreeDependencyDeps } from "../../../src/worktree/dependencies";
import type { NaxConfig } from "../../../src/config";

function makeConfig(
  mode: "inherit" | "provision" | "off",
  setupCommand: string | null = null,
): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      worktreeDependencies: {
        mode,
        setupCommand,
      },
    },
  };
}

function textStream(text = ""): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

const originalExistsSync = _worktreeDependencyDeps.existsSync;
const originalSpawn = _worktreeDependencyDeps.spawn;

describe("prepareWorktreeDependencies", () => {
  afterEach(() => {
    _worktreeDependencyDeps.existsSync = originalExistsSync;
    _worktreeDependencyDeps.spawn = originalSpawn;
  });

  test("off returns the story package cwd without spawning setup", async () => {
    const spawnMock = mock(() => {
      throw new Error("spawn should not be called");
    });
    _worktreeDependencyDeps.spawn = spawnMock as typeof _worktreeDependencyDeps.spawn;

    const result = await prepareWorktreeDependencies({
      projectRoot: "/repo",
      worktreeRoot: "/repo/.nax-wt/US-001",
      storyId: "US-001",
      storyWorkdir: "packages/app",
      config: makeConfig("off"),
    });

    expect(result).toEqual({ cwd: "/repo/.nax-wt/US-001/packages/app" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("provision parses setupCommand to argv and runs it from the worktree root", async () => {
    const spawnMock = mock(() => ({
      exited: Promise.resolve(0),
      stdout: textStream(),
      stderr: textStream(),
      pid: 123,
      kill: () => {},
    }));
    _worktreeDependencyDeps.spawn = spawnMock as typeof _worktreeDependencyDeps.spawn;

    const result = await prepareWorktreeDependencies({
      projectRoot: "/repo",
      worktreeRoot: "/repo/.nax-wt/US-002",
      storyId: "US-002",
      storyWorkdir: "packages/web",
      config: makeConfig("provision", "bun install --frozen-lockfile"),
    });

    expect(result).toEqual({ cwd: "/repo/.nax-wt/US-002/packages/web" });
    expect(spawnMock).toHaveBeenCalledWith(["bun", "install", "--frozen-lockfile"], {
      cwd: "/repo/.nax-wt/US-002",
      stdout: "pipe",
      stderr: "pipe",
    });
  });

  test("provision without setupCommand fails clearly", async () => {
    await expect(
      prepareWorktreeDependencies({
        projectRoot: "/repo",
        worktreeRoot: "/repo/.nax-wt/US-003",
        storyId: "US-003",
        config: makeConfig("provision"),
      }),
    ).rejects.toThrow(WorktreeDependencyPreparationError);
  });

  test("inherit fails for dependency-managed repos outside the phase-1 allowlist", async () => {
    const existsSyncMock = mock((target: string) => target.endsWith("/package.json"));
    _worktreeDependencyDeps.existsSync = existsSyncMock as typeof _worktreeDependencyDeps.existsSync;

    await expect(
      prepareWorktreeDependencies({
        projectRoot: "/repo",
        worktreeRoot: "/repo/.nax-wt/US-004",
        storyId: "US-004",
        config: makeConfig("inherit"),
      }),
    ).rejects.toThrow(/unsupported.*provision.*off/i);
  });

  test("inherit returns cwd for manifest-free worktrees in the phase-1 allowlist", async () => {
    const existsSyncMock = mock(() => false);
    _worktreeDependencyDeps.existsSync = existsSyncMock as typeof _worktreeDependencyDeps.existsSync;

    const result = await prepareWorktreeDependencies({
      projectRoot: "/repo",
      worktreeRoot: "/repo/.nax-wt/US-005",
      storyId: "US-005",
      config: makeConfig("inherit"),
    });

    expect(result).toEqual({ cwd: "/repo/.nax-wt/US-005" });
  });
});
