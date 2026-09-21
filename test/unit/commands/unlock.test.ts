// RE-ARCH: keep
/**
 * Unit tests for the nax unlock command
 *
 * Covers all acceptance criteria:
 * AC1: No lock file -> prints 'No lock file found', exits 0
 * AC2: Lock PID alive -> prints error, exits 1, lock untouched
 * AC3: Lock PID dead -> prints lock info (PID, age), removes lock, exits 0
 * AC4: --force -> removes lock unconditionally, exits 0
 * AC5: -d <path> -> targets specified directory (not cwd)
 * AC6: Unit coverage of all four scenarios
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeNaxConfig, makeTempDir } from "@test/helpers";
import { _unlockDeps, unlockCommand } from "@/commands/unlock";
import { _featureLockDeps } from "@/execution";

// ---------------------------------------------------------------------------
// Custom error to intercept process.exit without terminating the test runner
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitError";
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function writeLock(dir: string, pid: number, ageMs = 0): Promise<void> {
  const lockData = { pid, timestamp: Date.now() - ageMs };
  await Bun.write(join(dir, "nax.lock"), JSON.stringify(lockData));
}

/**
 * Write a feature lock at `<outputDir>/features/<feature>/nax.lock`. The record
 * shape matches the one `acquireFeatureLock` writes so the same isLockSuspect
 * predicate can be applied without re-shaping the JSON.
 */
