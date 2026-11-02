/**
 * US-017: `saveMemoryNote` — the undelivered, queued-behind and permanently rejected
 * paths.
 *
 * A note is staged in the mirror whatever the provider then makes of it, because the
 * mirror is the agent's memory until a sync delivers the write. A provider that does
 * not answer — `false`, a throw or a timeout — and a push that fails transiently or
 * times out therefore all end the same way: the request, under the same client id the
 * note was staged with, is queued in the outbox and the save reports
 * `delivered: false`. Staging first and queuing second is what keeps the two in one
 * order: the mirror holds exactly what the queue will deliver.
 *
 * A key the outbox already holds a queued write for is not pushed at all. The new
 * write joins the queue behind the waiting one, so the provider receives them in the
 * order the agent made them, and the mirror keeps the newer note — it is the one the
 * queued write carries.
 *
 * A permanent refusal (`MEMORY_PUSH_REJECTED`) is the exception in both directions: it
 * is not queued, because retrying would repeat it, and the mirror is put back the way
 * it was — the note this save replaced, or no note at all — before the provider's own
 * error reaches the caller.
 *
 * The validator's rules and the delivered path are exercised in `operations.test.ts`;
 * these tests cover only what happens when the provider does not take the write.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  MEMORY_OP_TIMEOUT_MS,
  MEMORY_PROBE_TIMEOUT_MS,
  type MemoryNote,
  type MemoryNoteWrite,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryStore,
  NaxError,
  saveMemoryNote,
  syncMemory,
} from "@nathapp/nax-agent";
import { acquireSessionLock } from "#src/session-store/index";
import {
  assertDefined,
  assertNaxError,
  type FakeClock,
  type MemoryProviderMock,
  type MockLogger,
  makeFakeClock,
  makeLogger,
  makeMemoryProvider,
  waitForCondition,
  withTempDir,
} from "#test/helpers/index";

/** The instant every test's injected clock reports. */
const STAMP = "2026-11-08T08:30:00.000Z";
/** The label every save in these tests is made under. */
const SOURCE = "nax-chat";
/** What a store whose writes are refused reports: the mirror cannot be written to. */
const MIRROR_READ_ONLY = "mirror is read-only";
/** The description of the note a save replaces: never what an undelivered save keeps. */
const OLD_DESCRIPTION = "replay budget stays 1,024 MiB";

/** The write a save carries: the example note from the memory-store design. */
function write(overrides: Partial<MemoryNoteWrite> = {}): MemoryNoteWrite {
  return {
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    body: "The replay budget stays at 2,048 MiB.",
    ...overrides,
  };
}

/** The note already in the mirror: what a permanent refusal has to put back. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_existing",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: OLD_DESCRIPTION,
    source: "nax-run",
    updatedAt: "2026-11-01T09:00:00.000Z",
    status: "active",
    body: "The replay budget stays at 1,024 MiB.",
    ...overrides,
  };
}

/** A provider refusal: the write will never be accepted, so retrying it is pointless. */
function refusal(reason = "slug is reserved"): NaxError {
  return new NaxError(reason, "MEMORY_PUSH_REJECTED", { stage: "memory" });
}

/** The pieces one save runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  readonly clock: FakeClock;
  /** The save's input: this harness's pieces, plus any per-test override. */
  save(overrides?: Partial<MemorySaveInput>): Promise<MemorySaveResult>;
}

function harness(dir: string, script: Parameters<typeof makeMemoryProvider>[0] = {}): Harness {
  const logger = makeLogger();
  const clock = makeFakeClock();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const provider = makeMemoryProvider(script);
  return {
    store,
    outbox,
    provider,
    logger,
    clock,
    save: (overrides = {}) =>
      saveMemoryNote({
        store,
        outbox,
        provider,
        logger,
        now: () => new Date(STAMP),
        timers: clock,
        write: write(),
        writeMode: "direct",
        source: SOURCE,
        ...overrides,
      }),
  };
}

/** The mirrored note under the slug every save here writes, whatever became of it. */
async function mirrored(h: Harness): Promise<MemoryNote> {
  const stored = await h.store.readNote("project", "replay-budget");
  assertDefined(stored, "mirrored note");
  return stored;
}

