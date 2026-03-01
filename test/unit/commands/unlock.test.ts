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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlockCommand } from "../../../src/commands/unlock";

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

  beforeEach(() => {
    const raw = join(tmpdir(), `nax-unlock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
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
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new ExitError(exitCode);
    }) as never;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;

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
          const d = join(tmpdir(), `nax-unlock-alt-${Date.now()}`);
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
          const d = join(tmpdir(), `nax-unlock-alt2-${Date.now()}`);
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
});
