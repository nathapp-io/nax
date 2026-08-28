/**
 * Tests for the shared single-file lock (`withFileLock`) that backs
 * `withPathFileLock` and `withQueueFileLock`.
 *
 * Pins:
 * - BUG-6 / #1731: mutual exclusion — the failure mode of the previous
 *   candidate-ordering design (two writers inside the critical section,
 *   one write silently lost).
 * - BUG-10: a lock whose holder pid is still alive is never stolen, no
 *   matter how old; a proven-dead holder is reclaimed.
 * - BUG-25: unparseable lock content is respected until it ages out.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { _fileLockDeps, withFileLock } from "@/utils/file-lock";

const PATH_LOCK_OPTS = { lockName: "path", errorPrefix: "[path-lock]" } as const;

let orig: typeof _fileLockDeps;

beforeEach(() => {
  orig = { ..._fileLockDeps };
});

afterEach(() => {
  Object.assign(_fileLockDeps, orig);
  mock.restore();
});

async function makeTempDir(): Promise<{ dir: string; target: string; lockPath: string }> {
  const dir = `/tmp/nax-file-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await Bun.$`mkdir -p ${dir}`.quiet();
  return { dir, target: `${dir}/metrics.json`, lockPath: `${dir}/metrics.json.lock` };
}

describe("withFileLock — mutual exclusion", () => {
  test("serializes 8 concurrent read-modify-write writers (no lost update, BUG-6)", async () => {
    const { dir, target, lockPath } = await makeTempDir();
    await Bun.write(target, "[]");

    const writers = Array.from({ length: 8 }, (_, i) =>
      withFileLock(
        lockPath,
        async () => {
          const cur = (await Bun.file(target).json()) as number[];
          cur.push(i);
          // Add a tiny delay so contention is real.
          await Bun.sleep(5);
          await Bun.write(target, JSON.stringify(cur));
        },
        PATH_LOCK_OPTS,
      ),
    );
    await Promise.all(writers);

    const final = (await Bun.file(target).json()) as number[];
    expect(final.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    await Bun.$`rm -rf ${dir}`.quiet();
  }, 20_000);

  test("#1731: a create attempt landing while the holder is inside waits its turn", async () => {
    // Deterministic regression for #1731: gate the SECOND exclusive-create
    // until writer A is already inside the critical section. The previous
    // design let the late candidate win the "oldest" ordering and enter
    // concurrently; the exclusive-create design must make B wait.
    const { dir, lockPath } = await makeTempDir();

    const realWriteFile = _fileLockDeps.writeFile;
    let createCalls = 0;
    let releaseSecondCreate: () => void = () => {};
    const secondCreateGated = new Promise<void>((resolve) => {
      releaseSecondCreate = resolve;
    });
    const gatedWriteFile = async (path: string, data: string, options?: { flag?: string }) => {
      createCalls++;
      if (createCalls === 2) await secondCreateGated;
      return realWriteFile(path, data, options);
    };
    Object.assign(_fileLockDeps, {
      // Object.assign does not check property assignability — the narrower
      // mock signature is fine at runtime because the lock calls writeFile
      // with exactly these argument shapes.
      writeFile: gatedWriteFile,
    });

    let inside = 0;
    let maxInside = 0;
    let signalAEntered: () => void = () => {};
    const aEntered = new Promise<void>((resolve) => {
      signalAEntered = resolve;
    });

    const writerA = withFileLock(
      lockPath,
      async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        signalAEntered();
        await Bun.sleep(80);
        inside--;
      },
      PATH_LOCK_OPTS,
    );

    await aEntered;
    releaseSecondCreate();

    const writerB = withFileLock(
      lockPath,
      async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        inside--;
      },
      PATH_LOCK_OPTS,
    );

    await Promise.all([writerA, writerB]);

    expect(maxInside).toBe(1);

    await Bun.$`rm -rf ${dir}`.quiet();
  }, 10_000);
});

describe("withFileLock — stale lock handling (BUG-10 / BUG-25)", () => {
  test("reclaims a lock whose holder pid is proven dead", async () => {
    const { dir, lockPath } = await makeTempDir();
    await Bun.write(lockPath, "424242\n");
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid !== 424242 });

    const state = { ran: false, holderPidInside: null as number | null };
    await withFileLock(
      lockPath,
      async () => {
        state.ran = true;
        state.holderPidInside = Number.parseInt((await Bun.file(lockPath).text()).trim(), 10);
      },
      PATH_LOCK_OPTS,
    );

    expect(state.ran).toBe(true);
    expect(state.holderPidInside).toBe(process.pid);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("gravedigger declines to unlink when its stale observation was replaced by a live holder", async () => {
    // The heart of the claim protocol: a waiter observes a dead holder,
    // wins the claim, but the lock file was replaced by a NEW live holder
    // before the re-verify read. The re-verify must see pid !== observedPid
    // and decline — otherwise the gravedigger would delete a live lock.
    const { dir, lockPath } = await makeTempDir();
    const claimPath = `${lockPath}.claim`;
    await Bun.write(lockPath, "424242\n");
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid !== 424242 });

    const realReadFile = _fileLockDeps.readFile;
    let lockReads = 0;
    const gatedReadFile = async (path: string, encoding: BufferEncoding) => {
      if (path === lockPath) {
        lockReads++;
        if (lockReads === 2) {
          // Between our observation (read 1) and the claim-holder's
          // re-verify (read 2), a new live holder took over the lock.
          await Bun.write(lockPath, "7777\n");
        }
      }
      return realReadFile(path, encoding);
    };
    Object.assign(_fileLockDeps, { readFile: gatedReadFile });

    await expect(
      withFileLock(lockPath, async () => {}, { ...PATH_LOCK_OPTS, timeoutMs: 150, retryMs: 10 }),
    ).rejects.toThrow(/Timed out acquiring path lock/);

    // The new live holder's lock was never touched by the gravedigger.
    expect((await Bun.file(lockPath).text()).trim()).toBe("7777");
    expect(await Bun.file(claimPath).exists()).toBe(false);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("fails fast on environmental create errors instead of a misleading timeout", async () => {
    const { dir, lockPath } = await makeTempDir();
    Object.assign(_fileLockDeps, {
      writeFile: async () => {
        const err = new Error("spawn of the lock file was denied");
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      },
    });

    const started = _fileLockDeps.now();
    await expect(withFileLock(lockPath, async () => {}, PATH_LOCK_OPTS)).rejects.toThrow(/denied/);
    // Must propagate immediately — not burn the full 5s default timeout.
    expect(_fileLockDeps.now() - started).toBeLessThan(1_000);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("steals an aged claim left by a crashed gravedigger and reclaims the dead lock", async () => {
    const { dir, lockPath } = await makeTempDir();
    const claimPath = `${lockPath}.claim`;
    await Bun.write(lockPath, "424242\n");
    await Bun.write(claimPath, "999999\n");
    const aged = new Date(_fileLockDeps.now() - 20_000);
    await utimes(claimPath, aged, aged);
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid !== 424242 });

    const state = { ran: false };
    await withFileLock(
      lockPath,
      async () => {
        state.ran = true;
      },
      PATH_LOCK_OPTS,
    );

    // The aged claim was stolen, the dead lock reclaimed, and the new
    // claim released after the reclaim.
    expect(state.ran).toBe(true);
    expect(await Bun.file(claimPath).exists()).toBe(false);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("never steals a lock whose holder pid is alive (BUG-10) — times out instead", async () => {
    const { dir, lockPath } = await makeTempDir();
    await Bun.write(lockPath, "7777\n");
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid === 7777 });

    await expect(
      withFileLock(lockPath, async () => {}, { ...PATH_LOCK_OPTS, timeoutMs: 80, retryMs: 10 }),
    ).rejects.toThrow(/Timed out acquiring path lock/);

    expect((await Bun.file(lockPath).text()).trim()).toBe("7777");

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("respects fresh unparseable content (BUG-25) — waits instead of entering", async () => {
    // Empty content means the creator died between the exclusive create and
    // the pid write — but a LIVE creator could still be mid-write, so the
    // waiter fails closed until the file ages past the reclaim bound.
    const { dir, lockPath } = await makeTempDir();
    await Bun.write(lockPath, "");
    Object.assign(_fileLockDeps, { isPidAlive: () => true });

    await expect(
      withFileLock(lockPath, async () => {}, { ...PATH_LOCK_OPTS, timeoutMs: 80, retryMs: 10 }),
    ).rejects.toThrow(/Timed out acquiring path lock/);

    expect(await Bun.file(lockPath).exists()).toBe(true);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("reclaims an aged unparseable lock left by a crashed creator", async () => {
    const { dir, lockPath } = await makeTempDir();
    await Bun.write(lockPath, "");
    const aged = new Date(_fileLockDeps.now() - 20_000);
    await utimes(lockPath, aged, aged);

    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      PATH_LOCK_OPTS,
    );

    expect(ran).toBe(true);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("reclaim never lets two stealers enter — claim blocks the second gravedigger", async () => {
    // Deterministic pin for the steal race: stealer A wins the claim and is
    // gated between its re-verification and its unlink; stealer B must NOT
    // remove the dead lock (its gravedig is blocked by the claim's EEXIST)
    // and must NOT enter while A is reclaiming. Without claim serialization,
    // B's unlink+create could land inside A's verify→unlink window and both
    // would enter.
    const { dir, lockPath } = await makeTempDir();
    const claimPath = `${lockPath}.claim`;
    await Bun.write(lockPath, "424242\n");
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid !== 424242 });

    const realUnlink = _fileLockDeps.unlink;
    let firstUnlinkGated = false;
    let releaseFirstUnlink: () => void = () => {};
    let resumeFirstUnlink: () => void = () => {};
    const firstUnlinkReached = new Promise<void>((resolve) => {
      releaseFirstUnlink = resolve;
    });
    const gatedUnlink = async (path: string) => {
      if (!firstUnlinkGated) {
        firstUnlinkGated = true;
        releaseFirstUnlink();
        await new Promise<void>((resolve) => {
          resumeFirstUnlink = resolve;
        });
      }
      return realUnlink(path);
    };
    Object.assign(_fileLockDeps, { unlink: gatedUnlink });

    let inside = 0;
    let maxInside = 0;
    const enter = () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
    };
    const exit = () => {
      inside--;
    };
    const op = async () => {
      enter();
      await Bun.sleep(5);
      exit();
    };

    const stealerA = withFileLock(lockPath, op, PATH_LOCK_OPTS);
    const stealerB = withFileLock(lockPath, op, PATH_LOCK_OPTS);

    await firstUnlinkReached;

    // While the claim holder is gated mid-reclaim, the dead lock must still
    // be intact (the claim blocked the other stealer's gravedig) and nobody
    // may be inside the critical section.
    expect(await Bun.file(lockPath).exists()).toBe(true);
    expect((await Bun.file(lockPath).text()).trim()).toBe("424242");
    expect(inside).toBe(0);

    resumeFirstUnlink();
    await Promise.all([stealerA, stealerB]);

    expect(maxInside).toBe(1);
    expect(await Bun.file(claimPath).exists()).toBe(false);

    await Bun.$`rm -rf ${dir}`.quiet();
  }, 10_000);

  test("concurrent stealers of the same dead lock yield exactly one holder at a time", async () => {
    const { dir, lockPath } = await makeTempDir();
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid !== 424242 });

    for (let iteration = 0; iteration < 5; iteration++) {
      await Bun.write(lockPath, "424242\n");
      let inside = 0;
      let maxInside = 0;
      const op = async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await Bun.sleep(2);
        inside--;
      };

      const stealers = Array.from({ length: 6 }, () => withFileLock(lockPath, op, PATH_LOCK_OPTS));
      await Promise.all(stealers);

      expect(maxInside).toBe(1);
      // Every stealer acquired and released — nothing holds the lock after
      // the batch, so the release path must have unlinked it.
      expect(await Bun.file(lockPath).exists()).toBe(false);
    }

    await Bun.$`rm -rf ${dir}`.quiet();
  }, 20_000);
});