/** The mirrored note, asserted to be staged rather than delivered. */
async function staged(h: Harness): Promise<MemoryNote> {
  const stored = await mirrored(h);
  // Staged, not delivered: the note still carries the id and clock it was minted with.
  expect(stored.status).toBe("active");
  expect(stored.source).toBe(SOURCE);
  expect(stored.updatedAt).toBe(STAMP);
  return stored;
}

/** The outbox's one queued entry, asserted to be the only one. */
async function soleEntry(h: Harness): Promise<MemoryOutboxEntry> {
  const entries = await h.outbox.list();
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  assertDefined(entry, "queued outbox entry");
  return entry;
}

/** A promise the test resolves by hand: what keeps one save in flight while a second starts. */
function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

/**
 * The store's lock, held the way an owner holds it: `pid` and the liveness probe that
 * decides whether that owner is still there. The release it returns must be called.
 */
async function heldLock(h: Harness, pid: number, isAlive: (pid: number) => boolean): Promise<() => Promise<void>> {
  await mkdir(h.store.paths.projectDir, { recursive: true });
  const deps = { dir: h.store.paths.projectDir, pid, now: () => new Date(STAMP), logger: h.logger, isAlive };
  return acquireSessionLock(h.store.paths.lock, deps, isAlive);
}

/** A pid no test process has: the file a second process's owner would leave behind. */
const FOREIGN_PID = 8412;

/** A fake-clock step wide enough to fire any poll a fenced save is waiting on. */
const POLL_STEP_MS = 1_000;

/**
 * Drive a fenced save's wait to its deadline: the fake clock only moves when the test says
 * so, and the save re-arms its poll between each look at the queue.
 */
async function expireFencedWait(clock: FakeClock, saving: Promise<MemorySaveResult>): Promise<MemorySaveResult> {
  let settled = false;
  const tracked = saving.finally(() => {
    settled = true;
  });
  while (!settled) {
    // The save arms a poll each time it looks; once it stops arming one it is finishing.
    const armed = await waitForCondition(() => clock.pending() > 0, 50).then(
      () => true,
      () => false,
    );
    if (!armed) break;
    await clock.advance(POLL_STEP_MS);
  }
  return await tracked;
}

/** The description of the write staged first in the two-saves-in-flight tests. */
const FIRST_WRITE = "replay budget stays 2,048 MiB";
/** The description of the write staged second: the one the mirror and the queue must end on. */
const SECOND_WRITE = "replay budget stays 4,096 MiB";

