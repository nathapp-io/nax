/**
 * US-001: what a save reports when the provider may have committed the write it never
 * answered.
 *
 * A provider is replay-safe unless it says otherwise (`MemoryProvider.replay`). For a
 * replay-safe provider a failed push is a write that will be delivered by a later sync, and
 * that is what it has always been.
 *
 * A non-replayable write cannot be treated that way: the attempt was dispatched, the answer
 * was lost, and sending it again could apply it twice. So the failed attempt leaves the entry
 * held as `uncertain` in the outbox — with its payload and the reason — and the save says the
 * delivery is unknown rather than claiming the write is queued for a retry that will not
 * happen.
 *
 * The distinction the caller can act on is the whole point, so it is on the result
 * (`pending.delivery`), not only in the queue: `unknown` means nothing will resend it, and
 * `queued` means the next sync will. A failure that provably dispatched nothing — the probe
 * never answered — stays on the `queued` side, because there the retry is exactly right.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  forgetMemoryNote,
  MEMORY_OP_TIMEOUT_MS,
  type MemoryForgetInput,
  type MemoryForgetResult,
  type MemoryNote,
  type MemoryNoteWrite,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemoryReplayContract,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryStore,
  markUndispatched,
  NaxError,
  saveMemoryNote,
  syncMemory,
} from "@nathapp/nax-agent";
import {
  assertDefined,
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
/** The provider id a sync records: never one already on disk, so no lock is mistaken for ours. */
const PID = 5151;
/** What a held entry's reason starts with, on both the outbox entry and the save's result. */
const UNKNOWN_DELIVERY = "delivery unknown";

/** A provider whose saves may not be repeated: a lost answer may hide a commit. */
const NON_REPLAYABLE_SAVES: MemoryReplayContract = { nonReplayable: ["save"] };

/** A provider whose retires may not be repeated either: a lost answer may hide a carried-out one. */
const NON_REPLAYABLE_WRITES: MemoryReplayContract = { nonReplayable: ["save", "forget"] };

/** The same, with the dispatch abandoned on the deadline: nothing can arrive after it. */
const NO_LATE_DISPATCH: MemoryReplayContract = { nonReplayable: ["save"], timeoutAftermath: "none" };

/** The note a forget names: the one every save here writes, as the mirror holds it. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_existing",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-run",
    updatedAt: "2026-11-01T09:00:00.000Z",
    status: "active",
    body: "The replay budget stays at 2,048 MiB.",
    ...overrides,
  };
}

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

/** The pieces one save runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  readonly clock: FakeClock;
  /** The save's input: this harness's pieces, plus any per-test override. */
  save(overrides?: Partial<MemorySaveInput>): Promise<MemorySaveResult>;
  /** The forget's input: the same pieces, for the note every save here writes. */
  forget(overrides?: Partial<MemoryForgetInput>): Promise<MemoryForgetResult>;
}

