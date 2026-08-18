import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorktreeDependencies, WorktreeDependencyPreparationError, _worktreeDependencyDeps } from "../../../src/worktree/dependencies";
import type { NaxConfig } from "../../../src/config";
import { makeNaxConfig } from "../../helpers";

function textStream(text = ""): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

const originalSpawn = _worktreeDependencyDeps.spawn;
const tempDirs: string[] = [];

describe("prepareWorktreeDependencies", () => {
  afterEach(() => {
    _worktreeDependencyDeps.spawn = originalSpawn;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
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
      config: makeNaxConfig({ execution: { worktreeDependencies: { mode: "off" } } }),
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
      config: makeNaxConfig({ execution: { worktreeDependencies: { mode: "provision", setupCommand: "bun install --frozen-lockfile" } } }),
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
        config: makeNaxConfig({ execution: { worktreeDependencies: { mode: "provision" } } }),
      }),
    ).rejects.toThrow(WorktreeDependencyPreparationError);
  });

  // Issue #574 asked for this case: a dependency-managed repo under
  // `storyIsolation: "worktree"`. It is the case the removed `inherit` mode threw on,
  // aborting the story before it ran. `off` — the default, and now the only
  // no-install mode — must succeed there, because worktrees sit inside the project
  // root and Node/Bun resolve the root node_modules on their own. Characterisation,
  // not regression: `off` behaved this way before the removal too.
  test("off succeeds on a dependency-managed worktree without installing anything", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "nax-wt-deps-"));
    tempDirs.push(projectRoot);
    const worktreeRoot = join(projectRoot, ".nax-wt", "US-004");
    const packageDir = join(worktreeRoot, "packages", "app");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(worktreeRoot, "package.json"), '{"name":"root"}');
    writeFileSync(join(worktreeRoot, "bun.lock"), "");
    writeFileSync(join(packageDir, "package.json"), '{"name":"app"}');

    const spawnMock = mock(() => {
      throw new Error("spawn should not be called");
    });
    _worktreeDependencyDeps.spawn = spawnMock as typeof _worktreeDependencyDeps.spawn;

    const result = await prepareWorktreeDependencies({
      projectRoot,
      worktreeRoot,
      storyId: "US-004",
      storyWorkdir: "packages/app",
      config: makeNaxConfig({ execution: { worktreeDependencies: { mode: "off" } } }),
    });

    expect(result).toEqual({ cwd: packageDir });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
