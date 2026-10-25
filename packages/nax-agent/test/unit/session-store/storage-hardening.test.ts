import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { NaxError } from "#src/infra/nax-error";
import {
  _lockDeps,
  acquireSessionLock,
  holderState,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  type SessionStorageDeps,
} from "#src/session-store/session-lock";
import { SessionLockGuardBusy, withSessionLockGuard } from "#src/session-store/session-lock-guard";
import { makeLogger } from "#test/helpers/agent-logger";

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
  let handle: ReturnType<typeof setInterval> | undefined;
  const deps: SessionStorageDeps = {
    dir,
    pid: 1000,
    now: () => new Date(now),
    isAlive: () => true,
    logger: makeLogger(),
    setInterval: (fn, ms) => {
      tick = fn;
      interval = ms;
      handle = setInterval(() => {}, 2 ** 30);
      return handle;
    },
  };
  const path = join(dir, "a.lock");
  return {
    deps,
    path,
    acquire: (id = "a") => acquireSessionLock(join(dir, `${id}.lock`), deps, deps.isAlive ?? (() => true)),
    read: async () => JSON.parse(await readFile(path, "utf8")),
    advance: async () => {
      now += 30_000;
      await tick();
    },
    interval: () => interval,
    timer: () => handle,
  };
}

