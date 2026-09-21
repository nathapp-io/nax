/**
 * US-001 Feature lock primitive — acceptance tests for
 * src/execution/feature-lock.ts.
 *
 * Covers all 17 acceptance criteria plus the shipped `releaseFeatureLock` and
 * `isLockSuspect` surface. Determinism comes from overriding the
 * `_featureLockDeps` seam (host, isProcessAlive, rename) exactly as the
 * `_lockDeps` seam is overridden for the checkout lock.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withWarnSpy } from "@test/helpers";
import * as executionBarrel from "@/execution";
import type { FeatureLockRecord } from "@/execution/feature-lock";
import {
  _featureLockDeps,
  acquireFeatureLock,
  featureLockPath,
  isLockReclaimable,
  isLockSuspect,
  lockHost,
  releaseFeatureLock,
} from "@/execution/feature-lock";

const HOUR_MS = 3_600_000;
const NOW = 1_700_000_000_000;

/** The contract lock path — <outputDir>/features/<feature>/nax.lock */
function lockPath(outputDir: string, feature: string): string {
  return join(outputDir, "features", feature, "nax.lock");
}

let savedDeps: typeof _featureLockDeps;
beforeEach(() => {
  savedDeps = { ..._featureLockDeps };
});
afterEach(() => {
  Object.assign(_featureLockDeps, savedDeps);
});

describe("US-001 barrel importability (public surface parity)", () => {
  test("every feature-lock symbol is re-exported from @/execution, matching the rest of the execution primitives", () => {
    // The execution module's public surface is its barrel (`@/execution`).
    // Every other execution primitive — `acquireLock`, `releaseLock`,
    // `_lockDeps`, `inspectRecurrenceBreaker`, `recordOscillations`, etc. —
    // is re-exported there, and the test suite imports from the barrel, not
    // from the internal file. The feature-lock primitive must follow the
    // same convention so (a) tests can target the public surface, and
    // (b) production callers depending on the barrel can use the new
    //     feature-lock API without reaching into an internal path.
    expect(typeof executionBarrel.featureLockPath).toBe("function");
    expect(typeof executionBarrel.acquireFeatureLock).toBe("function");
    expect(typeof executionBarrel.releaseFeatureLock).toBe("function");
    expect(typeof executionBarrel.lockHost).toBe("function");
    expect(typeof executionBarrel.isLockReclaimable).toBe("function");
    expect(typeof executionBarrel.isLockSuspect).toBe("function");
    // The `_featureLockDeps` seam is part of the public surface — every
    // other `_…Deps` object in the barrel is re-exported alongside the
    // function it backs so tests can mutate the seam through the barrel.
    expect(executionBarrel._featureLockDeps).toBeDefined();
  });
});

describe("featureLockPath", () => {
  test("US-001 AC1: returns <outputDir>/features/f/nax.lock", () => {
    const out = join("proj", "out");
    expect(featureLockPath(out, "f")).toBe(join(out, "features", "f", "nax.lock"));
  });

  test("US-001 AC1 (boundary): different features resolve to distinct lock paths", () => {
    const out = join("proj", "out");
    expect(featureLockPath(out, "auth")).not.toBe(featureLockPath(out, "billing"));
    expect(featureLockPath(out, "auth")).toBe(join(out, "features", "auth", "nax.lock"));
  });
});

describe("lockHost", () => {
  test("US-001 AC3: returns the value of os.hostname()", () => {
    expect(lockHost()).toBe(hostname());
  });
});

