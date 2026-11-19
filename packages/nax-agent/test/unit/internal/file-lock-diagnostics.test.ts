/**
 * The deadline diagnostics and staged-pid-file rules of the shared single-file
 * lock (`withFileLock`), split out of `file-lock.test.ts` by concern.
 *
 * Pins:
 * - #2980: a deadline caused by a reclamation claim a dead process left rejects
 *   with `FILE_LOCK_CLAIM_ORPHANED`, naming the claim, the dead pid and the
 *   manual recovery. The claim is still never removed automatically, and every
 *   other cause of a deadline keeps its `FILE_LOCK_TIMEOUT`.
 * - #2985: a staged pid file swept between its write and its link makes `link`
 *   fail with ENOENT; the acquisition re-stages once and links again.
 * - #2985: the sweep only removes staged pid files older than
 *   `STAGED_PID_SWEEP_AGE_MS`, so a creator whose pid means nothing locally
 *   survives it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdir, utimes } from "node:fs/promises";
import { NaxError } from "#src/infra/index";
import { _fileLockDeps, withFileLock } from "#src/internal/file-lock";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const PATH_LOCK_OPTS = { lockName: "path", errorPrefix: "[path-lock]" } as const;
/** A wait long enough to reach the deadline twice, short enough to be instant. */
const SHORT_WAIT = { ...PATH_LOCK_OPTS, timeoutMs: 60, retryMs: 5 } as const;
const DEAD_HOLDER_PID = 424242;
const DEAD_CLAIM_PID = 999999;
const LIVE_PID = 7777;
/** `STAGED_PID_SWEEP_AGE_MS`, restated because the constant stays module-private. */
const SWEEP_AGE_MS = 10_000;
const STAGED_PID_TAIL = "-00000000-0000-4000-8000-000000000000.pid";

interface LockFixture {
  readonly dir: string;
  readonly lockPath: string;
  readonly claimPath: string;
}

let orig: typeof _fileLockDeps;
const createdDirs: string[] = [];

beforeEach(() => {
  orig = { ..._fileLockDeps };
});

afterEach(() => {
  Object.assign(_fileLockDeps, orig);
  for (const dir of createdDirs.splice(0)) cleanupTempDir(dir);
  mock.restore();
});

/** A lock directory under `$TMPDIR`, as `file-lock.test.ts` does (a literal `/tmp` escapes a session's writes). */
function makeLockDir(): LockFixture {
  const dir = makeTempDir("nax-file-lock-diagnostics-test-");
  createdDirs.push(dir);
  const lockPath = `${dir}/metrics.json.lock`;
  return { dir, lockPath, claimPath: `${lockPath}.claim` };
}

