import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as pub from "@nathapp/nax-agent";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryProvider,
  type MemoryStore,
  type MemoryWriteRequest,
  renderMemoryIndex,
  syncMemory,
} from "@nathapp/nax-agent";
import type { MemorySyncInput } from "#src/memory/index";
import { _memoryStoreDeps } from "#src/memory/store";
import { acquireSessionLock } from "#src/session-store/index";
import { _lockDeps } from "#src/session-store/session-lock";
import {
  type MemoryProviderMock,
  type MemoryProviderScript,
  type MockLogger,
  makeLogger,
  makeMemoryProvider,
  withDepsRestore,
  withTempDir,
} from "#test/helpers/index";

/** The instant every test's injected clock reports. */
const STAMP = "2026-11-02T08:11:00.000Z";
/** The pid of a lock holder these tests did not start. */
const HOLDER_PID = 9999;
/** The pid each harness claims as its own: never the holder's, never this process's. */
const SYNC_PID = 4242;

/** The example note from the memory-store design, with overrides. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: STAMP,
    status: "active",
    body: "The replay budget stays at 2,048 MiB. Next export append is due ~11-23.",
    ...overrides,
  };
}

/** A `save` write request ready to push, carrying `saved`. */
function saveRequest(saved: MemoryNote = note()): MemoryWriteRequest {
  return {
    kind: "save",
    clientId: "client-1",
    scope: saved.scope,
    slug: saved.slug,
    writeMode: "direct",
    note: saved,
  };
}

/** The pieces one sync runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  /** The sync's input: this harness's pieces, plus any per-test override. */
  input(overrides?: Partial<MemorySyncInput>): MemorySyncInput;
}

function harness(dir: string, script: MemoryProviderScript = {}): Harness {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const provider = makeMemoryProvider(script);
  return {
    store,
    outbox,
    provider,
    logger,
    input: (overrides = {}) => ({
      store,
      outbox,
      provider,
      logger,
      now: () => new Date(STAMP),
      pid: SYNC_PID,
      // A lock nobody's pid proves live is a stale one: the default is "this holder is gone".
      isAlive: () => false,
      ...overrides,
    }),
  };
}

/**
 * A logger whose `warn` throws: reporting a failure is best-effort, so a logger
 * that fails must not be able to turn a reportable outcome into a rejection.
 */
function throwingLogger(): MockLogger {
  const logger = makeLogger();
  logger.warn.mockImplementation(() => {
    throw new Error("logger exploded");
  });
  return logger;
}

/** A lock file held by another process, with a heartbeat as fresh as `STAMP`. */
async function writeLock(path: string, pid: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = { pid, startedAt: STAMP, nonce: "holder-nonce", heartbeatAt: STAMP };
  await writeFile(path, JSON.stringify(body));
}

describe("makeMemoryProvider", () => {
  test("AC-1: scripts reachable, push and pull, and records every call", async () => {
    const refused = new Error("note kind not available");
    const provider = makeMemoryProvider({
      id: "scripted",
      reachable: [true, false],
      push: [{ id: "mem_7", status: "active" }, refused, "hang"],
      pull: [{ notes: [note()], nextCursor: "c1", done: false }],
    });
    // A MemoryProvider, structurally: nothing but the published contract is used below.
    const asProvider: MemoryProvider = provider;

    expect(asProvider.id).toBe("scripted");
    expect(await asProvider.reachable()).toBe(true);
    expect(await asProvider.reachable()).toBe(false);
    // The script's last step repeats once it is exhausted.
    expect(await asProvider.reachable()).toBe(false);

    const request = saveRequest();
    expect(await asProvider.push(request)).toEqual({ id: "mem_7", status: "active" });
    await expect(asProvider.push(request)).rejects.toBe(refused);
    const hanging = asProvider.push(request);
    expect(await Promise.race([hanging.then(() => "settled"), Promise.resolve("pending")])).toBe("pending");

    const page = await asProvider.pull({ scope: "project", cursor: null, take: 10 });
    expect(page).toEqual({ notes: [note()], nextCursor: "c1", done: false });
    expect(await asProvider.pull({ scope: "project", cursor: "c1", take: 10 })).toEqual(page);

    expect(provider.reachable.mock.calls).toHaveLength(3);
    expect(provider.push.mock.calls).toHaveLength(3);
    expect(provider.push.mock.calls.map(([pushed]) => pushed.clientId)).toEqual(["client-1", "client-1", "client-1"]);
    expect(provider.pull.mock.calls).toEqual([
      [{ scope: "project", cursor: null, take: 10 }],
      [{ scope: "project", cursor: "c1", take: 10 }],
    ]);
  });

  test("AC-1: an unscripted provider answers the way the built-in one does", async () => {
    const provider = makeMemoryProvider();

    expect(await provider.reachable()).toBe(true);
    expect(await provider.pull({ scope: "user", cursor: null, take: 5 })).toEqual({ notes: [], done: true });
    expect(await provider.push(saveRequest())).toEqual({ id: "mem_01J9X2", status: "active" });
  });
});