describe("isLockReclaimable", () => {
  test("US-001 AC5: false when the host matches this machine and the PID is alive, even when the lock is old", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => true;
    expect(isLockReclaimable({ pid: 1234, host: "test-machine", timestamp: NOW - 1000 }, NOW)).toBe(false);
    // A live local PID means the lock is never reclaimable — age must not flip the verdict.
    expect(isLockReclaimable({ pid: 1234, host: "test-machine", timestamp: NOW - 10 * HOUR_MS }, NOW)).toBe(false);
  });

  test("US-001 AC6: true when the host matches this machine and the PID is not alive, regardless of age", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => false;
    expect(isLockReclaimable({ pid: 999, host: "test-machine", timestamp: NOW - 1000 }, NOW)).toBe(true);
    expect(isLockReclaimable({ pid: 999, host: "test-machine", timestamp: NOW - 10 * HOUR_MS }, NOW)).toBe(true);
  });

  test("US-001 AC7: true when the record has no host field and the PID is not alive", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => false;
    expect(isLockReclaimable({ pid: 555, timestamp: NOW - 1000 }, NOW)).toBe(true);
  });

  test("US-001 AC8: false when the host differs and the lock is younger than two hours, even with the PID dead locally", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => false;
    expect(isLockReclaimable({ pid: 777, host: "other-machine", timestamp: NOW - HOUR_MS }, NOW)).toBe(false);
  });

  test("US-001 AC9: true when the host differs and the lock is older than two hours", () => {
    _featureLockDeps.host = () => "test-machine";
    // Strongest case: a foreign lock older than two hours is reclaimable even while a local PID exists.
    _featureLockDeps.isProcessAlive = () => true;
    expect(isLockReclaimable({ pid: 777, host: "other-machine", timestamp: NOW - 3 * HOUR_MS }, NOW)).toBe(true);
  });

  test("US-001 AC9 (boundary): a foreign lock at exactly two hours is reclaimable, just under is not", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => false;
    expect(isLockReclaimable({ pid: 777, host: "other-machine", timestamp: NOW - 2 * HOUR_MS }, NOW)).toBe(true);
    expect(isLockReclaimable({ pid: 777, host: "other-machine", timestamp: NOW - 2 * HOUR_MS + 1 }, NOW)).toBe(false);
  });

  test("US-001 AC10: compares host case-insensitively", () => {
    _featureLockDeps.host = () => "Test-Machine";
    _featureLockDeps.isProcessAlive = () => true;
    // Same machine with different casing → treated as local → a live PID keeps it non-reclaimable.
    expect(isLockReclaimable({ pid: 1, host: "test-machine", timestamp: NOW - 1000 }, NOW)).toBe(false);
    _featureLockDeps.isProcessAlive = () => false;
    expect(isLockReclaimable({ pid: 1, host: "test-machine", timestamp: NOW - 1000 }, NOW)).toBe(true);
  });

  test("US-001 AC11: resolves age from timestamp when present", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => false;
    // startedAt is 3h old but timestamp is 1h old — the timestamp must win → not reclaimable.
    expect(
      isLockReclaimable(
        {
          pid: 3,
          host: "other-machine",
          startedAt: new Date(NOW - 3 * HOUR_MS).toISOString(),
          timestamp: NOW - HOUR_MS,
        },
        NOW,
      ),
    ).toBe(false);
  });

  test("US-001 AC11: resolves age from startedAt when timestamp is absent", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => false;
    expect(
      isLockReclaimable({ pid: 3, host: "other-machine", startedAt: new Date(NOW - 3 * HOUR_MS).toISOString() }, NOW),
    ).toBe(true);
    expect(
      isLockReclaimable({ pid: 3, host: "other-machine", startedAt: new Date(NOW - HOUR_MS).toISOString() }, NOW),
    ).toBe(false);
  });
});

describe("isLockSuspect", () => {
  test("US-001: not suspect for a local host while its PID is alive, even when old", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => true;
    expect(isLockSuspect({ pid: 11, host: "test-machine", timestamp: NOW - 10 * HOUR_MS }, NOW)).toBe(false);
  });

  test("US-001: not suspect for a local host while the lock is younger than two hours, even with a dead PID", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => false;
    expect(isLockSuspect({ pid: 11, host: "test-machine", timestamp: NOW - HOUR_MS }, NOW)).toBe(false);
  });

  test("US-001: suspect for a local host only once its PID is dead and the lock is at least two hours old", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => false;
    expect(isLockSuspect({ pid: 11, host: "test-machine", timestamp: NOW - 2 * HOUR_MS }, NOW)).toBe(true);
  });

  test("US-001: a foreign host becomes suspect at or beyond two hours, not before", () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => true; // foreign verdict ignores local PID liveness
    expect(isLockSuspect({ pid: 22, host: "other-machine", timestamp: NOW - HOUR_MS }, NOW)).toBe(false);
    expect(isLockSuspect({ pid: 22, host: "other-machine", timestamp: NOW - 2 * HOUR_MS }, NOW)).toBe(true);
  });
});

