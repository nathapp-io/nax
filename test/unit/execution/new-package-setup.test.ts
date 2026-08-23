/**
 * Tests for new-package setup — runs quality.commands.setup once per
 * newly-created package, before its first verify gate. Existing packages and
 * un-marked dirs are never set up.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { _newPackageSetupDeps, markNewPackageDirs, maybeRunNewPackageSetup } from "@/execution";
import { type SpawnStub, makeSpawn } from "@test/helpers";

function spawnOk(exitCode = 0, capture?: { argv?: string[]; cwd?: string }): SpawnStub {
  return makeSpawn(({ cmd, opts }) => {
    if (capture) {
      capture.argv = cmd;
      capture.cwd = String(opts.cwd);
    }
    return { stdout: "", stderr: exitCode === 0 ? "" : "boom", exitCode };
  });
}

const originalSpawn = _newPackageSetupDeps.spawn;

describe("maybeRunNewPackageSetup", () => {
  afterEach(() => {
    _newPackageSetupDeps.spawn = originalSpawn;
  });

  test("runs the setup command in the package dir for a newly-created package", async () => {
    const capture: { argv?: string[]; cwd?: string } = {};
    const stub = spawnOk(0, capture);
    _newPackageSetupDeps.spawn = stub.spawn;
    const runtime = {};
    markNewPackageDirs(runtime, ["/repo/packages/portfolio"]);

    await maybeRunNewPackageSetup({
      runtime,
      storyId: "US-001",
      packageDir: "/repo/packages/portfolio",
      setupCommand: "uv sync",
    });

    expect(capture.argv).toEqual(["uv", "sync"]);
    expect(capture.cwd).toBe("/repo/packages/portfolio");
  });

  test("runs at most once per package even across multiple gates", async () => {
    const spawnMock = spawnOk(0);
    _newPackageSetupDeps.spawn = spawnMock.spawn;
    const runtime = {};
    markNewPackageDirs(runtime, ["/repo/packages/portfolio"]);

    const opts = {
      runtime,
      storyId: "US-001",
      packageDir: "/repo/packages/portfolio",
      setupCommand: "uv sync",
    };
    await maybeRunNewPackageSetup(opts);
    await maybeRunNewPackageSetup(opts);

    expect(spawnMock.calls).toHaveLength(1);
  });

  test("does nothing for a package that was not created this run", async () => {
    const spawnMock = spawnOk(0);
    _newPackageSetupDeps.spawn = spawnMock.spawn;
    const runtime = {};
    // No markNewPackageDirs for this package.

    await maybeRunNewPackageSetup({
      runtime,
      storyId: "US-001",
      packageDir: "/repo/packages/core",
      setupCommand: "uv sync",
    });

    expect(spawnMock.calls).toHaveLength(0);
  });

  test("does nothing when no setup command is configured", async () => {
    const spawnMock = spawnOk(0);
    _newPackageSetupDeps.spawn = spawnMock.spawn;
    const runtime = {};
    markNewPackageDirs(runtime, ["/repo/packages/portfolio"]);

    await maybeRunNewPackageSetup({
      runtime,
      storyId: "US-001",
      packageDir: "/repo/packages/portfolio",
      setupCommand: undefined,
    });

    expect(spawnMock.calls).toHaveLength(0);
  });

  test("normalizes paths so trailing-slash variants match the registry", async () => {
    const spawnMock = spawnOk(0);
    _newPackageSetupDeps.spawn = spawnMock.spawn;
    const runtime = {};
    markNewPackageDirs(runtime, ["/repo/packages/portfolio/"]);

    await maybeRunNewPackageSetup({
      runtime,
      storyId: "US-001",
      packageDir: "/repo/packages/portfolio",
      setupCommand: "uv sync",
    });

    expect(spawnMock.calls).toHaveLength(1);
  });

  test("swallows a failing setup command (verify gate surfaces the impact)", async () => {
    _newPackageSetupDeps.spawn = spawnOk(1).spawn;
    const runtime = {};
    markNewPackageDirs(runtime, ["/repo/packages/portfolio"]);

    await expect(
      maybeRunNewPackageSetup({
        runtime,
        storyId: "US-001",
        packageDir: "/repo/packages/portfolio",
        setupCommand: "uv sync",
      }),
    ).resolves.toBeUndefined();
  });

  test("no-op when runtime is undefined", async () => {
    const spawnMock = spawnOk(0);
    _newPackageSetupDeps.spawn = spawnMock.spawn;

    await maybeRunNewPackageSetup({
      runtime: undefined,
      storyId: "US-001",
      packageDir: "/repo/packages/portfolio",
      setupCommand: "uv sync",
    });

    expect(spawnMock.calls).toHaveLength(0);
  });
});
