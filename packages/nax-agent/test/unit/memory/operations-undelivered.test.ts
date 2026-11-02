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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  MEMORY_OP_TIMEOUT_MS,
  type MemoryNote,
  type MemoryNoteWrite,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryStore,
  NaxError,
  saveMemoryNote,
} from "@nathapp/nax-agent";
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

/** The mirrored note under the slug every save here writes, asserted to exist and be staged. */
async function staged(h: Harness): Promise<MemoryNote> {
  const stored = await h.store.readNote("project", "replay-budget");
  assertDefined(stored, "mirrored note");
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