describe("syncMemory", () => {
  withDepsRestore(_memoryStoreDeps);
  withDepsRestore(_lockDeps);

  test("AC-2: an empty outbox with a reachable provider is a synced run that moves nothing", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);

      const result = await syncMemory(h.input());

      expect(result).toEqual({ outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(h.provider.reachable).toHaveBeenCalledTimes(1);
      expect(h.provider.push).not.toHaveBeenCalled();
      // The pull is part of every reachable run (US-014); a provider with nothing to send
      // answers one finished page, so it moves nothing either.
      expect(h.provider.pull).toHaveBeenCalledTimes(1);
    });
  });

  test("AC-3: the lock file is held while the sync runs and gone once it resolves", async () => {
    await withTempDir(async (dir) => {
      const lock = join(dir, "project", "sync.lock");
      let heldWhileRunning = false;
      const h = harness(dir, {
        reachable: () => {
          heldWhileRunning = existsSync(lock);
          return true;
        },
      });
      expect(h.store.paths.lock).toBe(lock);

      const result = await syncMemory(h.input());

      expect(result.outcome).toBe("synced");
      expect(heldWhileRunning).toBe(true);
      expect(existsSync(lock)).toBe(false);
    });
  });

  test("AC-4: a live holder in another process is a locked run that never asks the provider", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await writeLock(h.store.paths.lock, HOLDER_PID);

      const result = await syncMemory(h.input({ isAlive: (pid) => pid === HOLDER_PID }));

      expect(result).toEqual({ outcome: "locked", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(h.provider.reachable).not.toHaveBeenCalled();
      // The live holder's lock is left exactly as it was.
      expect(JSON.parse(await readFile(h.store.paths.lock, "utf8"))).toMatchObject({ nonce: "holder-nonce" });
      expect(existsSync(h.store.paths.index)).toBe(false);
    });
  });

  test("AC-5: a dead holder's lock is taken over and the run completes", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await writeLock(h.store.paths.lock, HOLDER_PID);

      const result = await syncMemory(h.input({ isAlive: () => false }));

      expect(result.outcome).toBe("synced");
      expect(h.provider.reachable).toHaveBeenCalledTimes(1);
      // Taken over, then released by the run that took it.
      expect(existsSync(h.store.paths.lock)).toBe(false);
    });
  });

  test("AC-6: two calls in one process get one synced and one locked, and the provider is asked once", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);

      const running = syncMemory(h.input());
      const overlapping = syncMemory(h.input());
      const [first, second] = await Promise.all([running, overlapping]);

      expect(first.outcome).toBe("synced");
      expect(second).toEqual({ outcome: "locked", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(h.provider.reachable).toHaveBeenCalledTimes(1);
    });
  });

  test("AC-7: a project directory that does not exist yet is created", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      expect(existsSync(h.store.paths.projectDir)).toBe(false);

      const result = await syncMemory(h.input());

      expect(result.outcome).toBe("synced");
      expect(existsSync(h.store.paths.projectDir)).toBe(true);
    });
  });

  test("AC-8: a synced run leaves the rendered index of the mirror's notes in MEMORY.md", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const saved = note();
      await h.store.writeNote(saved);

      const result = await syncMemory(h.input());

      expect(result.outcome).toBe("synced");
      const rendered = renderMemoryIndex({ projectNotes: [saved], userNotes: [], decisions: [] });
      expect(await readFile(h.store.paths.index, "utf8")).toBe(rendered.text);
      expect(rendered.text).toContain("- [project] replay-budget — replay budget stays 2,048 MiB");
    });
  });

  test("AC-9: a throw while finishing is a failed result, and both guards are released", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const unavailable = new Error("outbox unavailable");
      const broken: MemoryOutbox = {
        ...h.outbox,
        heldKeys: async () => {
          throw unavailable;
        },
      };

      const result = await syncMemory(h.input({ outbox: broken }));

      expect(result).toEqual({
        outcome: "failed",
        pushed: 0,
        rejected: 0,
        pulled: 0,
        skipped: 0,
        error: "outbox unavailable",
      });
      expect(existsSync(h.store.paths.lock)).toBe(false);
      const warns = h.logger.calls.filter((call) => call.level === "warn");
      const [warned] = warns;
      expect(warns).toHaveLength(1);
      expect(warned).toMatchObject({
        stage: "memory",
        message: "memory sync failed",
        data: { error: "outbox unavailable" },
      });
      // The in-flight key went with the lock: the same store syncs on the next attempt.
      await expect(syncMemory(h.input())).resolves.toMatchObject({ outcome: "synced" });
    });
  });

  test("AC-10: syncMemory is public and the lock primitive is on the session-store barrel", () => {
    expect(typeof pub.syncMemory).toBe("function");
    expect(typeof syncMemory).toBe("function");
    expect(typeof acquireSessionLock).toBe("function");
  });

  test("an initialisation failure is a failed run, and the in-flight guard is released", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const realMkdir = _memoryStoreDeps.mkdir;
      _memoryStoreDeps.mkdir = async () => {
        throw denied;
      };

      const result = await syncMemory(h.input());
      _memoryStoreDeps.mkdir = realMkdir;

      expect(result).toMatchObject({ outcome: "failed", error: "permission denied" });
      expect(h.provider.reachable).not.toHaveBeenCalled();
      expect(h.logger.calls.filter((call) => call.level === "warn")).toHaveLength(1);
      // The guard went with the failure: the next attempt is not told the store is busy.
      await expect(syncMemory(h.input())).resolves.toMatchObject({ outcome: "synced" });
    });
  });

  test("a release that fails is logged, and the run's own result still stands", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const failure = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      _lockDeps.remove = () => {
        throw failure;
      };

      const result = await syncMemory(h.input());

      expect(result).toEqual({ outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      const [warned] = h.logger.calls.filter((call) => call.level === "warn");
      expect(warned).toMatchObject({
        stage: "memory",
        message: "memory sync could not release the lock",
        data: { error: "EBUSY: resource busy" },
      });
      // The unreleased lock outlives the run — a stale one the next call takes over.
      expect(existsSync(h.store.paths.lock)).toBe(true);
      await expect(syncMemory(h.input())).resolves.toMatchObject({ outcome: "synced" });
    });
  });

  test("F1: a logger that throws cannot turn a failed run into a rejection", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const logger = throwingLogger();
      const unavailable = new Error("outbox unavailable");
      const broken: MemoryOutbox = {
        ...h.outbox,
        heldKeys: async () => {
          throw unavailable;
        },
      };

      const result = await syncMemory(h.input({ outbox: broken, logger }));

      expect(result).toEqual({
        outcome: "failed",
        pushed: 0,
        rejected: 0,
        pulled: 0,
        skipped: 0,
        error: "outbox unavailable",
      });
      // The warning was attempted, and its failure was swallowed rather than raised.
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(existsSync(h.store.paths.lock)).toBe(false);
      await expect(syncMemory(h.input())).resolves.toMatchObject({ outcome: "synced" });
    });
  });

  test("F1: a logger that throws cannot turn an unclean release into a rejection", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const logger = throwingLogger();
      const failure = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      _lockDeps.remove = () => {
        throw failure;
      };

      const result = await syncMemory(h.input({ logger }));

      expect(result).toEqual({ outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      // The in-flight key is gone even though the reporting path threw.
      await expect(syncMemory(h.input())).resolves.toMatchObject({ outcome: "synced" });
    });
  });

  test("a provider that answers false is an unreachable run that touches neither the outbox nor the index", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: false });

      const result = await syncMemory(h.input());

      expect(result).toEqual({ outcome: "unreachable", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(h.provider.pull).not.toHaveBeenCalled();
      expect(existsSync(h.store.paths.index)).toBe(false);
      expect(existsSync(h.store.paths.lock)).toBe(false);
    });
  });
});
