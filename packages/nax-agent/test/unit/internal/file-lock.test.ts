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
 * - BUG-25: an empty lock is respected until it ages out.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { lstat, open as openFile, readdir, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { _fileLockDeps, withFileLock } from "#src/internal/file-lock";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const PATH_LOCK_OPTS = { lockName: "path", errorPrefix: "[path-lock]" } as const;

let orig: typeof _fileLockDeps;

beforeEach(() => {
  orig = { ..._fileLockDeps };
});

afterEach(() => {
  Object.assign(_fileLockDeps, orig);
  mock.restore();
});

/**
 * A lock directory under `$TMPDIR` (nax#2523): a literal `/tmp/...` path is
 * outside the write roots a confined agent session gets, so the suite failed
 * there while passing on the host.
 */
function makeLockDir(): { dir: string; target: string; lockPath: string } {
  const dir = makeTempDir("nax-file-lock-test-");
  return { dir, target: `${dir}/metrics.json`, lockPath: `${dir}/metrics.json.lock` };
}

describe("withFileLock — mutual exclusion", () => {
  test("acquires a valid long lock basename without leaving a staging file", async () => {
    const dir = makeTempDir("nax-file-lock-test-");
    const lockPath = join(dir, `${"x".repeat(230)}.lock`);
    try {
      await withFileLock(
        lockPath,
        async () => {
          expect(await Bun.file(lockPath).text()).toBe(`${process.pid}\n`);
        },
        PATH_LOCK_OPTS,
      );
      expect(await readdir(dir)).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("serializes 8 concurrent read-modify-write writers (no lost update, BUG-6)", async () => {
    const { dir, target, lockPath } = makeLockDir();
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

    cleanupTempDir(dir);
  }, 20_000);

  test("#1731: a create attempt landing while the holder is inside waits its turn", async () => {
    // Deterministic regression for #1731: gate the SECOND exclusive-create
    // until writer A is already inside the critical section. The previous
    // design let the late candidate win the "oldest" ordering and enter
    // concurrently; the exclusive-create design must make B wait.
    const { dir, lockPath } = makeLockDir();

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

    cleanupTempDir(dir);
  }, 10_000);
});

describe("withFileLock — cancellation", () => {
  test("releases a lock acquired just as the caller aborts, without running the operation", async () => {
    const { dir, lockPath } = makeLockDir();
    const controller = new AbortController();
    const reason = new Error("cancelled during exclusive create");
    const operation = mock(async () => "ran");
    const writeFile = _fileLockDeps.writeFile;
    _fileLockDeps.writeFile = async (...args) => {
      await writeFile(...args);
      controller.abort(reason);
    };

    try {
      const first = withFileLock(lockPath, operation, { ...PATH_LOCK_OPTS, signal: controller.signal });
      await expect(first).rejects.toBe(reason);
      expect(operation).not.toHaveBeenCalled();
      expect(await Bun.file(lockPath).exists()).toBe(false);

      expect(await withFileLock(lockPath, operation, { ...PATH_LOCK_OPTS, timeoutMs: 100 })).toBe("ran");
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

const mkfifo = Bun.which("mkfifo");

describe("withFileLock — invalid lock paths", () => {
  test.skipIf(mkfifo === null)("refuses a FIFO without waiting for a writer or reclaiming it", async () => {
    const { dir, lockPath } = makeLockDir();
    try {
      expect(Bun.spawnSync([mkfifo ?? "mkfifo", lockPath]).exitCode).toBe(0);
      const aged = new Date(Date.now() - 20_000);
      await utimes(lockPath, aged, aged);

      // Isolate the call so a blocking FIFO read cannot hang the test runner on regression.
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `
          import { withFileLock } from "#src/internal/file-lock";
          try {
            await withFileLock(process.argv[1], async () => {}, {
              lockName: "path", errorPrefix: "[path-lock]", timeoutMs: 100,
            });
            throw new Error("acquired the FIFO lock");
          } catch (error) {
            if (error.code !== "FILE_LOCK_INVALID") throw error;
          }
          `,
          lockPath,
        ],
        timeout: 2_000,
        killSignal: "SIGKILL",
      });
      expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
      expect((await lstat(lockPath)).isFIFO()).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test.each([".lock", ".lock.claim"])("does not reclaim a symlink at %s", async (suffix) => {
    const { dir, target, lockPath } = makeLockDir();
    const linkedPath = `${target}${suffix}`;
    try {
      if (linkedPath !== lockPath) await Bun.write(lockPath, "424242\n");
      await Bun.write(target, "424242\n");
      const aged = new Date(Date.now() - 20_000);
      await utimes(target, aged, aged);
      await symlink(target, linkedPath);
      _fileLockDeps.isPidAlive = () => false;
      const operation = mock(async () => {});

      const pending = withFileLock(lockPath, operation, PATH_LOCK_OPTS);
      await expect(pending).rejects.toMatchObject({ code: "FILE_LOCK_INVALID" });
      expect(operation).not.toHaveBeenCalled();
      expect((await lstat(linkedPath)).isSymbolicLink()).toBe(true);
      expect(await Bun.file(target).text()).toBe("424242\n");
    } finally {
      cleanupTempDir(dir);
    }
  });

  test.each([
    { kind: "oversized", content: `424242\n${" ".repeat(256)}` },
    { kind: "non-numeric", content: "424242junk" },
    { kind: "out-of-range", content: "2147483648\n" },
  ])("refuses $kind PID metadata even if it starts with a dead PID", async ({ content }) => {
    const { dir, lockPath } = makeLockDir();
    try {
      await Bun.write(lockPath, content);
      _fileLockDeps.isPidAlive = () => false;
      const operation = mock(async () => {});

      await expect(withFileLock(lockPath, operation, PATH_LOCK_OPTS)).rejects.toMatchObject({
        code: "FILE_LOCK_INVALID",
      });
      expect(operation).not.toHaveBeenCalled();
      expect(await Bun.file(lockPath).text()).toBe(content);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("withFileLock — stale lock handling (BUG-10 / BUG-25)", () => {
  test("reclaims a lock whose holder pid is proven dead", async () => {
    const { dir, lockPath } = makeLockDir();
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

    cleanupTempDir(dir);
  });

  test("gravedigger declines to unlink when its stale observation was replaced by a live holder", async () => {
    // The heart of the claim protocol: a waiter observes a dead holder,
    // wins the claim, but the lock file was replaced by a NEW live holder
    // before the re-verify read. The re-verify must see pid !== observedPid
    // and decline — otherwise the gravedigger would delete a live lock.
    const { dir, lockPath } = makeLockDir();
    const claimPath = `${lockPath}.claim`;
    await Bun.write(lockPath, "424242\n");
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid !== 424242 });

    const open = _fileLockDeps.open;
    let lockReads = 0;
    _fileLockDeps.open = async (path, ...args) => {
      if (path === lockPath && ++lockReads === 2) {
        // Between our observation (read 1) and the claim-holder's
        // re-verify (read 2), a new live holder took over the lock.
        await Bun.write(lockPath, "7777\n");
      }
      return open(path, ...args);
    };

    const timedOut = withFileLock(lockPath, async () => {}, { ...PATH_LOCK_OPTS, timeoutMs: 150, retryMs: 10 });
    await expect(timedOut).rejects.toThrow(/Timed out acquiring path lock/);
    await expect(timedOut).rejects.toMatchObject({
      code: "FILE_LOCK_TIMEOUT",
      context: { stage: "file-lock" },
    });

    // The new live holder's lock was never touched by the gravedigger.
    expect((await Bun.file(lockPath).text()).trim()).toBe("7777");
    expect(await Bun.file(claimPath).exists()).toBe(false);

    cleanupTempDir(dir);
  });

  test("fails fast on environmental create errors instead of a misleading timeout", async () => {
    const { dir, lockPath } = makeLockDir();
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

    cleanupTempDir(dir);
  });

  test("a staged pid write that creates its file and then fails leaves nothing behind", async () => {
    const { dir, lockPath } = makeLockDir();
    const realWriteFile = _fileLockDeps.writeFile;
    Object.assign(_fileLockDeps, {
      writeFile: async (path: string, _data: string, options?: { flag?: string }) => {
        await realWriteFile(path, "", options);
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      },
    });
    try {
      await expect(withFileLock(lockPath, async () => {}, PATH_LOCK_OPTS)).rejects.toThrow(/no space left/);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("an acquisition removes staged pid files a dead process left, never a live one's", async () => {
    // A process that dies between staging and cleanup leaves `.lock-<pid>-<uuid>.pid` beside the
    // guarded files, where an auto-commit's `git add -A` could pick it up.
    const { dir, lockPath } = makeLockDir();
    const dead = `${dir}/.lock-424242-00000000-0000-4000-8000-000000000000.pid`;
    const live = `${dir}/.lock-7777-00000000-0000-4000-8000-000000000001.pid`;
    await Bun.write(dead, "424242\n");
    await Bun.write(live, "7777\n");
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid !== 424242 });
    try {
      await withFileLock(lockPath, async () => {}, PATH_LOCK_OPTS);
      expect(await Bun.file(dead).exists()).toBe(false);
      expect(await Bun.file(live).exists()).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("two contending waiters leave an aged claim and its abandoned lock intact", async () => {
    const { dir, lockPath } = makeLockDir();
    const claimPath = `${lockPath}.claim`;
    await Bun.write(lockPath, "424242\n");
    await Bun.write(claimPath, "999999\n");
    let now = _fileLockDeps.now();
    const aged = new Date(now - 20_000);
    await utimes(claimPath, aged, aged);
    const attempted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let retries = 0;
    const operation = mock(async () => {});
    Object.assign(_fileLockDeps, {
      now: () => now,
      isPidAlive: () => false,
      sleep: async () => {
        if (++retries === 2) attempted.resolve();
        await resume.promise;
      },
    });
    const waiters = Promise.allSettled([
      withFileLock(lockPath, operation, PATH_LOCK_OPTS),
      withFileLock(lockPath, operation, PATH_LOCK_OPTS),
    ]);
    try {
      await Promise.race([attempted.promise, waiters]);
      now += 5_001;
      resume.resolve();
      for (const waiter of await waiters) {
        expect(waiter.status).toBe("rejected");
        if (waiter.status === "rejected") expect(waiter.reason).toMatchObject({ code: "FILE_LOCK_TIMEOUT" });
      }
      expect(operation).not.toHaveBeenCalled();
      expect(await Bun.file(lockPath).text()).toBe("424242\n");
      expect(await Bun.file(claimPath).text()).toBe("999999\n");
    } finally {
      resume.resolve();
      await waiters;
      cleanupTempDir(dir);
    }
  });

  test("never steals a lock whose holder pid is alive (BUG-10) — times out instead", async () => {
    const { dir, lockPath } = makeLockDir();
    await Bun.write(lockPath, "7777\n");
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid === 7777 });

    await expect(
      withFileLock(lockPath, async () => {}, { ...PATH_LOCK_OPTS, timeoutMs: 80, retryMs: 10 }),
    ).rejects.toThrow(/Timed out acquiring path lock/);

    expect((await Bun.file(lockPath).text()).trim()).toBe("7777");

    cleanupTempDir(dir);
  });

  test("respects fresh unparseable content (BUG-25) — waits instead of entering", async () => {
    // Empty content means the creator died between the exclusive create and
    // the pid write — but a LIVE creator could still be mid-write, so the
    // waiter fails closed until the file ages past the reclaim bound.
    const { dir, lockPath } = makeLockDir();
    await Bun.write(lockPath, "");
    Object.assign(_fileLockDeps, { isPidAlive: () => true });

    await expect(
      withFileLock(lockPath, async () => {}, { ...PATH_LOCK_OPTS, timeoutMs: 80, retryMs: 10 }),
    ).rejects.toThrow(/Timed out acquiring path lock/);

    expect(await Bun.file(lockPath).exists()).toBe(true);

    cleanupTempDir(dir);
  });

  test("reclaims an aged unparseable lock left by a crashed creator", async () => {
    const { dir, lockPath } = makeLockDir();
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

    cleanupTempDir(dir);
  });

  test("a creator paused before its pid write is never evicted by a waiter", async () => {
    // The create and the pid write are two steps. If the lock path existed between them, a creator
    // paused past EMPTY_LOCK_EVICT_AGE_MS would look crashed: a waiter would evict it and enter,
    // and the creator would resume believing it held the lock.
    const { dir, lockPath } = makeLockDir();
    const realWriteFile = _fileLockDeps.writeFile;
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let firstCreate = true;
    Object.assign(_fileLockDeps, {
      writeFile: async (path: string, data: string, options?: { flag?: string }) => {
        if (!firstCreate) return realWriteFile(path, data, options);
        firstCreate = false;
        const handle = await openFile(path, "wx");
        const aged = new Date(Date.now() - 20_000);
        await utimes(path, aged, aged);
        paused.resolve();
        await resume.promise;
        await handle.writeFile(data);
        await handle.close();
      },
    });
    let inside = 0;
    let maxInside = 0;
    let bInside = false;
    const aEntered = Promise.withResolvers<void>();
    const aRetried = Promise.withResolvers<void>();
    const sleep = _fileLockDeps.sleep;
    _fileLockDeps.sleep = (ms, signal) => {
      if (bInside) aRetried.resolve();
      return sleep(ms, signal);
    };
    const enter = () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
    };
    try {
      const creatorA = withFileLock(
        lockPath,
        async () => {
          enter();
          aEntered.resolve();
          inside--;
        },
        PATH_LOCK_OPTS,
      );
      await paused.promise;
      const waiterB = withFileLock(
        lockPath,
        async () => {
          enter();
          bInside = true;
          resume.resolve();
          await Promise.race([aEntered.promise, aRetried.promise]);
          bInside = false;
          inside--;
        },
        PATH_LOCK_OPTS,
      );
      await Promise.all([creatorA, waiterB]);
      expect(maxInside).toBe(1);
      expect(await Bun.file(lockPath).exists()).toBe(false);
      // Each creator removes its staged pid file whether or not its link won.
      expect(await readdir(dir)).toEqual([]);
    } finally {
      resume.resolve();
      cleanupTempDir(dir);
    }
  }, 10_000);

  test("reclaim never lets two stealers enter — claim blocks the second gravedigger", async () => {
    // Deterministic pin for the steal race: stealer A wins the claim and is
    // gated between its re-verification and its unlink; stealer B must NOT
    // remove the dead lock (its gravedig is blocked by the claim's EEXIST)
    // and must NOT enter while A is reclaiming. Without claim serialization,
    // B's unlink+create could land inside A's verify→unlink window and both
    // would enter.
    const { dir, lockPath } = makeLockDir();
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
    // Gate the gravedigger's unlink of the lock itself; staged pid files are unlinked too.
    const gatedUnlink = async (path: string) => {
      if (!firstUnlinkGated && path === lockPath) {
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

    cleanupTempDir(dir);
  }, 10_000);

  test("concurrent stealers of the same dead lock yield exactly one holder at a time", async () => {
    const { dir, lockPath } = makeLockDir();
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

    cleanupTempDir(dir);
  }, 20_000);
});
