import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _lockDeps } from "#src/server/session-lock";
import { createSessionStorage, LOCK_HEARTBEAT_MS, LOCK_STALE_MS, type StorageDeps } from "#src/server/storage";
import { recordingLogger } from "#test/helpers/recording-logger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});
function setup() {
  const dir = makeTempDir("lock-hardening-");
  dirs.push(dir);
  let now = Date.parse("2026-10-09T00:00:00Z");
  let tick: () => void | Promise<void> = () => {};
  let interval = 0;
  const deps: StorageDeps = {
    dir,
    pid: 1000,
    now: () => new Date(now),
    isAlive: () => true,
    logger: recordingLogger().logger,
    setInterval: (fn, ms) => {
      tick = fn;
      interval = ms;
      return setInterval(() => {}, 2 ** 30);
    },
  };
  const path = join(dir, "a.lock");
  return {
    deps,
    path,
    store: createSessionStorage(deps),
    read: async () => JSON.parse(await readFile(path, "utf8")),
    advance: async () => {
      now += 30_000;
      await tick();
    },
    interval: () => interval,
  };
}

test("unique nonces, atomic heartbeat, owned release and loss of ownership", async () => {
  const s = setup();
  const release = await s.store.acquireLock("a");
  const first = await s.read();
  expect(first.nonce).toEqual(expect.any(String));
  expect(s.interval()).toBe(LOCK_HEARTBEAT_MS);
  await s.advance();
  expect((await s.read()).heartbeatAt).not.toBe(first.heartbeatAt);
  const otherRelease = await s.store.acquireLock("b");
  const other = JSON.parse(await readFile(join(s.deps.dir, "b.lock"), "utf8"));
  expect(other.nonce).not.toBe(first.nonce);
  await writeFile(s.path, JSON.stringify({ ...first, nonce: "replacement" }));
  await release();
  expect((await s.read()).nonce).toBe("replacement");
  await otherRelease();
  await expect(readFile(join(s.deps.dir, "b.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["stale", "fresh", "own"])("handles %s live lock", async (kind) => {
  const s = setup();
  const now = s.deps.now().getTime();
  await writeFile(
    s.path,
    JSON.stringify({
      pid: kind === "own" ? 1000 : 2000,
      startedAt: "x",
      nonce: "old",
      heartbeatAt: new Date(now - (kind === "stale" ? LOCK_STALE_MS + 1 : 0)).toISOString(),
    }),
  );
  if (kind === "fresh") await expect(s.store.acquireLock("a")).rejects.toThrow("session in use");
  else {
    const release = await s.store.acquireLock("a");
    expect((await s.read()).nonce).not.toBe("old");
    await release();
  }
});

test("distinct process identities racing a stale lock have one winner and one rejection", async () => {
  const s = setup();
  await writeFile(
    s.path,
    JSON.stringify({ pid: 3000, startedAt: "x", nonce: "old", heartbeatAt: "2000-01-01T00:00:00Z" }),
  );
  const second = createSessionStorage({ ...s.deps, pid: 2000 });
  const results = await Promise.allSettled([s.store.acquireLock("a"), second.acquireLock("a")]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  for (const r of results) if (r.status === "fulfilled") await r.value();
});

test("heartbeat never recreates a missing lock", async () => {
  const s = setup();
  const release = await s.store.acquireLock("a");
  await rm(s.path);
  await s.advance();
  await expect(readFile(s.path)).rejects.toMatchObject({ code: "ENOENT" });
  await release();
});

test.each(["restore", "newer", "lost-rename"])("takeover protects a raced holder: %s", async (kind) => {
  const s = setup();
  const old = { pid: 3000, startedAt: "x", nonce: "old", heartbeatAt: "2000-01-01T00:00:00.000Z" };
  const winner = { ...old, pid: 2000, nonce: "winner", heartbeatAt: s.deps.now().toISOString() };
  await writeFile(s.path, JSON.stringify(old));
  const original = _lockDeps.rename;
  _lockDeps.rename = (from, to) => {
    writeFileSync(s.path, JSON.stringify(winner));
    if (kind === "lost-rename") throw Object.assign(new Error("lost"), { code: "ENOENT" });
    renameSync(from, to);
    if (kind === "newer") writeFileSync(s.path, JSON.stringify({ ...winner, nonce: "newest" }));
  };
  try {
    await expect(s.store.acquireLock("a")).rejects.toThrow("session in use");
    expect((await s.read()).nonce).toBe(kind === "newer" ? "newest" : "winner");
    if (kind === "newer") {
      const saved = (await readdir(s.deps.dir)).find((name) => name.endsWith(".stale"));
      expect(saved).toBeDefined();
      expect(JSON.parse(await readFile(join(s.deps.dir, saved ?? "missing"), "utf8")).nonce).toBe("winner");
    }
  } finally {
    _lockDeps.rename = original;
  }
});

test.each(["heartbeat", "release"] as const)(
  "serializes a separate-process takeover at the %s mutation barrier",
  async (kind) => {
    const s = setup();
    const release = await s.store.acquireLock("a");
    const originalRename = _lockDeps.rename;
    const originalRemove = _lockDeps.remove;
    const contend = () => {
      const child = spawnSync(process.execPath, [join(import.meta.dir, "../../fixtures/lock-contender.ts"), s.path], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(child.status).toBe(0);
      return JSON.parse(child.stdout);
    };
    let attempted = false;
    let acquired = false;
    const barrier = () => {
      attempted = true;
      acquired = contend().acquired;
    };
    _lockDeps.rename = (from, to) => {
      if (to === s.path) barrier();
      originalRename(from, to);
    };
    _lockDeps.remove = (path, options) => {
      if (path === s.path) barrier();
      originalRemove(path, options);
    };
    try {
      if (kind === "heartbeat") await s.advance();
      else await release();
      expect(attempted).toBe(true);
      expect(acquired).toBe(false);
      // Once A leaves the critical section, B can take ownership. A can no longer
      // replace or unlink B's lock, even when its old timer/release runs again.
      _lockDeps.rename = originalRename;
      _lockDeps.remove = originalRemove;
      const winner = contend();
      expect(winner.acquired).toBe(true);
      await s.advance();
      await release();
      expect((await s.read()).nonce).toBe(winner.body.nonce);
    } finally {
      _lockDeps.rename = originalRename;
      _lockDeps.remove = originalRemove;
      await release();
    }
  },
);

test("recovers a guard abandoned by a process that died in its critical section", async () => {
  const s = setup();
  const child = spawnSync(
    process.execPath,
    [join(import.meta.dir, "../../fixtures/lock-contender.ts"), s.path, "crash-guard"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(child.status).toBe(0);
  expect((await readdir(`${s.path}.guard`)).length).toBe(1);
  const release = await s.store.acquireLock("a");
  expect((await s.read()).pid).toBe(1000);
  await release();
  expect(await readdir(s.deps.dir)).toEqual([]);
});

test("creation links a fully written body, never an empty lock", async () => {
  const s = setup();
  const original = _lockDeps.link;
  let checked = false;
  _lockDeps.link = (from, to) => {
    const body = JSON.parse(readFileSync(from, "utf8"));
    expect(body.nonce).toEqual(expect.any(String));
    expect(body.heartbeatAt).toBe(s.deps.now().toISOString());
    checked = true;
    original(from, to);
  };
  try {
    const release = await s.store.acquireLock("a");
    expect(checked).toBe(true);
    await release();
  } finally {
    _lockDeps.link = original;
  }
});