async function writeFeatureLock(
  outputDir: string,
  feature: string,
  opts: {
    pid: number;
    host?: string;
    runId?: string;
    workdir?: string;
    ageMs?: number;
  },
): Promise<string> {
  const featureDir = join(outputDir, "features", feature);
  mkdirSync(featureDir, { recursive: true });
  const lockPath = join(featureDir, "nax.lock");
  const startedAt = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString();
  const lockData = {
    pid: opts.pid,
    host: opts.host ?? "test-machine",
    workdir: opts.workdir ?? "/tmp/workdir",
    feature,
    runId: opts.runId ?? "run-1",
    startedAt,
    timestamp: Date.now() - (opts.ageMs ?? 0),
  };
  await Bun.write(lockPath, JSON.stringify(lockData));
  return lockPath;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("unlockCommand", () => {
  let testDir: string;
  let capturedOutput: string[];
  let capturedErrors: string[];
  let exitCode: number | null;

  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let savedUnlockDeps: typeof _unlockDeps;
  let savedFeatureLockDeps: typeof _featureLockDeps;

  beforeEach(() => {
    const raw = makeTempDir("nax-unlock-test-");
    testDir = realpathSync(raw);

    capturedOutput = [];
    capturedErrors = [];
    exitCode = null;

    console.log = (...args: unknown[]) => {
      capturedOutput.push(args.join(" "));
    };
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.join(" "));
    };

    // Intercept process.exit: record the code and throw so the command stops.
    process.exit = (code?: number): never => {
      exitCode = code ?? 0;
      throw new ExitError(exitCode);
    };

    // Save and reset the _unlockDeps seam so the feature-lock tests can
    // override `projectOutputDir` without bleeding into the next case.
    savedUnlockDeps = { ..._unlockDeps };
    savedFeatureLockDeps = { ..._featureLockDeps };
    _featureLockDeps.host = () => "test-machine";
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;

    Object.assign(_unlockDeps, savedUnlockDeps);
    Object.assign(_featureLockDeps, savedFeatureLockDeps);

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Helper: run unlockCommand, absorbing ExitError but re-throwing other errors.
  async function run(options: Parameters<typeof unlockCommand>[0]): Promise<void> {
    try {
      await unlockCommand(options);
    } catch (err) {
      if (!(err instanceof ExitError)) {
        throw err;
      }
    }
  }

  function allOutput(): string {
    return [...capturedOutput, ...capturedErrors].join("\n");
  }

  // =========================================================================
  // AC1: No lock file present
  // =========================================================================

  describe("AC1: no lock file", () => {
    test("prints 'No lock file found' and exits 0", async () => {
      await run({ dir: testDir });

      expect(allOutput()).toContain("No lock file found");
      // exit 0 means either natural return (exitCode null) or explicit exit(0)
      expect(exitCode === null || exitCode === 0).toBe(true);
    });

    test("does not create a lock file", async () => {
      await run({ dir: testDir });

      expect(existsSync(join(testDir, "nax.lock"))).toBe(false);
    });
  });

  // =========================================================================
  // AC2: Lock PID is alive — refuse to unlock
  // =========================================================================

  describe("AC2: lock PID is alive", () => {
    test("prints 'nax is still running (PID <n>). Use --force to override.'", async () => {
      // process.pid is the current test-runner process — always alive.
      await writeLock(testDir, process.pid);

      await run({ dir: testDir });

      expect(allOutput()).toContain(`nax is still running (PID ${process.pid})`);
      expect(allOutput()).toContain("--force");
    });

    test("exits with code 1", async () => {
      await writeLock(testDir, process.pid);

      await run({ dir: testDir });

      expect(exitCode).toBe(1);
    });

    test("does NOT delete the lock file", async () => {
      const lockPath = join(testDir, "nax.lock");
      await writeLock(testDir, process.pid);

      await run({ dir: testDir });

      expect(existsSync(lockPath)).toBe(true);
    });
  });

  // =========================================================================
  // AC3: Lock PID is dead — unlock and clean up
  // =========================================================================

  describe("AC3: lock PID is dead", () => {
    // PID 999999 is astronomically unlikely to exist on any real system.
    const DEAD_PID = 999999;

    test("prints lock info including PID before removing", async () => {
      await writeLock(testDir, DEAD_PID, 5 * 60 * 1000); // 5 minutes old

      await run({ dir: testDir });

      expect(allOutput()).toContain(String(DEAD_PID));
    });

    test("prints lock age in minutes", async () => {
      await writeLock(testDir, DEAD_PID, 5 * 60 * 1000); // 5 minutes old

      await run({ dir: testDir });

      // Output should mention age in minutes (e.g. "5 min" or "5 minutes")
      expect(allOutput()).toMatch(/\d+\s*min/i);
    });

    test("removes nax.lock", async () => {
      const lockPath = join(testDir, "nax.lock");
      await writeLock(testDir, DEAD_PID);

      await run({ dir: testDir });

      expect(existsSync(lockPath)).toBe(false);
    });

    test("exits 0", async () => {
      await writeLock(testDir, DEAD_PID);

      await run({ dir: testDir });

      expect(exitCode === null || exitCode === 0).toBe(true);
    });
  });

  // =========================================================================
  // AC4: --force flag — unconditional removal
  // =========================================================================

  describe("AC4: --force flag", () => {
    test("removes lock even when PID is alive", async () => {
      const lockPath = join(testDir, "nax.lock");
      // process.pid is alive
      await writeLock(testDir, process.pid);

      await run({ dir: testDir, force: true });

      expect(existsSync(lockPath)).toBe(false);
    });

    test("exits 0 when lock was held by a live PID", async () => {
      await writeLock(testDir, process.pid);

      await run({ dir: testDir, force: true });

      expect(exitCode === null || exitCode === 0).toBe(true);
    });

    test("exits 0 when there is no lock file at all", async () => {
      // No lock written — --force should still succeed gracefully
      await run({ dir: testDir, force: true });

      expect(exitCode === null || exitCode === 0).toBe(true);
    });

    test("does not print the 'still running' refusal message", async () => {
      await writeLock(testDir, process.pid);

      await run({ dir: testDir, force: true });

      expect(allOutput()).not.toContain("nax is still running");
    });
  });

  // =========================================================================
  // AC5: -d <path> flag — target a specific directory
  // =========================================================================

  describe("AC5: -d <path> targets the specified directory", () => {
    test("reads lock from the specified directory, not cwd", async () => {
      const altDir = realpathSync(
        (() => {
          const d = makeTempDir("nax-unlock-alt-");
          mkdirSync(d, { recursive: true });
          return d;
        })(),
      );

      const DEAD_PID = 999999;
      await writeLock(altDir, DEAD_PID);

      const altLockPath = join(altDir, "nax.lock");
      const testDirLockPath = join(testDir, "nax.lock");

      await run({ dir: altDir });

      // The lock in altDir must be removed
      expect(existsSync(altLockPath)).toBe(false);
      // The (absent) lock in testDir must remain absent
      expect(existsSync(testDirLockPath)).toBe(false);

      rmSync(altDir, { recursive: true, force: true });
    });

    test("ignores cwd when -d is provided and cwd has no lock", async () => {
      // Put a lock ONLY in altDir; cwd (testDir) has no lock
      const altDir = realpathSync(
        (() => {
          const d = makeTempDir("nax-unlock-alt2-");
          mkdirSync(d, { recursive: true });
          return d;
        })(),
      );

      // No lock in altDir either — just confirming it reads from altDir
      await run({ dir: altDir });

      // AC1 behaviour applies for the targeted dir (no lock file)
      expect(allOutput()).toContain("No lock file found");

      rmSync(altDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // AC6: Scenario matrix — all four core cases covered by unit tests
  //
  // (Verified by the tests above; this block provides explicit proof that
  // each scenario class is addressed.)
  // =========================================================================

  describe("AC6: all four scenario classes covered", () => {
    const DEAD_PID = 999999;

    test("scenario: no lock", async () => {
      await run({ dir: testDir });
      expect(allOutput()).toContain("No lock file found");
    });

    test("scenario: alive PID without --force", async () => {
      await writeLock(testDir, process.pid);
      await run({ dir: testDir });
      expect(exitCode).toBe(1);
    });

    test("scenario: dead PID without --force", async () => {
      await writeLock(testDir, DEAD_PID);
      await run({ dir: testDir });
      expect(existsSync(join(testDir, "nax.lock"))).toBe(false);
    });

    test("scenario: --force removes lock regardless of PID state", async () => {
      await writeLock(testDir, process.pid);
      await run({ dir: testDir, force: true });
      expect(existsSync(join(testDir, "nax.lock"))).toBe(false);
    });
  });

  // =========================================================================
  // US-003: Feature-scoped unlock
  //
  // The unlock command gains a `-f, --feature <name>` option. With a feature
  // it resolves the lock at `<outputDir>/features/<feature>/nax.lock` via the
  // findProjectDir → loadConfig → projectOutputDir chain (mirroring resume.ts).
  // Without one it still handles the checkout lock and additionally scans
  // `<outputDir>/features/*/nax.lock`, removing only those `isLockSuspect`
  // accepts (or all of them with `--force`).
  // =========================================================================

  /**
   * Set up the test as if testDir were an initialized nax repo and the
   * output directory were the given tempOutputDir. Overrides _unlockDeps so
   * the findProjectDir/loadConfig/projectOutputDir chain resolves to testDir
   * (the project) and the given tempOutputDir (the registry output dir) —
   * without touching the real home-scoped nax directory.
   *
   * `mock()` from bun:test keeps each function's declared signature intact,
   * so the assignment to `_unlockDeps.X` is type-safe without an `as` cast.
   * `makeNaxConfig` returns a full NaxConfig (DEFAULT_CONFIG merged with
   * overrides), so the mock satisfies the seam's declared return type.
   */
  function setupNaxRepoWithOutputDir(workdir: string, tempOutputDir: string, projectName = "test-proj"): void {
    // Mirror what `nax init` writes so findProjectDir accepts it.
    mkdirSync(join(workdir, ".nax"), { recursive: true });
    writeFileSync(join(workdir, ".nax", "config.json"), JSON.stringify({ name: projectName, outputDir: undefined }));
    _unlockDeps.findProjectDir = mock(() => join(workdir, ".nax"));
    _unlockDeps.loadConfig = mock(async () => makeNaxConfig({ name: projectName }));
    _unlockDeps.projectOutputDir = mock(() => tempOutputDir);
  }

  describe("US-003 AC2: unlock with -f removes the feature lock and exits 0", () => {
    test("removes <outputDir>/features/<feature>/nax.lock when isLockSuspect accepts (dead+aged)", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-feature-out-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        _featureLockDeps.isProcessAlive = () => false; // dead PID → suspect once aged
        const lockPath = await writeFeatureLock(tempOutputDir, "auth", {
          pid: 999999,
          ageMs: 3 * 60 * 60 * 1000, // 3 hours old
        });

        await run({ dir: testDir, feature: "auth" });

        expect(existsSync(lockPath)).toBe(false);
        expect(exitCode === null || exitCode === 0).toBe(true);
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });

    test("prints the feature lock info before removing it", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-feature-info-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        _featureLockDeps.isProcessAlive = () => false;
        await writeFeatureLock(tempOutputDir, "auth", {
          pid: 888_888,
          ageMs: 3 * 60 * 60 * 1000,
        });

        await run({ dir: testDir, feature: "auth" });

        // Surfaces the PID so an operator can see which lock they removed.
        expect(allOutput()).toContain("888888");
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });
  });

  describe("US-003: unlock -f refuses a live holder without --force", () => {
    test("exits 1 and leaves the feature lock untouched when the holder PID is alive", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-feature-live-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        _featureLockDeps.isProcessAlive = () => true; // live holder → not suspect
        const lockPath = await writeFeatureLock(tempOutputDir, "auth", {
          pid: 1,
          ageMs: 3 * 60 * 60 * 1000,
        });

        await run({ dir: testDir, feature: "auth" });

        expect(exitCode).toBe(1);
        expect(existsSync(lockPath)).toBe(true);
        expect(allOutput()).toContain("still running");
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });

    test("US-003 AC3: --force removes the feature lock even when isLockSuspect reports the holder live", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-feature-force-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        _featureLockDeps.isProcessAlive = () => true; // live holder → would normally refuse
        const lockPath = await writeFeatureLock(tempOutputDir, "auth", {
          pid: 1,
          ageMs: 3 * 60 * 60 * 1000,
        });

        await run({ dir: testDir, feature: "auth", force: true });

        expect(existsSync(lockPath)).toBe(false);
        expect(exitCode === null || exitCode === 0).toBe(true);
        expect(allOutput()).not.toContain("still running");
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });
  });

  describe("US-003: unlock -f handles a missing feature lock", () => {
    test("exits 0 and reports no lock when the feature lock is absent", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-feature-missing-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);

        await run({ dir: testDir, feature: "auth" });

        expect(exitCode === null || exitCode === 0).toBe(true);
        // Output mentions either "No lock" or an equivalent — the operator
        // must see something so the silent success isn't mistaken for a bug.
        const out = allOutput();
        expect(out.length).toBeGreaterThan(0);
        expect(out.toLowerCase()).toContain("lock");
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });
  });

  describe("US-003: unlock without -f scans features/* for stale feature locks", () => {
    test("AC5: reports a feature lock whose holder is live and leaves it in place", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-scan-live-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        _featureLockDeps.isProcessAlive = () => true; // live → not suspect → leave it
        const lockPath = await writeFeatureLock(tempOutputDir, "auth", {
          pid: 1,
          ageMs: 3 * 60 * 60 * 1000,
        });
        // Ensure the checkout lock is NOT present — scan must run regardless.

        await run({ dir: testDir });

        // Lock must remain because the holder is live (no --force).
        expect(existsSync(lockPath)).toBe(true);
        // Operator must see that a live holder was found and skipped.
        const out = allOutput();
        expect(out).toContain("auth");
        expect(out.toLowerCase()).toMatch(/still running|live/);
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });

    test("AC6: runs the feature-lock scan and reports what it finds even when no checkout lock exists", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-scan-nock-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        _featureLockDeps.isProcessAlive = () => false; // dead+aged → suspect → removable
        const lockPath = await writeFeatureLock(tempOutputDir, "auth", {
          pid: 999_999,
          ageMs: 3 * 60 * 60 * 1000,
        });
        // No checkout lock — but the scan must still run.

        await run({ dir: testDir });

        // AC6 says the scan runs and reports what it finds. The lock is
        // suspect, so the scan removes it.
        expect(existsSync(lockPath)).toBe(false);
        expect(allOutput()).toContain("auth");
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });

    test("AC6 (boundary): reports a clean scan when there is no checkout lock AND no feature locks", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-scan-empty-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        // No checkout lock, no feature locks — scan runs but finds nothing.

        await run({ dir: testDir });

        // Exits 0; output mentions something about the lock state so the
        // operator sees the scan actually ran (not a hung UI).
        expect(exitCode === null || exitCode === 0).toBe(true);
        const out = allOutput();
        // Should mention at least one of: "No lock", "feature", or list
        // emptiness so the operator can see the scan completed.
        expect(out.length).toBeGreaterThan(0);
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });

    test("AC7: --force removes a feature lock whose holder is live", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-scan-force-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        _featureLockDeps.isProcessAlive = () => true; // live — only --force clears it
        const lockPath = await writeFeatureLock(tempOutputDir, "auth", {
          pid: 1,
          ageMs: 3 * 60 * 60 * 1000,
        });

        await run({ dir: testDir, force: true });

        expect(existsSync(lockPath)).toBe(false);
        expect(exitCode === null || exitCode === 0).toBe(true);
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });

    test("removes only stale feature locks in a single scan (live ones left in place)", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-scan-mixed-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        // First feature: dead+aged → suspect → removable
        // Second feature: live → not suspect → keep
        // The seam matches by pid so the two feature locks resolve differently.
        const livePid = 1;
        _featureLockDeps.isProcessAlive = (pid: number) => pid === livePid;

        const deadLockPath = await writeFeatureLock(tempOutputDir, "dead-feat", {
          pid: 999_999, // not live → dead
          ageMs: 3 * 60 * 60 * 1000,
        });
        const liveLockPath = await writeFeatureLock(tempOutputDir, "live-feat", {
          pid: livePid, // live → not suspect → keep
          ageMs: 3 * 60 * 60 * 1000,
        });

        await run({ dir: testDir });

        expect(existsSync(deadLockPath)).toBe(false);
        expect(existsSync(liveLockPath)).toBe(true);
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });

    test("removes the checkout lock AND removes a stale feature lock in the same scan", async () => {
      const tempOutputDir = realpathSync(makeTempDir("nax-unlock-scan-both-"));
      try {
        setupNaxRepoWithOutputDir(testDir, tempOutputDir);
        _featureLockDeps.isProcessAlive = () => false; // both stale, both removable
        await writeLock(testDir, 999_999, 3 * 60 * 60 * 1000);
        const featureLockPath = await writeFeatureLock(tempOutputDir, "auth", {
          pid: 999_998,
          ageMs: 3 * 60 * 60 * 1000,
        });

        await run({ dir: testDir });

        expect(existsSync(join(testDir, "nax.lock"))).toBe(false);
        expect(existsSync(featureLockPath)).toBe(false);
        expect(exitCode === null || exitCode === 0).toBe(true);
      } finally {
        rmSync(tempOutputDir, { recursive: true, force: true });
      }
    });
  });
});