function harness(dir: string, script: Parameters<typeof makeMemoryProvider>[0] = {}): Harness {
  const logger = makeLogger();
  const clock = makeFakeClock();
  const store = createMemoryStore({ projectDir: join(dir, "projects", "project"), logger });
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
    forget: (overrides = {}) =>
      forgetMemoryNote({
        store,
        outbox,
        provider,
        logger,
        now: () => new Date(STAMP),
        timers: clock,
        scope: "project",
        slug: "replay-budget",
        reason: "superseded by replay-budget-v2",
        writeMode: "direct",
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

/** The outbox's one entry, asserted to be the only one. */
async function soleEntry(h: Harness): Promise<MemoryOutboxEntry> {
  const entries = await h.outbox.list();
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  assertDefined(entry, "outbox entry");
  return entry;
}

/** Run one save into the operation deadline, then read what it came to. */
async function saveIntoDeadline(h: Harness): Promise<MemorySaveResult> {
  const saving = h.save();
  // The probe's timer is cleared before the push: the one left armed is the operation's.
  await waitForCondition(() => h.provider.push.mock.calls.length === 1 && h.clock.pending() > 0, 5_000);
  await h.clock.advance(MEMORY_OP_TIMEOUT_MS);
  return await saving;
}

/** A sync asked for by this harness, with a provider whose calls the test can count. */
function syncWith(h: Harness, provider: MemoryProviderMock): ReturnType<typeof syncMemory> {
  return syncMemory({
    store: h.store,
    outbox: h.outbox,
    provider,
    logger: h.logger,
    now: () => new Date(STAMP),
    pid: PID,
    // A lock nobody's pid proves live is a stale one: this run takes it over.
    isAlive: () => false,
  });
}

describe("saveMemoryNote when the provider may have committed the write", () => {
  test("AC-5: a timed-out non-replayable save reports unknown delivery and holds its entry", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { replay: NON_REPLAYABLE_SAVES, push: "hang" });

      const result = await saveIntoDeadline(h);

      const stored = await mirrored(h);
      expect(result).toMatchObject({
        slug: "replay-budget",
        status: "active",
        delivered: false,
        pending: { clientId: stored.id, delivery: "unknown" },
      });
      const reason = result.pending?.reason;
      assertDefined(reason, "the reason the write is held");
      expect(reason).toContain(UNKNOWN_DELIVERY);
      // The entry is held, not queued: a queued write is one a later sync would send again.
      const entry = await soleEntry(h);
      expect(entry).toMatchObject({ clientId: stored.id, state: "uncertain" });
      // Its payload and its reason are both still on disk, for an operator to inspect.
      expect(entry.note).toEqual(stored);
      expect(entry.reason).toBe(reason);
      expect(h.clock.pending()).toBe(0);
    });
  });

  test("AC-5 (control): the same timeout on a replay-safe provider reports a write queued for sync", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: "hang" });

      const result = await saveIntoDeadline(h);

      const stored = await mirrored(h);
      expect(result).toMatchObject({
        slug: "replay-budget",
        status: "active",
        delivered: false,
        pending: { clientId: stored.id, delivery: "queued" },
      });
      expect(result.pending?.reason).toBeUndefined();
      // Repeating this write is safe, so it stays a queued write the next sync delivers.
      expect(await soleEntry(h)).toMatchObject({ clientId: stored.id, state: "queued" });
    });
  });

  test("AC-7: a write the probe never dispatched is queued as unsent and delivered by the next sync", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { replay: NON_REPLAYABLE_SAVES, reachable: false });

      const result = await h.save();

      const stored = await mirrored(h);
      // Nothing was dispatched, so nothing can have committed: the retry is the right answer.
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        slug: "replay-budget",
        delivered: false,
        pending: { clientId: stored.id, delivery: "queued" },
      });
      expect(await soleEntry(h)).toMatchObject({ clientId: stored.id, state: "queued" });
      const provider = makeMemoryProvider({});
      const run = await syncWith(h, provider);
      expect(run).toMatchObject({ outcome: "synced", pushed: 1 });
      expect(provider.push.mock.calls.map(([request]) => request.clientId)).toEqual([stored.id]);
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-5: a non-replayable push that fails after dispatch is unknown, not a queued retry", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { replay: NON_REPLAYABLE_SAVES, push: new Error("connection reset by peer") });

      const result = await h.save();

      const stored = await mirrored(h);
      // The request reached the provider and the answer did not: whether it was applied is unknown.
      expect(result).toMatchObject({ delivered: false, pending: { clientId: stored.id, delivery: "unknown" } });
      expect(result.pending?.reason).toContain("connection reset by peer");
      expect(await soleEntry(h)).toMatchObject({ clientId: stored.id, state: "uncertain" });
    });
  });

  test("AC-7: a pre-dispatch failure the provider marks leaves the write queued, not held", async () => {
    await withTempDir(async (dir) => {
      // The add could not be discovered or connected: nothing was written to the wire, so the
      // write is a definite unsent one even on a provider whose writes may not be repeated.
      const undispatched = markUndispatched(
        new NaxError("server is unavailable: no live connection", "MEMORY_MCP_UNAVAILABLE", { stage: "memory" }),
      );
      const h = harness(dir, { replay: NON_REPLAYABLE_SAVES, push: undispatched });

      const result = await h.save();

      const stored = await mirrored(h);
      expect(result).toMatchObject({ delivered: false, pending: { clientId: stored.id, delivery: "queued" } });
      expect(await soleEntry(h)).toMatchObject({ clientId: stored.id, state: "queued" });
      const provider = makeMemoryProvider({});
      const run = await syncWith(h, provider);
      expect(run).toMatchObject({ outcome: "synced", pushed: 1 });
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-8: a provider that discards the dispatch on the deadline leaves the timed-out save unsent", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { replay: NO_LATE_DISPATCH, push: "hang" });

      const result = await saveIntoDeadline(h);

      const stored = await mirrored(h);
      // Nothing can arrive after the deadline, so the write is definitely unsent, not unknown.
      expect(result).toMatchObject({ delivered: false, pending: { clientId: stored.id, delivery: "queued" } });
      expect(await soleEntry(h)).toMatchObject({ clientId: stored.id, state: "queued" });
    });
  });
});

describe("forgetMemoryNote when the provider may have carried the retire out", () => {
  test("AC-8: a timed-out non-replayable forget is held as unknown and the note is put back", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { replay: NON_REPLAYABLE_WRITES, push: "hang" });
      await h.store.writeNote(note());

      const forgetting = h.forget();
      await waitForCondition(() => h.provider.push.mock.calls.length === 1 && h.clock.pending() > 0, 5_000);
      await h.clock.advance(MEMORY_OP_TIMEOUT_MS);
      const result = await forgetting;

      const entry = await soleEntry(h);
      expect(result).toMatchObject({ delivered: false, pending: { clientId: entry.clientId, delivery: "unknown" } });
      expect(result.pending?.reason).toContain(UNKNOWN_DELIVERY);
      // A direct forget deleted the note when it queued the request, and whether the provider
      // retired it is exactly what is unknown: the note goes back rather than being assumed gone.
      expect(await h.store.readNote("project", "replay-budget")).toEqual(note());
      expect(entry).toMatchObject({ state: "uncertain", kind: "forget", slug: "replay-budget" });
      // The justification the forget carried is kept apart from the hold's own reason.
      expect(entry.requestReason).toBe("superseded by replay-budget-v2");
    });
  });
});