describe("saveMemoryNote when the provider does not take the write", () => {
  test("AC-1: an unreachable provider mirrors the note and queues it under the same client id", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: false });

      const result = await h.save();

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: false });
      const stored = await staged(h);
      // The push was never attempted: the probe already answered.
      expect(h.provider.push).not.toHaveBeenCalled();
      const entry = await soleEntry(h);
      expect(entry).toMatchObject({
        kind: "save",
        clientId: stored.id,
        scope: "project",
        slug: "replay-budget",
        writeMode: "direct",
        state: "queued",
      });
      // What is queued is the mirrored note, under the id it was staged with.
      expect(entry.note).toEqual(stored);
      expect(h.clock.pending()).toBe(0);
    });
  });

  test("AC-2: a probe that rejects is the same fact as an unreachable one", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: new Error("ECONNREFUSED 127.0.0.1:8443") });

      const result = await h.save();

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: false });
      const stored = await staged(h);
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(await soleEntry(h)).toMatchObject({ clientId: stored.id, state: "queued" });
    });
  });

  test("AC-3: a push that never settles is queued once the operation deadline fires", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: "hang" });

      const saving = h.save();
      // The probe's timer is cleared before the push: the one left armed is the operation's.
      await waitForCondition(() => h.provider.push.mock.calls.length === 1 && h.clock.pending() > 0, 5_000);
      expect(h.clock.pending()).toBe(1);
      await h.clock.advance(MEMORY_OP_TIMEOUT_MS);
      const result = await saving;

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: false });
      const stored = await staged(h);
      expect(await soleEntry(h)).toMatchObject({ clientId: stored.id, kind: "save", state: "queued" });
      // The race cleared the deadline it armed.
      expect(h.clock.pending()).toBe(0);
    });
  });

  test("AC-4: a transient push failure is queued, and the note it replaced is not restored", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: new Error("connection reset by peer") });
      await h.store.writeNote(note());

      const result = await h.save();

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: false });
      // The local write is the newer fact: it stays, and the queue carries it.
      const stored = await staged(h);
      expect(stored.description).not.toBe(OLD_DESCRIPTION);
      const entry = await soleEntry(h);
      expect(entry).toMatchObject({ clientId: stored.id, state: "queued" });
      expect(entry.note).toEqual(stored);
    });
  });

  test("AC-5: a key the outbox already holds is queued behind it, and nothing is pushed", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const waiting = await h.outbox.enqueue({
        kind: "save",
        clientId: "client-waiting",
        scope: "project",
        slug: "replay-budget",
        writeMode: "direct",
        note: note(),
      });

      const result = await h.save();

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: false });
      // The queue already holds this key: asking the provider would deliver it out of order.
      expect(h.provider.reachable).not.toHaveBeenCalled();
      expect(h.provider.push).not.toHaveBeenCalled();
      const stored = await staged(h);
      const entries = await h.outbox.list();
      expect(entries.map((entry) => entry.clientId)).toEqual(["client-waiting", stored.id]);
      const queued = entries[1];
      assertDefined(queued, "queued-behind entry");
      // Behind it in the queue, and carrying the newer note the mirror now holds.
      expect(queued.seq).toBeGreaterThan(waiting.seq);
      expect(queued).toMatchObject({ kind: "save", slug: "replay-budget", state: "queued" });
      expect(queued.note).toEqual(stored);
    });
  });

  test("AC-5: two saves of one key in flight together queue in the order the writes were staged", async () => {
    await withTempDir(async (dir) => {
      const gate = deferred();
      const h = harness(dir, { reachable: false });
      let staged = 0;
      // The first write is staged and then held: the second save can only run while it is.
      const store: MemoryStore = {
        ...h.store,
        writeNote: async (written) => {
          staged += 1;
          await h.store.writeNote(written);
          if (written.description === FIRST_WRITE) await gate.promise;
        },
      };

      const first = h.save({ store, write: write({ description: FIRST_WRITE }) });
      const second = h.save({ store, write: write({ description: SECOND_WRITE }) });
      const overlapped = await waitForCondition(() => staged > 1, 50).then(
        () => true,
        () => false,
      );
      gate.release();
      const results = await Promise.all([first, second]);

      // A same-key save must not stage while the first is still being staged and queued.
      expect(overlapped).toBe(false);
      expect(results.map((result) => result.delivered)).toEqual([false, false]);
      const entries = await h.outbox.list();
      expect(entries.map((entry) => entry.note?.description)).toEqual([FIRST_WRITE, SECOND_WRITE]);
    });
  });

  test("AC-5: two saves of one key in flight together deliver in the order the writes were staged", async () => {
    await withTempDir(async (dir) => {
      const gate = deferred();
      let pushes = 0;
      const h = harness(dir, {
        push: async () => {
          pushes += 1;
          const id = `mem_${pushes}`;
          // The first delivery is held open; a second one reaching the provider here is the bug.
          if (pushes === 1) await gate.promise;
          return { id, status: "active" };
        },
      });

      const first = h.save({ write: write({ description: FIRST_WRITE }) });
      const second = h.save({ write: write({ description: SECOND_WRITE }) });
      const overlapped = await waitForCondition(() => pushes > 1, 50).then(
        () => true,
        () => false,
      );
      gate.release();
      const results = await Promise.all([first, second]);

      // A same-key save must not reach the provider while the first delivery is in flight.
      expect(overlapped).toBe(false);
      expect(results.map((result) => result.delivered)).toEqual([true, true]);
      // The later write is the last one delivered, so the mirror is not left on the older note.
      expect(await mirrored(h)).toMatchObject({ description: SECOND_WRITE, id: "mem_2" });
    });
  });

  test("AC-6: a refusal of a new slug is rethrown and leaves no note and no entry", async () => {
    await withTempDir(async (dir) => {
      const rejected = refusal();
      const h = harness(dir, { push: rejected });

      const caught = await h.save().catch((error: unknown) => error);

      // The provider's own error reaches the caller; a refusal is not the mirror's to soften.
      expect(caught).toBe(rejected);
      assertNaxError(caught, "rejected save");
      expect(caught.message).toBe("slug is reserved");
      expect(await h.store.readNote("project", "replay-budget")).toBeNull();
      expect(existsSync(join(h.store.paths.notesDir, "replay-budget.md"))).toBe(false);
      // Retrying would repeat the refusal, so nothing is queued.
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-7: a refusal of an existing slug puts the previous note back", async () => {
    await withTempDir(async (dir) => {
      const previous = note();
      const h = harness(dir, { push: refusal("description is too long") });
      await h.store.writeNote(previous);

      const caught = await h.save().catch((error: unknown) => error);

      assertNaxError(caught, "rejected save");
      expect(caught.message).toBe("description is too long");
      // The save did not happen: the note the mirror held is the note it holds.
      expect(await h.store.readNote("project", "replay-budget")).toEqual(previous);
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-8: an undelivered save still leaves the new slug in the index", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: false });

      const result = await h.save();

      expect(result.delivered).toBe(false);
      const index = await readFile(h.store.paths.index, "utf8");
      expect(index).toContain("replay-budget");
      // A staged direct save is active, so its line carries no pending marker.
      expect(index).toContain("- [project] replay-budget");
      expect(index).not.toContain("(pending)");
    });
  });

  test("a rollback that fails is logged, and the refusal still reaches the caller", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: refusal() });
      await h.store.writeNote(note());
      let writes = 0;
      const store: MemoryStore = {
        ...h.store,
        writeNote: async (written) => {
          writes += 1;
          if (writes === 2) throw new Error(MIRROR_READ_ONLY);
          await h.store.writeNote(written);
        },
      };

      const caught = await h.save({ store }).catch((error: unknown) => error);

      assertNaxError(caught, "rejected save");
      expect(caught.code).toBe("MEMORY_PUSH_REJECTED");
      // The restore failed, so the staged note is still in the mirror — and that was reported, not thrown.
      expect(await h.store.readNote("project", "replay-budget")).toMatchObject({
        description: "replay budget stays 2,048 MiB",
        source: SOURCE,
      });
      const warns = h.logger.calls.filter((call) => call.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({
        stage: "memory",
        message: "memory save could not restore the previous note",
        data: { slug: "replay-budget", error: MIRROR_READ_ONLY },
      });
    });
  });
});