describe("acquireFeatureLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir("nax-feature-lock-");
    _featureLockDeps.host = () => "test-machine";
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  test("US-001 AC2: writes a record whose pid, host, workdir, feature, runId and startedAt are populated", async () => {
    const workdir = join(dir, "checkout-a");
    const result = await acquireFeatureLock({ outputDir: dir, feature: "f", workdir, runId: "run-1" });
    expect(result.acquired).toBe(true);
    const recordPath = lockPath(dir, "f");
    expect(await Bun.file(recordPath).exists()).toBe(true);
    const record: FeatureLockRecord = JSON.parse(await Bun.file(recordPath).text());
    expect(record.pid).toBe(process.pid);
    expect(record.host).toBe("test-machine");
    expect(record.workdir).toBe(workdir);
    expect(record.feature).toBe("f");
    expect(record.runId).toBe("run-1");
    expect(typeof record.startedAt).toBe("string");
    expect(record.startedAt.length).toBeGreaterThan(0);
    expect(typeof record.timestamp).toBe("number");
  });

  test("US-001 AC4: creates <outputDir>/features/<feature>/ when that directory does not exist", async () => {
    const featureDir = join(dir, "features", "f");
    const dirExists = (p: string): boolean => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    };
    expect(dirExists(featureDir)).toBe(false); // precondition: directory is absent
    const result = await acquireFeatureLock({
      outputDir: dir,
      feature: "f",
      workdir: join(dir, "checkout-a"),
      runId: "run-1",
    });
    expect(result.acquired).toBe(true);
    expect(dirExists(featureDir)).toBe(true);
  });

  test("US-001 AC12: refuses the same feature from a different workdir while isLockReclaimable is false", async () => {
    _featureLockDeps.isProcessAlive = () => true; // the holder PID is the live test process
    const first = await acquireFeatureLock({
      outputDir: dir,
      feature: "f",
      workdir: join(dir, "checkout-a"),
      runId: "run-a",
    });
    expect(first.acquired).toBe(true);
    const second = await acquireFeatureLock({
      outputDir: dir,
      feature: "f",
      workdir: join(dir, "checkout-b"),
      runId: "run-b",
    });
    expect(second.acquired).toBe(false);
  });

  test("US-001 AC13: the refusal carries the holder's pid, host and workdir read from the existing record", async () => {
    _featureLockDeps.isProcessAlive = () => true;
    const firstWorkdir = join(dir, "checkout-a");
    await acquireFeatureLock({ outputDir: dir, feature: "f", workdir: firstWorkdir, runId: "run-a" });
    const second = await acquireFeatureLock({
      outputDir: dir,
      feature: "f",
      workdir: join(dir, "checkout-b"),
      runId: "run-b",
    });
    expect(second.acquired).toBe(false);
    if (second.acquired === false) {
      expect(second.holder.pid).toBe(process.pid);
      expect(second.holder.host).toBe("test-machine");
      expect(second.holder.workdir).toBe(firstWorkdir);
      expect(second.holder.feature).toBe("f");
      expect(second.holder.runId).toBe("run-a");
      expect(typeof second.holder.startedAt).toBe("string");
      expect(typeof second.holder.timestamp).toBe("number");
    }
  });

  test("US-001 AC14: acquires a different feature in the same output dir while the first feature's lock is held", async () => {
    _featureLockDeps.isProcessAlive = () => true;
    const first = await acquireFeatureLock({
      outputDir: dir,
      feature: "f1",
      workdir: join(dir, "checkout-a"),
      runId: "r1",
    });
    expect(first.acquired).toBe(true);
    const second = await acquireFeatureLock({
      outputDir: dir,
      feature: "f2",
      workdir: join(dir, "checkout-a"),
      runId: "r2",
    });
    expect(second.acquired).toBe(true);
    // each feature is namespaced to its own lock file
    expect(await Bun.file(lockPath(dir, "f1")).exists()).toBe(true);
    expect(await Bun.file(lockPath(dir, "f2")).exists()).toBe(true);
  });

  test("US-001 AC15: logs at warn level and replaces a lock file whose contents do not parse", async () => {
    const recordPath = lockPath(dir, "f");
    mkdirSync(join(dir, "features", "f"), { recursive: true });
    await Bun.write(recordPath, "{ not valid json");
    await withWarnSpy(async (warnSpy) => {
      const result = await acquireFeatureLock({
        outputDir: dir,
        feature: "f",
        workdir: join(dir, "checkout-a"),
        runId: "run-1",
      });
      expect(result.acquired).toBe(true);
      expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    });
    // the corrupt file was replaced by a parseable record
    const record: FeatureLockRecord = JSON.parse(await Bun.file(recordPath).text());
    expect(record.pid).toBe(process.pid);
    expect(record.workdir).toBe(join(dir, "checkout-a"));
    expect(record.runId).toBe("run-1");
  });

  test("US-001 AC16: exclusive-create means a second call after the file appears refuses rather than overwriting it", async () => {
    _featureLockDeps.isProcessAlive = () => true;
    const recordPath = lockPath(dir, "f");
    const first = await acquireFeatureLock({
      outputDir: dir,
      feature: "f",
      workdir: join(dir, "checkout-a"),
      runId: "run-a",
    });
    expect(first.acquired).toBe(true);
    const second = await acquireFeatureLock({
      outputDir: dir,
      feature: "f",
      workdir: join(dir, "checkout-b"),
      runId: "run-b",
    });
    expect(second.acquired).toBe(false);
    // the holder's record was not overwritten by the refused caller
    const record: FeatureLockRecord = JSON.parse(await Bun.file(recordPath).text());
    expect(record.runId).toBe("run-a");
    expect(record.workdir).toBe(join(dir, "checkout-a"));
  });

  test("US-001 AC17: when the injected rename seam lets only one racer claim a reclaimable record, exactly one acquires", async () => {
    _featureLockDeps.host = () => "test-machine";
    _featureLockDeps.isProcessAlive = () => false; // the planted record is reclaimable
    const recordPath = lockPath(dir, "f");
    mkdirSync(join(dir, "features", "f"), { recursive: true });
    await Bun.write(
      recordPath,
      JSON.stringify({
        pid: 424_242,
        host: "test-machine",
        workdir: join(dir, "old-checkout"),
        feature: "f",
        runId: "old-run",
        startedAt: new Date(Date.now() - 10 * HOUR_MS).toISOString(),
        timestamp: Date.now() - 10 * HOUR_MS,
      }),
    );

    const realRename = _featureLockDeps.rename;
    let claimed = false;
    _featureLockDeps.rename = (from: Parameters<typeof realRename>[0], to: Parameters<typeof realRename>[1]) => {
      if (claimed) {
        // simulate the second racer losing the rename race (BUG-34 window)
        throw Object.assign(new Error(`ENOENT: ${String(from)} -> ${String(to)}`), { code: "ENOENT" });
      }
      claimed = true;
      return realRename(from, to);
    };

    const results = await Promise.all([
      acquireFeatureLock({ outputDir: dir, feature: "f", workdir: join(dir, "checkout-a"), runId: "run-a" }),
      acquireFeatureLock({ outputDir: dir, feature: "f", workdir: join(dir, "checkout-b"), runId: "run-b" }),
    ]);
    expect(results.filter((r) => r.acquired).length).toBe(1);
  });
});

