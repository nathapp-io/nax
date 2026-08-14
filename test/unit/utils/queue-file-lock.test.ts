import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _queueLockDeps, listLiveCandidates } from "../../../src/utils/queue-file-lock";

const QUEUE_PATH = "/tmp/nax-queue-lock-test/queue.txt";
const NOW = 2_000_000_000;

let orig: typeof _queueLockDeps;

beforeEach(() => {
  orig = { ..._queueLockDeps };
});

afterEach(() => {
  Object.assign(_queueLockDeps, orig);
  mock.restore();
});

describe("listLiveCandidates — stale-lock eviction (BUG-10)", () => {
  test("does not unlink a lock whose holder pid is alive, no matter how old", async () => {
    const oldAliveName = "queue.txt.lock.0001000000000.9999.aaa"; // ~1.9M seconds old at NOW
    const unlinked: string[] = [];

    Object.assign(_queueLockDeps, {
      now: () => NOW,
      readdir: mock(async () => [oldAliveName]) as unknown as typeof _queueLockDeps.readdir, // test-ratchet-allow: as-unknown-as
      stat: mock(async () => ({ birthtimeMs: 1_000_000_000 }) as Awaited<ReturnType<typeof _queueLockDeps.stat>>),
      unlink: mock(async (path: string) => {
        unlinked.push(path);
      }) as typeof _queueLockDeps.unlink,
      isPidAlive: (pid: number) => pid === 9999,
    });

    const live = await listLiveCandidates(QUEUE_PATH);

    expect(live).toEqual([oldAliveName]);
    expect(unlinked).toEqual([]);
  });

  test("unlinks a lock whose holder pid is no longer alive", async () => {
    const deadPidName = "queue.txt.lock.0001700000000.8888.bbb";
    const unlinked: string[] = [];

    Object.assign(_queueLockDeps, {
      now: () => NOW,
      readdir: mock(async () => [deadPidName]) as unknown as typeof _queueLockDeps.readdir, // test-ratchet-allow: as-unknown-as
      stat: mock(async () => ({ birthtimeMs: NOW }) as Awaited<ReturnType<typeof _queueLockDeps.stat>>),
      unlink: mock(async (path: string) => {
        unlinked.push(path);
      }) as typeof _queueLockDeps.unlink,
      isPidAlive: () => false,
    });

    const live = await listLiveCandidates(QUEUE_PATH);

    expect(live).toEqual([]);
    expect(unlinked.some((p) => p.endsWith(deadPidName))).toBe(true);
  });

  test("unlinks a candidate with an unparseable timestamp even if its pid is alive", async () => {
    const unparseableName = "queue.txt.lock.notanumber.7777.ccc";
    const unlinked: string[] = [];

    Object.assign(_queueLockDeps, {
      now: () => NOW,
      readdir: mock(async () => [unparseableName]) as unknown as typeof _queueLockDeps.readdir, // test-ratchet-allow: as-unknown-as
      stat: mock(async () => ({ birthtimeMs: NOW }) as Awaited<ReturnType<typeof _queueLockDeps.stat>>),
      unlink: mock(async (path: string) => {
        unlinked.push(path);
      }) as typeof _queueLockDeps.unlink,
      isPidAlive: (pid: number) => pid === 7777, // alive, but timestamp is unparseable
    });

    const live = await listLiveCandidates(QUEUE_PATH);

    expect(live).toEqual([]);
    expect(unlinked.some((p) => p.endsWith(unparseableName))).toBe(true);
  });

  test("mixed set: keeps the alive old lock, evicts the dead one, sorted oldest-first", async () => {
    const oldAliveName = "queue.txt.lock.0001000000000.9999.aaa";
    const newAliveName = "queue.txt.lock.0001500000000.6666.ddd";
    const deadPidName = "queue.txt.lock.0001700000000.8888.bbb";
    const unlinked: string[] = [];

    Object.assign(_queueLockDeps, {
      now: () => NOW,
      readdir: mock(async () => [deadPidName, newAliveName, oldAliveName]) as unknown as typeof _queueLockDeps.readdir, // test-ratchet-allow: as-unknown-as
      stat: mock(async (path: string) => {
        if (path.endsWith(oldAliveName))
          return { birthtimeMs: 1_000_000_000 } as Awaited<ReturnType<typeof _queueLockDeps.stat>>;
        return { birthtimeMs: 1_500_000_000 } as Awaited<ReturnType<typeof _queueLockDeps.stat>>;
      }) as typeof _queueLockDeps.stat,
      unlink: mock(async (path: string) => {
        unlinked.push(path);
      }) as typeof _queueLockDeps.unlink,
      isPidAlive: (pid: number) => pid === 9999 || pid === 6666,
    });

    const live = await listLiveCandidates(QUEUE_PATH);

    expect(live).toEqual([oldAliveName, newAliveName]);
    expect(unlinked.some((p) => p.endsWith(deadPidName))).toBe(true);
    expect(unlinked.some((p) => p.endsWith(oldAliveName))).toBe(false);
    expect(unlinked.some((p) => p.endsWith(newAliveName))).toBe(false);
  });
});