describe("saveMemoryNote and the mirror's lock", () => {
  test("AC-5: a fenced save takes its sequence behind the entry the owner writes while it holds the lock", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const owner = await heldLock(h, FOREIGN_PID, () => true);
      try {
        // The owner is mid-save: it holds the lock and has not queued its entry yet.
        const saving = h.save({ isAlive: () => true, write: write({ description: SECOND_WRITE }) });
        await waitForCondition(() => h.clock.pending() > 0, 5_000);
        // The owner's write goes on the queue while it holds the lock, as a save that will be
        // undelivered does before it asks the provider.
        const declared = await h.outbox.enqueue({
          kind: "save",
          clientId: "owner-write",
          scope: "project",
          slug: "replay-budget",
          writeMode: "direct",
          note: note({ description: FIRST_WRITE }),
        });
        await h.clock.advance(POLL_STEP_MS);
        const result = await saving;

        expect(result.delivered).toBe(false);
        // The older write keeps the earlier sequence, so a sync delivers them in that order.
        const entries = await h.outbox.list();
        expect(entries.map((entry) => entry.clientId)).toEqual(["owner-write", expect.any(String)]);
        expect(entries[1]?.note?.description).toBe(SECOND_WRITE);
        expect(entries[1]?.seq).toBeGreaterThan(declared.seq);
      } finally {
        await owner();
      }
    });
  });

  test("AC-5: a fenced save takes its turn once the owner hands the lock back", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const owner = await heldLock(h, FOREIGN_PID, () => true);

      const saving = h.save({ isAlive: () => true, write: write({ description: SECOND_WRITE }) });
      await waitForCondition(() => h.clock.pending() > 0, 5_000);
      await owner();
      await h.clock.advance(POLL_STEP_MS);
      const result = await saving;

      // The older save finished without queueing, so this one is free to deliver.
      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: true });
      expect(await mirrored(h)).toMatchObject({ description: SECOND_WRITE, status: "active" });
      expect(await h.outbox.list()).toEqual([]);
      expect(existsSync(h.store.paths.lock)).toBe(false);
    });
  });

  test("AC-5: a save whose mirror a live process owns queues the note and leaves the mirror alone", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const owner = await heldLock(h, FOREIGN_PID, () => true);
      try {
        // The owner is another process: alive, so its lock is not stale and not this save's,
        // and it queues nothing this save can see — the wait expires and the write queues.
        const saving = h.save({ isAlive: () => true });
        const result = await expireFencedWait(h.clock, saving);

        expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: false });
        // The mirror is the owner's: nothing was staged, probed or pushed into it.
        expect(await h.store.readNote("project", "replay-budget")).toBeNull();
        expect(h.provider.reachable).not.toHaveBeenCalled();
        expect(h.provider.push).not.toHaveBeenCalled();
        // The write itself is not lost: it is queued, carrying the note, for the next sync.
        const entry = await soleEntry(h);
        expect(entry).toMatchObject({ kind: "save", slug: "replay-budget", state: "queued" });
        expect(entry.note?.description).toBe(FIRST_WRITE);
        // Nothing of the mirror was rebuilt either, and the lock is still the owner's.
        expect(existsSync(h.store.paths.index)).toBe(false);
        expect(JSON.parse(await readFile(h.store.paths.lock, "utf8")).pid).toBe(FOREIGN_PID);
      } finally {
        await owner();
      }
    });
  });

  test("AC-5: a save whose own process is syncing the mirror queues instead of taking the lock over", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const clock = makeFakeClock();
      // A sync that parks on its probe: it holds the mirror's lock, and this process's pid.
      const running = syncMemory({
        store: h.store,
        outbox: h.outbox,
        provider: makeMemoryProvider({ reachable: "hang" }),
        logger: h.logger,
        now: () => new Date(STAMP),
        pid: process.pid,
        isAlive: () => true,
        timers: clock,
      });
      await waitForCondition(() => clock.pending() > 0, 5_000);
      const nonce = JSON.parse(await readFile(h.store.paths.lock, "utf8")).nonce;

      const result = await h.save();

      expect(result.delivered).toBe(false);
      expect(await h.store.readNote("project", "replay-budget")).toBeNull();
      // The same nonce is a lock that was never taken over: our own pid is not permission
      // to steal it from the sync that is still writing the mirror.
      expect(JSON.parse(await readFile(h.store.paths.lock, "utf8")).nonce).toBe(nonce);
      expect(await soleEntry(h)).toMatchObject({ slug: "replay-budget", state: "queued" });
      // The sync ends unreachable and hands the lock back, so the mirror is free again.
      await clock.advance(MEMORY_PROBE_TIMEOUT_MS);
      expect((await running).outcome).toBe("unreachable");
      expect(existsSync(h.store.paths.lock)).toBe(false);
    });
  });

  test("a lock this process leaked, with no sync running, is reclaimed by the next save", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      // A lock of ours that was never released: nothing of this process is syncing, so the
      // file can only be a release that failed — the next save must not be wedged by it.
      const leaked = await heldLock(h, process.pid, () => true);
      try {
        const result = await h.save();

        expect(result.delivered).toBe(true);
        // Taken over and released: the mirror is free again.
        expect(existsSync(h.store.paths.lock)).toBe(false);
      } finally {
        await leaked();
      }
    });
  });

  test("a delivered save releases the mirror's lock, so the next save takes it", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);

      const first = await h.save();
      const second = await h.save({ write: write({ slug: "export-window", description: "exports land by 09:00" }) });

      expect([first.delivered, second.delivered]).toEqual([true, true]);
      // Released, not just created: the mirror is free for the next save or sync.
      expect(existsSync(h.store.paths.lock)).toBe(false);
    });
  });
});
