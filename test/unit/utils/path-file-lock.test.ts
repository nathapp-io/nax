/**
 * Tests for withPathFileLock — generic path-keyed lock for serializing
 * read-modify-write sequences across processes (BUG-6).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let deps: typeof import("../../../src/utils/path-file-lock")._pathFileLockDeps;
let orig: typeof deps;

beforeEach(async () => {
  const mod = await import("../../../src/utils/path-file-lock");
  deps = mod._pathFileLockDeps;
  orig = { ...deps };
});

afterEach(() => {
  Object.assign(deps, orig);
  mock.restore();
});

const TARGET = "/tmp/nax-path-lock-test/metrics.json";

describe("withPathFileLock — concurrent writers (BUG-6)", () => {
  test("two concurrent saves preserve both writes (no lost-update)", async () => {
    // Use real filesystem under /tmp so both acquisitions actually serialize.
    const dir = `/tmp/nax-path-lock-test-${Date.now()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    const target = `${dir}/metrics.json`;
    await Bun.write(target, "[]");

    const mod = await import("../../../src/utils/path-file-lock");
    const writers = Array.from({ length: 8 }, (_, i) =>
      mod.withPathFileLock(target, async () => {
        const cur = (await Bun.file(target).json()) as number[];
        cur.push(i);
        // Add a tiny delay so contention is real.
        await new Promise((r) => setTimeout(r, 5));
        await Bun.write(target, JSON.stringify(cur));
      }),
    );
    await Promise.all(writers);

    const final = (await Bun.file(target).json()) as number[];
    expect(final.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    await Bun.$`rm -rf ${dir}`.quiet();
  });
});

describe("withPathFileLock — stale lock cleanup", () => {
  test("evicts a stale lock whose pid is no longer alive", async () => {
    const dir = `/tmp/nax-path-lock-test-${Date.now()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    const target = `${dir}/metrics.json`;
    const staleName = "metrics.json.lock.0001000000000.8888.deadlock";
    await Bun.write(`${dir}/${staleName}`, "");

    const mod = await import("../../../src/utils/path-file-lock");
    await mod.withPathFileLock(target, async () => {});

    const remaining = await Bun.$`ls ${dir}`.text();
    // The stale lock should have been unlinked; only the active one's (and ours) leftover is acceptable.
    expect(remaining.includes(staleName)).toBe(false);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("does NOT evict a lock whose pid is still alive (even if old)", async () => {
    const dir = `/tmp/nax-path-lock-test-${Date.now()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    const target = `${dir}/metrics.json`;
    // Pid 9999 will be reported alive by the mock below; we never actually run it.
    const liveName = "metrics.json.lock.0001000000000.9999.livelock";
    await Bun.write(`${dir}/${liveName}`, "");

    Object.assign(deps, {
      isPidAlive: (pid: number) => pid === 9999,
    });

    const mod = await import("../../../src/utils/path-file-lock");
    // This call will time out (9999 is reported alive so listLiveCandidates keeps returning
    // a candidate, so we never win the acquisition). Use a short timeout via deps.now trick:
    // simpler — make readdir return ONLY the live candidate and accept that the call
    // eventually times out. We only care that the live candidate was NOT unlinked.
    // Wrap in a try/catch so the timeout doesn't fail the test.
    try {
      await mod.withPathFileLock(target, async () => {}, { timeoutMs: 50, retryMs: 5 });
    } catch {
      // Expected timeout.
    }

    const remaining = await Bun.$`ls ${dir}`.text();
    expect(remaining.includes(liveName)).toBe(true);

    await Bun.$`rm -rf ${dir}`.quiet();
  });
});

describe("withPathFileLock — timeout", () => {
  test("throws when the lock cannot be acquired within timeoutMs", async () => {
    const dir = `/tmp/nax-path-lock-test-${Date.now()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    const target = `${dir}/metrics.json`;
    // Plant an alive-pid lock that will never be released.
    await Bun.write(`${dir}/metrics.json.lock.0002000000000.7777.forever`, "");

    Object.assign(deps, {
      isPidAlive: () => true,
    });

    const mod = await import("../../../src/utils/path-file-lock");
    await expect(mod.withPathFileLock(target, async () => {}, { timeoutMs: 30, retryMs: 5 })).rejects.toThrow(
      /Timed out acquiring path lock/,
    );

    await Bun.$`rm -rf ${dir}`.quiet();
  });
});