/** The staged pid file a creator leaves behind: `.lock-<pid>-<uuid>.pid`. */
function stagedPath(dir: string, pid: number): string {
  return `${dir}/.lock-${pid}${STAGED_PID_TAIL}`;
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** An abandoned lock plus the claim a dead process left: #2980's case. */
async function orphanedClaimFixture(alive: (pid: number) => boolean = () => false): Promise<LockFixture> {
  const fixture = makeLockDir();
  await Bun.write(fixture.lockPath, `${DEAD_HOLDER_PID}\n`);
  await Bun.write(fixture.claimPath, `${DEAD_CLAIM_PID}\n`);
  Object.assign(_fileLockDeps, { isPidAlive: alive });
  return fixture;
}

/** Run the acquisition to its deadline and return its rejection, asserting it is a `NaxError`. */
async function deadlineRejection(
  fixture: LockFixture,
  operation: () => Promise<unknown> = async () => {},
): Promise<NaxError> {
  const rejection = await withFileLock(fixture.lockPath, operation, SHORT_WAIT).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(rejection instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(rejection)}`);
  return rejection;
}

describe("withFileLock — orphaned reclamation claim (#2980)", () => {
  test("rejects with FILE_LOCK_CLAIM_ORPHANED when a dead process's claim blocks the lock", async () => {
    const fixture = await orphanedClaimFixture();

    const error = await deadlineRejection(fixture);

    expect(error.code).toBe("FILE_LOCK_CLAIM_ORPHANED");
  });

  test("names the lock, the claim and the claim's dead pid in the error context", async () => {
    const fixture = await orphanedClaimFixture();

    const error = await deadlineRejection(fixture);

    expect(error.context).toEqual({
      stage: "file-lock",
      lockName: "path",
      lockPath: fixture.lockPath,
      claimPath: `${fixture.lockPath}.claim`,
      claimPid: DEAD_CLAIM_PID,
    });
  });

  test("tells the operator to stop every lock user before removing the claim", async () => {
    const fixture = await orphanedClaimFixture();

    const { message } = await deadlineRejection(fixture);

    expect(message).toContain(fixture.claimPath);
    expect(message).toContain(`${DEAD_CLAIM_PID}`);
    expect(message).toContain("Retrying cannot clear it.");
    expect(message).toContain(`Stop every process that uses ${fixture.lockPath}, then remove ${fixture.claimPath}.`);
  });

  test("leaves the claim and the abandoned lock byte-identical", async () => {
    const fixture = await orphanedClaimFixture();

    await deadlineRejection(
      fixture,
      mock(async () => {}),
    );

    expect(await Bun.file(fixture.claimPath).text()).toBe(`${DEAD_CLAIM_PID}\n`);
    expect(await Bun.file(fixture.lockPath).text()).toBe(`${DEAD_HOLDER_PID}\n`);
  });

  test("never runs the operation behind an orphaned claim", async () => {
    const fixture = await orphanedClaimFixture();
    const operation = mock(async () => {});

    await deadlineRejection(fixture, operation);

    expect(operation).not.toHaveBeenCalled();
  });

  test("keeps FILE_LOCK_TIMEOUT when the claim's pid is alive", async () => {
    const fixture = await orphanedClaimFixture((pid) => pid === DEAD_CLAIM_PID);

    const error = await deadlineRejection(fixture);

    expect(error.code).toBe("FILE_LOCK_TIMEOUT");
  });

  test("keeps FILE_LOCK_TIMEOUT when a live holder is what blocks the lock", async () => {
    const fixture = makeLockDir();
    await Bun.write(fixture.lockPath, `${LIVE_PID}\n`);
    await Bun.write(fixture.claimPath, `${DEAD_CLAIM_PID}\n`);
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid === LIVE_PID });

    const error = await deadlineRejection(fixture);

    expect(error.code).toBe("FILE_LOCK_TIMEOUT");
  });

  test("keeps FILE_LOCK_TIMEOUT when the claim file is empty", async () => {
    const fixture = makeLockDir();
    await Bun.write(fixture.lockPath, `${DEAD_HOLDER_PID}\n`);
    await Bun.write(fixture.claimPath, "");
    Object.assign(_fileLockDeps, { isPidAlive: () => false });

    const error = await deadlineRejection(fixture);

    expect(error.code).toBe("FILE_LOCK_TIMEOUT");
  });

  test("keeps FILE_LOCK_TIMEOUT when the claim read fails at the deadline", async () => {
    const fixture = await orphanedClaimFixture();
    // The reclaim path reads the claim on every iteration, so the read may only
    // start failing once the deadline has passed — that is the read the
    // diagnosis performs, and its failure must not replace the timeout.
    const { now, failReads, sleep } = stubReadsFailingAfterDeadline(fixture.claimPath, "claim read refused");
    Object.assign(_fileLockDeps, { now, sleep });

    const error = await deadlineRejection(fixture);

    expect(failReads()).toBe(true);
    expect(error.code).toBe("FILE_LOCK_TIMEOUT");
    expect(error.message).not.toContain("claim read refused");
  });

  test("keeps FILE_LOCK_TIMEOUT when the lock read fails at the deadline", async () => {
    const fixture = await orphanedClaimFixture();
    const { now, failReads, sleep } = stubReadsFailingAfterDeadline(fixture.lockPath, "lock read refused");
    Object.assign(_fileLockDeps, { now, sleep });

    const error = await deadlineRejection(fixture);

    expect(failReads()).toBe(true);
    expect(error.code).toBe("FILE_LOCK_TIMEOUT");
    expect(error.message).not.toContain("lock read refused");
  });
});

/**
 * Make reads of `path` fail from the first `sleep` on, which is the iteration
 * that crosses the deadline. The virtual clock advances past `SHORT_WAIT`'s
 * deadline at the same moment, so the failing read is only ever the diagnosis's.
 */
function stubReadsFailingAfterDeadline(path: string, message: string) {
  const realOpen = _fileLockDeps.open;
  let now = _fileLockDeps.now();
  let failing = false;
  _fileLockDeps.open = async (openPath, ...args) => {
    if (failing && openPath === path) throw errnoError("EACCES", message);
    return realOpen(openPath, ...args);
  };
  return {
    now: () => now,
    sleep: async () => {
      now += 1_000;
      failing = true;
    },
    failReads: () => failing,
  };
}

describe("withFileLock — a staged pid file is re-staged on link ENOENT (#2985)", () => {
  test("links a second staged pid file when the first vanished before its link", async () => {
    const fixture = makeLockDir();
    stubLinkEnopentOnce(fixture.lockPath);

    let holder: string | undefined;
    await withFileLock(
      fixture.lockPath,
      async () => {
        holder = await Bun.file(fixture.lockPath).text();
      },
      PATH_LOCK_OPTS,
    );

    expect(holder).toBe(`${process.pid}\n`);
  });

  test("writes the retry to a fresh staged path", async () => {
    const fixture = makeLockDir();
    const staged = recordStagedWrites();
    stubLinkEnopentOnce(fixture.lockPath);

    await withFileLock(fixture.lockPath, async () => {}, PATH_LOCK_OPTS);

    expect(staged()).toHaveLength(2);
    expect(new Set(staged()).size).toBe(2);
  });

  test("removes both staged pid files by the time the acquisition returns", async () => {
    const fixture = makeLockDir();
    const staged = recordStagedWrites();
    stubLinkEnopentOnce(fixture.lockPath);

    await withFileLock(fixture.lockPath, async () => {}, PATH_LOCK_OPTS);

    for (const path of staged()) expect(await Bun.file(path).exists()).toBe(false);
    expect(await readdir(fixture.dir)).toEqual([]);
  });

  test("throws the second ENOENT when the retry's link fails the same way", async () => {
    const fixture = makeLockDir();
    const first = errnoError("ENOENT", "first staged pid file vanished");
    const second = errnoError("ENOENT", "second staged pid file vanished");
    const realLink = _fileLockDeps.link;
    let attempts = 0;
    _fileLockDeps.link = async (from, to) => {
      if (to !== fixture.lockPath) return realLink(from, to);
      throw ++attempts === 1 ? first : second;
    };

    const rejection = await withFileLock(fixture.lockPath, async () => {}, PATH_LOCK_OPTS).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBe(second);
    expect(attempts).toBe(2);
  });

  test("never runs the operation when both link attempts fail with ENOENT", async () => {
    const fixture = makeLockDir();
    const realLink = _fileLockDeps.link;
    _fileLockDeps.link = async (from, to) => {
      if (to !== fixture.lockPath) return realLink(from, to);
      throw errnoError("ENOENT", "staged pid file vanished");
    };
    const operation = mock(async () => {});

    await withFileLock(fixture.lockPath, operation, PATH_LOCK_OPTS).catch(() => {});

    expect(operation).not.toHaveBeenCalled();
  });
});

/** Fail the first `link` of `from`→`lockPath` with ENOENT; every later link is real. */
function stubLinkEnopentOnce(lockPath: string): void {
  const realLink = _fileLockDeps.link;
  let attempts = 0;
  _fileLockDeps.link = async (from, to) => {
    if (to === lockPath && ++attempts === 1) throw errnoError("ENOENT", "staged pid file vanished");
    return realLink(from, to);
  };
}

/** Record every staged pid path written, in order. */
function recordStagedWrites(): () => string[] {
  const staged: string[] = [];
  const realWriteFile = _fileLockDeps.writeFile;
  Object.assign(_fileLockDeps, {
    writeFile: async (path: string, data: string, options?: { flag?: string }) => {
      if (path.endsWith(".pid")) staged.push(path);
      return realWriteFile(path, data, options);
    },
  });
  return () => staged;
}

describe("withFileLock — the staged pid sweep honours its age bound (#2985)", () => {
  test("keeps a staged pid file younger than the sweep age", async () => {
    const fixture = makeLockDir();
    const staged = stagedPath(fixture.dir, DEAD_HOLDER_PID);
    await Bun.write(staged, `${DEAD_HOLDER_PID}\n`);
    Object.assign(_fileLockDeps, { isPidAlive: () => false });

    await withFileLock(fixture.lockPath, async () => {}, PATH_LOCK_OPTS);

    expect(await Bun.file(staged).exists()).toBe(true);
  });

  test("removes a staged pid file older than the sweep age", async () => {
    const fixture = makeLockDir();
    const staged = stagedPath(fixture.dir, DEAD_HOLDER_PID);
    await Bun.write(staged, `${DEAD_HOLDER_PID}\n`);
    const aged = new Date(_fileLockDeps.now() - SWEEP_AGE_MS - 1_000);
    await utimes(staged, aged, aged);
    Object.assign(_fileLockDeps, { isPidAlive: () => false });

    await withFileLock(fixture.lockPath, async () => {}, PATH_LOCK_OPTS);

    expect(await Bun.file(staged).exists()).toBe(false);
  });

  test("still acquires the lock when the sweep's stat fails", async () => {
    const { fixture } = await stagedFileWithFailingStat();

    let ran = false;
    await withFileLock(
      fixture.lockPath,
      async () => {
        ran = true;
      },
      PATH_LOCK_OPTS,
    );

    expect(ran).toBe(true);
  });

  test("leaves a staged pid file in place when the sweep's stat fails", async () => {
    const { fixture, staged } = await stagedFileWithFailingStat();

    await withFileLock(fixture.lockPath, async () => {}, PATH_LOCK_OPTS);

    expect(await Bun.file(staged).exists()).toBe(true);
  });
});

/** A staged pid file from a dead pid, with the sweep's age read refusing. */
async function stagedFileWithFailingStat(): Promise<{ fixture: LockFixture; staged: string }> {
  const fixture = makeLockDir();
  const staged = stagedPath(fixture.dir, DEAD_HOLDER_PID);
  await Bun.write(staged, `${DEAD_HOLDER_PID}\n`);
  Object.assign(_fileLockDeps, {
    isPidAlive: () => false,
    stat: async (): Promise<never> => {
      throw errnoError("EACCES", "stat refused");
    },
  });
  return { fixture, staged };
}