test("unique nonces, atomic heartbeat, owned release and loss of ownership", async () => {
  const s = setup();
  const release = s.acquire("a");
  const first = await s.read();
  expect(first.nonce).toEqual(expect.any(String));
  expect(s.interval()).toBe(LOCK_HEARTBEAT_MS);
  await s.advance();
  expect((await s.read()).heartbeatAt).not.toBe(first.heartbeatAt);
  const otherRelease = s.acquire("b");
  const other = JSON.parse(await readFile(join(s.deps.dir, "b.lock"), "utf8"));
  expect(other.nonce).not.toBe(first.nonce);
  await writeFile(s.path, JSON.stringify({ ...first, nonce: "replacement" }));
  await release();
  expect((await s.read()).nonce).toBe("replacement");
  await otherRelease();
  await expect(readFile(join(s.deps.dir, "b.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([false, true])("release retries contention and preserves a replacement: %s", async (replace) => {
  const s = setup();
  const release = s.acquire("a");
  const first = await s.read();
  const guard = `${s.path}.guard`;
  await mkdir(guard);
  await writeFile(join(guard, `${process.pid}.00000000-0000-0000-0000-000000000000`), "");
  const closing = release();
  const outcome = closing.then(
    () => "closed",
    () => "rejected",
  );
  try {
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
    rmSync(guard, { recursive: true });
    // Before the retry timer fires, the heartbeat must still be active.
    await s.advance();
    expect(JSON.parse(readFileSync(s.path, "utf8")).heartbeatAt).not.toBe(first.heartbeatAt);
    if (replace) writeFileSync(s.path, JSON.stringify({ ...first, nonce: "replacement" }));
    await expect(closing).resolves.toBeUndefined();
    if (replace) expect((await s.read()).nonce).toBe("replacement");
    else await expect(readFile(s.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(guard, { recursive: true, force: true });
    await outcome;
  }
});

test("a terminal release error still stops the heartbeat", async () => {
  const s = setup();
  const release = s.acquire("a");
  const handle = s.timer();
  const originalRemove = _lockDeps.remove;
  const originalClear = globalThis.clearInterval;
  const cleared: unknown[] = [];
  globalThis.clearInterval = ((timer?: Parameters<typeof clearInterval>[0]) => {
    cleared.push(timer);
    originalClear(timer);
  }) as typeof clearInterval;
  _lockDeps.remove = (path, options) => {
    if (path === s.path) throw Object.assign(new Error("injected"), { code: "EIO" });
    originalRemove(path, options);
  };
  try {
    await expect(release()).rejects.toMatchObject({ code: "EIO" });
    // An orphaned lock must age into stale recovery, not be refreshed forever.
    expect(cleared).toContain(handle);
  } finally {
    _lockDeps.remove = originalRemove;
    globalThis.clearInterval = originalClear;
  }
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
  if (kind === "fresh") expect(() => s.acquire("a")).toThrow("session in use");
  else {
    const release = s.acquire("a");
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
  const second = { ...s.deps, pid: 2000 };
  const results = await Promise.allSettled([
    Promise.resolve().then(() => s.acquire("a")),
    Promise.resolve().then(() => acquireSessionLock(s.path, second, () => true)),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  for (const r of results) if (r.status === "fulfilled") await r.value();
});

test("heartbeat never recreates a missing lock", async () => {
  const s = setup();
  const release = s.acquire("a");
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
    expect(() => s.acquire("a")).toThrow("session in use");
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
    const release = s.acquire("a");
    const originalRename = _lockDeps.rename;
    const originalRemove = _lockDeps.remove;
    const contend = () => {
      const child = spawnSync(
        process.execPath,
        [join(import.meta.dir, "../../fixtures/session-store/lock-contender.ts"), s.path],
        {
          encoding: "utf8",
          timeout: 10_000,
        },
      );
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
    [join(import.meta.dir, "../../fixtures/session-store/lock-contender.ts"), s.path, "crash-guard"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(child.status).toBe(0);
  expect((await readdir(`${s.path}.guard`)).length).toBe(1);
  const release = s.acquire("a");
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
    const release = s.acquire("a");
    expect(checked).toBe(true);
    await release();
  } finally {
    _lockDeps.link = original;
  }
});

const freshBody = {
  pid: 4242,
  startedAt: "2026-10-09T00:00:00.000Z",
  nonce: "old",
  heartbeatAt: "2026-10-09T00:00:00.000Z",
};

test("AC-1..4: fresh live refusal is neutral, identifies the holder and preserves bytes", async () => {
  const s = setup();
  const bytes = JSON.stringify(freshBody, null, 2);
  await writeFile(s.path, bytes);
  let refusal: unknown;
  try {
    s.acquire();
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(NaxError);
  expect(refusal).toMatchObject({
    code: "SESSION_LOCKED",
    message: "session in use by pid 4242",
    context: { stage: "session-store", pid: 4242 },
  });
  expect(await readFile(s.path, "utf8")).toBe(bytes);
});

test.each(["stale-heartbeat", "dead-pid"])("AC-5..9,11: %s takeover logs, owns and releases", async (kind) => {
  const s = setup();
  const logger = makeLogger();
  const body = { ...freshBody, heartbeatAt: new Date(s.deps.now().getTime() - LOCK_STALE_MS - 1).toISOString() };
  await writeFile(s.path, JSON.stringify(kind === "dead-pid" ? freshBody : body));
  const release = acquireSessionLock(s.path, { ...s.deps, logger }, () => kind !== "dead-pid");
  expect(typeof release).toBe("function");
  expect((await s.read()).pid).toBe(1000);
  expect(logger.calls).toContainEqual({
    level: "info",
    stage: "session",
    message: "taking over a stale session lock",
    data: { pid: 4242 },
  });
  await release();
  await expect(readFile(s.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("AC-10: legacy live holder has no expiry", async () => {
  const s = setup();
  await writeFile(s.path, JSON.stringify({ pid: 4242, startedAt: "x" }));
  expect(() => s.acquire()).toThrow(expect.objectContaining({ code: "SESSION_LOCKED" }));
});

test("AC-13..14: heartbeat uses the unchanged interval and advanced clock", async () => {
  const s = setup();
  const release = s.acquire();
  try {
    expect(LOCK_HEARTBEAT_MS).toBe(30000);
    expect(s.interval()).toBe(LOCK_HEARTBEAT_MS);
    await s.advance();
    expect((await s.read()).heartbeatAt).toBe("2026-10-09T00:00:30.000Z");
  } finally {
    await release();
  }
});

test("AC-15..17: guard contention remains distinguishable and neutral", () => {
  const s = setup();
  const busy = new SessionLockGuardBusy();
  expect(busy).toBeInstanceOf(NaxError);
  expect(busy).toMatchObject({ code: "SESSION_LOCKED", context: { stage: "session-store" } });
  withSessionLockGuard(s.path, () => {
    expect(() => s.acquire()).toThrow(SessionLockGuardBusy);
    expect(() => s.acquire()).toThrow("session in use by another process");
  });
});

test.each([
  ["boundary", 4242, true, LOCK_STALE_MS, "live"],
  ["own-dead", 1000, false, 0, "own"],
  ["dead", 4242, false, 0, "stale"],
  ["expired", 4242, true, LOCK_STALE_MS + 1, "stale"],
] as const)("AC-18..20: holder predicate %s", (_name, pid, alive, age, state) => {
  const s = setup();
  expect(
    holderState(
      { ...freshBody, pid, heartbeatAt: new Date(s.deps.now().getTime() - age).toISOString() },
      s.deps,
      () => alive,
    ),
  ).toBe(state);
});
