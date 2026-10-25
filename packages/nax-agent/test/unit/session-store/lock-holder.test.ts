import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { createSessionStorage, LOCK_STALE_MS, type SessionLockHolder, type SessionLockHolderState } from "#src/index";
import { makeLogger } from "#test/helpers/agent-logger";

const stamp = "2026-10-09T00:00:00.000Z";
const fresh = { pid: 4242, startedAt: stamp, nonce: "original", heartbeatAt: stamp };
let dir: string;
beforeEach(() => {
  dir = makeTempDir("lock-holder-");
});
afterEach(() => cleanupTempDir(dir));

function storage(alive = true, directory = dir) {
  return createSessionStorage({
    dir: directory,
    pid: 1000,
    now: () => new Date(stamp),
    logger: makeLogger(),
    isAlive: (pid) => alive && pid === 4242,
  });
}
const path = () => join(dir, "a.lock");

describe("readLockHolder", () => {
  test("AC-1: missing lock returns null", async () => {
    expect(await storage().readLockHolder("a")).toBeNull();
  });

  test.each([
    ["AC-2: fresh live pid", fresh, true, "live", stamp],
    ["AC-3: dead pid", fresh, false, "stale", stamp],
    ["AC-4: own pid", { ...fresh, pid: 1000 }, false, "own", stamp],
    ["AC-5: legacy live pid", { pid: 4242, startedAt: stamp }, true, "live", null],
    [
      "stale heartbeat with live pid",
      { ...fresh, heartbeatAt: new Date(Date.parse(stamp) - LOCK_STALE_MS - 1).toISOString() },
      true,
      "stale",
      new Date(Date.parse(stamp) - LOCK_STALE_MS - 1).toISOString(),
    ],
    [
      "inclusive freshness boundary",
      { ...fresh, heartbeatAt: new Date(Date.parse(stamp) - LOCK_STALE_MS).toISOString() },
      true,
      "live",
      new Date(Date.parse(stamp) - LOCK_STALE_MS).toISOString(),
    ],
  ] as const)("%s", async (_name, body, alive, state, heartbeatAt) => {
    await writeFile(path(), JSON.stringify(body));
    const expected: SessionLockHolder = { pid: body.pid, startedAt: stamp, heartbeatAt, state };
    expect(await storage(alive).readLockHolder("a")).toEqual(expected);
  });

  test.each([
    ["AC-6: invalid JSON", "not json"],
    ["AC-7: rejected schema", JSON.stringify({ pid: -1 })],
    ["invalid heartbeat", JSON.stringify({ ...fresh, heartbeatAt: "bad" })],
  ])("%s returns null", async (_name, bytes) => {
    await writeFile(path(), bytes);
    expect(await storage().readLockHolder("a")).toBeNull();
  });

  test("AC-8/9: live snapshot leaves bytes and directory unchanged, even with an occupied guard", async () => {
    const bytes = `${JSON.stringify(fresh, null, 2)}\n`;
    await writeFile(path(), bytes);
    await writeFile(join(dir, "a.lock.guard"), "occupied");
    const before = (await readdir(dir)).sort();
    expect((await storage().readLockHolder("a"))?.state).toBe("live");
    expect(await readFile(path(), "utf8")).toBe(bytes);
    expect((await readdir(dir)).sort()).toEqual(before);
  });

  test.each([undefined, "not json", JSON.stringify({ pid: -1 })])(
    "AC-10: missing/invalid lock %s leaves all files unchanged",
    async (bytes) => {
      await writeFile(join(dir, "unrelated"), "keep");
      if (bytes !== undefined) await writeFile(path(), bytes);
      const before = (await readdir(dir)).sort();
      expect(await storage().readLockHolder("a")).toBeNull();
      expect((await readdir(dir)).sort()).toEqual(before);
      expect(await readFile(join(dir, "unrelated"), "utf8")).toBe("keep");
      if (bytes !== undefined) expect(await readFile(path(), "utf8")).toBe(bytes);
    },
  );

  test("missing directory is not created", async () => {
    expect(await storage(true, join(dir, "missing")).readLockHolder("a")).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  test.each([
    ["AC-11: live", fresh, true, "live"],
    ["AC-12: stale", fresh, false, "stale"],
    ["AC-13/14: own", { ...fresh, pid: 1000 }, true, "own"],
    [
      "expired live pid",
      { ...fresh, heartbeatAt: new Date(Date.parse(stamp) - LOCK_STALE_MS - 1).toISOString() },
      true,
      "stale",
    ],
    ["legacy live pid", { pid: 4242, startedAt: stamp }, true, "live"],
  ] as const)("%s agrees with acquireLock", async (_name, body, alive, state: SessionLockHolderState) => {
    await writeFile(path(), JSON.stringify(body));
    const store = storage(alive);
    expect((await store.readLockHolder("a"))?.state).toBe(state);
    if (state === "live") {
      await expect(store.acquireLock("a")).rejects.toMatchObject({ code: "SESSION_LOCKED" });
    } else {
      const release = await store.acquireLock("a");
      try {
        const acquired = JSON.parse(await readFile(path(), "utf8"));
        expect(acquired.pid).toBe(1000);
        expect(acquired.nonce).toEqual(expect.any(String));
        expect(acquired.nonce).not.toBe(fresh.nonce);
      } finally {
        await release();
      }
    }
  });
});
