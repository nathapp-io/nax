/**
 * Tests for new-package setup — runs quality.commands.setup once per
 * newly-created package, before its first verify gate. Existing packages and
 * un-marked dirs are never set up.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _newPackageSetupDeps, markNewPackageDirs, maybeRunNewPackageSetup } from "@/execution";

function textStream(text = ""): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

function spawnOk(exitCode = 0, capture?: { argv?: string[]; cwd?: string }) {
  return mock((argv: string[], opts: { cwd: string }) => {
    if (capture) {
      capture.argv = argv;
      capture.cwd = opts.cwd;
    }
    return {
      exited: Promise.resolve(exitCode),
      stdout: textStream(),
      stderr: textStream(exitCode === 0 ? "" : "boom"),
      pid: 1,
      kill: () => {},
    };
  });
}

const originalSpawn = _newPackageSetupDeps.spawn;

describe("maybeRunNewPackageSetup", () => {
  afterEach(() => {
    _newPackageSetupDeps.spawn = originalSpawn;
  });

  test("runs the setup command in the package dir for a newly-created package", async () => {
    const capture: { argv?: string[]; cwd?: string } = {};
    _newPackageSetupDeps.spawn = spawnOk(0, capture) as typeof _newPackageSetupDeps.spawn;
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
    _newPackageSetupDeps.spawn = spawnMock as typeof _newPackageSetupDeps.spawn;
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

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test("does nothing for a package that was not created this run", async () => {
    const spawnMock = spawnOk(0);
    _newPackageSetupDeps.spawn = spawnMock as typeof _newPackageSetupDeps.spawn;
    const runtime = {};
    // No markNewPackageDirs for this package.

    await maybeRunNewPackageSetup({
      runtime,
      storyId: "US-001",
      packageDir: "/repo/packages/core",
      setupCommand: "uv sync",
    });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("does nothing when no setup command is configured", async () => {
    const spawnMock = spawnOk(0);
    _newPackageSetupDeps.spawn = spawnMock as typeof _newPackageSetupDeps.spawn;
    const runtime = {};
    markNewPackageDirs(runtime, ["/repo/packages/portfolio"]);

    await maybeRunNewPackageSetup({
      runtime,
      storyId: "US-001",
      packageDir: "/repo/packages/portfolio",
      setupCommand: undefined,
    });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("normalizes paths so trailing-slash variants match the registry", async () => {
    const spawnMock = spawnOk(0);
    _newPackageSetupDeps.spawn = spawnMock as typeof _newPackageSetupDeps.spawn;
    const runtime = {};
    markNewPackageDirs(runtime, ["/repo/packages/portfolio/"]);

    await maybeRunNewPackageSetup({
      runtime,
      storyId: "US-001",
      packageDir: "/repo/packages/portfolio",
      setupCommand: "uv sync",
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test("swallows a failing setup command (verify gate surfaces the impact)", async () => {
    _newPackageSetupDeps.spawn = spawnOk(1) as typeof _newPackageSetupDeps.spawn;
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
    _newPackageSetupDeps.spawn = spawnMock as typeof _newPackageSetupDeps.spawn;

    await maybeRunNewPackageSetup({
      runtime: undefined,
      storyId: "US-001",
      packageDir: "/repo/packages/portfolio",
      setupCommand: "uv sync",
    });

    expect(spawnMock).not.toHaveBeenCalled();
  });
});