describe("releaseFeatureLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir("nax-feature-lock-");
    _featureLockDeps.host = () => "test-machine";
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  test("US-001: removes the lock when the on-disk runId equals the caller's", async () => {
    const recordPath = lockPath(dir, "f");
    const runId = "run-1";
    const acquired = await acquireFeatureLock({
      outputDir: dir,
      feature: "f",
      workdir: join(dir, "checkout-a"),
      runId,
    });
    expect(acquired.acquired).toBe(true);
    expect(await Bun.file(recordPath).exists()).toBe(true);
    await releaseFeatureLock({ outputDir: dir, feature: "f", runId });
    expect(await Bun.file(recordPath).exists()).toBe(false);
  });

  test("US-001: leaves the lock in place when the on-disk runId differs from the caller's (no-op)", async () => {
    const recordPath = lockPath(dir, "f");
    mkdirSync(join(dir, "features", "f"), { recursive: true });
    await Bun.write(
      recordPath,
      JSON.stringify({
        pid: 1,
        host: "other",
        workdir: join(dir, "other-checkout"),
        feature: "f",
        runId: "other-run",
        startedAt: new Date().toISOString(),
        timestamp: Date.now(),
      }),
    );
    await releaseFeatureLock({ outputDir: dir, feature: "f", runId: "caller-run" });
    expect(await Bun.file(recordPath).exists()).toBe(true);
    expect(await Bun.file(recordPath).text()).toContain("other-run");
  });

  test("US-001: resolves silently when the lock file is absent (ENOENT)", async () => {
    const recordPath = lockPath(dir, "f");
    await releaseFeatureLock({ outputDir: dir, feature: "f", runId: "run-1" });
    expect(await Bun.file(recordPath).exists()).toBe(false);
  });

  // US-002 AC9/AC10 — these are the same primitives US-001 shipped, re-pinned
  // under the run-lifecycle story's IDs since the run-lifecycle release sites
  // (run-setup / run-cleanup) depend on them.
  test("US-002 AC9: leaves the lock file in place when the on-disk record's runId is not the releasing run's", async () => {
    const recordPath = lockPath(dir, "f");
    mkdirSync(join(dir, "features", "f"), { recursive: true });
    await Bun.write(
      recordPath,
      JSON.stringify({
        pid: 1,
        host: "other",
        workdir: join(dir, "other-checkout"),
        feature: "f",
        runId: "other-run",
        startedAt: new Date().toISOString(),
        timestamp: Date.now(),
      }),
    );
    await releaseFeatureLock({ outputDir: dir, feature: "f", runId: "caller-run" });
    expect(await Bun.file(recordPath).exists()).toBe(true);
    expect(await Bun.file(recordPath).text()).toContain("other-run");
  });

  test("US-002 AC10: resolves without error when the lock file is already absent", async () => {
    const recordPath = lockPath(dir, "f");
    await expect(releaseFeatureLock({ outputDir: dir, feature: "f", runId: "run-1" })).resolves.toBeUndefined();
    expect(await Bun.file(recordPath).exists()).toBe(false);
  });
});
