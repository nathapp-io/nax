/**
 * Unit tests for src/verification/runners.ts — the low-level test-execution
 * entry points (fullSuite, scoped, regression) and the asset pre-check they
 * share.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { makeSpawn, withTempDir } from "@test/helpers";
import type { VerificationGateOptions } from "@/verification";
import { _executorDeps, _regressionRunnerDeps, fullSuite, regression, scoped, verifyAssets } from "@/verification";

describe("verifyAssets", () => {
  test("succeeds with no expectedFiles argument", async () => {
    const result = await verifyAssets("/does/not/matter");
    expect(result).toEqual({ success: true, missingFiles: [] });
  });

  test("succeeds with an empty expectedFiles array", async () => {
    const result = await verifyAssets("/does/not/matter", []);
    expect(result).toEqual({ success: true, missingFiles: [] });
  });

  test("succeeds when every expected file exists", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "a.txt"), "a");
      await Bun.write(join(dir, "b.txt"), "b");
      const result = await verifyAssets(dir, ["a.txt", "b.txt"]);
      expect(result).toEqual({ success: true, missingFiles: [] });
    });
  });

  test("fails and lists missing files with an actionable error", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "a.txt"), "a");
      const result = await verifyAssets(dir, ["a.txt", "b.txt", "c.txt"]);
      expect(result.success).toBe(false);
      expect(result.missingFiles).toEqual(["b.txt", "c.txt"]);
      expect(result.error).toContain("ASSET_CHECK_FAILED");
      expect(result.error).toContain("b.txt");
      expect(result.error).toContain("c.txt");
    });
  });
});

describe("fullSuite", () => {
  let originalSpawn: typeof _executorDeps.spawn;

  beforeEach(() => {
    originalSpawn = _executorDeps.spawn;
  });

  afterEach(() => {
    _executorDeps.spawn = originalSpawn;
    mock.restore();
  });

  function baseOptions(overrides: Partial<VerificationGateOptions> = {}): VerificationGateOptions {
    return {
      workdir: "/tmp/does-not-matter",
      command: "bun test",
      timeoutSeconds: 10,
      ...overrides,
    };
  }

  test("returns ASSET_CHECK_FAILED without spawning when an expected file is missing", async () => {
    await withTempDir(async (dir) => {
      const spawnStub = makeSpawn(() => "should not be called");
      _executorDeps.spawn = spawnStub.spawn;

      const result = await fullSuite(baseOptions({ workdir: dir, expectedFiles: ["missing.txt"] }));

      expect(result.status).toBe("ASSET_CHECK_FAILED");
      expect(result.success).toBe(false);
      expect(result.countsTowardEscalation).toBe(true);
      expect(result.missingFiles).toEqual(["missing.txt"]);
      expect(spawnStub.calls).toHaveLength(0);
    });
  });

  test("returns SUCCESS on a clean exit", async () => {
    _executorDeps.spawn = makeSpawn(() => ({ stdout: "all good", exitCode: 0 })).spawn;

    const result = await fullSuite(baseOptions());

    expect(result.status).toBe("SUCCESS");
    expect(result.success).toBe(true);
    expect(result.countsTowardEscalation).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("bun test");
  });

  test("returns TEST_FAILURE with parsed pass/fail counts on a real test failure", async () => {
    _executorDeps.spawn = makeSpawn(() => ({ stdout: "Tests: 2 failed, 3 passed", exitCode: 1 })).spawn;

    const result = await fullSuite(baseOptions());

    expect(result.status).toBe("TEST_FAILURE");
    expect(result.success).toBe(false);
    expect(result.countsTowardEscalation).toBe(true);
    expect(result.failCount).toBe(2);
    expect(result.passCount).toBe(3);
    expect(result.exitCode).toBe(1);
  });

  test("returns ENVIRONMENTAL_FAILURE when all tests passed but exit code is nonzero", async () => {
    _executorDeps.spawn = makeSpawn(() => ({ stdout: "Tests: 5 passed", exitCode: 1 })).spawn;

    const result = await fullSuite(baseOptions());

    expect(result.status).toBe("ENVIRONMENTAL_FAILURE");
    expect(result.success).toBe(false);
    expect(result.countsTowardEscalation).toBe(true);
    expect(result.passCount).toBe(5);
    expect(result.error).toContain("ENVIRONMENTAL_FAILURE");
  });

  test("returns TEST_FAILURE (not ENVIRONMENTAL_FAILURE) on nonzero exit with empty output", async () => {
    _executorDeps.spawn = makeSpawn(() => ({ stdout: "", exitCode: 1 })).spawn;

    const result = await fullSuite(baseOptions());

    // No output at all — analyzeTestExitCode is never reached, exitCode falls
    // through to the plain TEST_FAILURE branch.
    expect(result.status).toBe("TEST_FAILURE");
    expect(result.success).toBe(false);
  });

  test("returns a TIMEOUT status that is not success by default", async () => {
    _executorDeps.spawn = makeSpawn(() => ({ hang: true })).spawn;

    const result = await fullSuite(baseOptions({ timeoutSeconds: 0.1, gracePeriodMs: 100, drainTimeoutMs: 100 }));

    expect(result.status).toBe("TIMEOUT");
    expect(result.success).toBe(false);
    expect(result.countsTowardEscalation).toBe(false);
  }, 15_000);

  test("honours acceptOnTimeout: true, marking the TIMEOUT result as success", async () => {
    _executorDeps.spawn = makeSpawn(() => ({ hang: true })).spawn;

    const result = await fullSuite(
      baseOptions({ timeoutSeconds: 0.1, gracePeriodMs: 100, drainTimeoutMs: 100, acceptOnTimeout: true }),
    );

    expect(result.status).toBe("TIMEOUT");
    expect(result.success).toBe(true);
  }, 15_000);

  test("merges env overrides and strips the configured strip vars", async () => {
    const spawnStub = makeSpawn(() => ({ stdout: "ok", exitCode: 0 }));
    _executorDeps.spawn = spawnStub.spawn;

    await fullSuite(
      baseOptions({
        env: { CUSTOM_VAR: "1", AGENT: "should-be-stripped" },
        stripEnvVars: ["AGENT"],
      }),
    );

    const env = spawnStub.lastEnv();
    expect(env.CUSTOM_VAR).toBe("1");
    expect(env.AGENT).toBeUndefined();
  });

  test("applies forceExit / detectOpenHandles flags through buildTestCommand", async () => {
    const spawnStub = makeSpawn(() => ({ stdout: "ok", exitCode: 0 }));
    _executorDeps.spawn = spawnStub.spawn;

    const result = await fullSuite(
      baseOptions({ forceExit: true, detectOpenHandles: true, timeoutRetryCount: 1, detectOpenHandlesRetries: 2 }),
    );

    expect(result.command).toContain("--forceExit");
    expect(result.command).toContain("--detectOpenHandles");
  });
});

describe("scoped", () => {
  let originalSpawn: typeof _executorDeps.spawn;

  beforeEach(() => {
    originalSpawn = _executorDeps.spawn;
  });

  afterEach(() => {
    _executorDeps.spawn = originalSpawn;
    mock.restore();
  });

  test("appends shell-quoted scoped test paths to the base command", async () => {
    const spawnStub = makeSpawn(() => ({ stdout: "ok", exitCode: 0 }));
    _executorDeps.spawn = spawnStub.spawn;

    const result = await scoped({
      workdir: "/tmp/does-not-matter",
      command: "bun test",
      timeoutSeconds: 10,
      scopedTestPaths: ["test/unit/a.test.ts", "test/unit/needs quoting.test.ts"],
    });

    expect(result.command).toContain("test/unit/a.test.ts");
    expect(result.command).toContain("needs quoting.test.ts");
    expect(result.command?.startsWith("bun test ")).toBe(true);
  });

  test("leaves the command untouched when scopedTestPaths is empty", async () => {
    const spawnStub = makeSpawn(() => ({ stdout: "ok", exitCode: 0 }));
    _executorDeps.spawn = spawnStub.spawn;

    const result = await scoped({
      workdir: "/tmp/does-not-matter",
      command: "bun test",
      timeoutSeconds: 10,
      scopedTestPaths: [],
    });

    expect(result.command).toBe("bun test");
  });

  test("leaves the command untouched when scopedTestPaths is absent", async () => {
    const spawnStub = makeSpawn(() => ({ stdout: "ok", exitCode: 0 }));
    _executorDeps.spawn = spawnStub.spawn;

    const result = await scoped({
      workdir: "/tmp/does-not-matter",
      command: "bun test",
      timeoutSeconds: 10,
    });

    expect(result.command).toBe("bun test");
  });
});

describe("regression", () => {
  let originalSpawn: typeof _executorDeps.spawn;
  let originalSleep: typeof _regressionRunnerDeps.sleep;

  beforeEach(() => {
    originalSpawn = _executorDeps.spawn;
    originalSleep = _regressionRunnerDeps.sleep;
  });

  afterEach(() => {
    _executorDeps.spawn = originalSpawn;
    _regressionRunnerDeps.sleep = originalSleep;
    mock.restore();
  });

  test("sleeps before executing and ignores expectedFiles (no asset check)", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _regressionRunnerDeps.sleep = sleepMock;
    const spawnStub = makeSpawn(() => ({ stdout: "ok", exitCode: 0 }));
    _executorDeps.spawn = spawnStub.spawn;

    const result = await regression({
      workdir: "/tmp/does-not-matter",
      command: "bun test",
      timeoutSeconds: 10,
      // Would fail asset verification if it ran — regression() must skip it.
      expectedFiles: ["definitely-missing-file.txt"],
    });

    expect(sleepMock).toHaveBeenCalledWith(2000);
    expect(result.status).toBe("SUCCESS");
    expect(result.success).toBe(true);
  });
});
