/**
 * US-001: a queued write that waits on another one (`awaits`).
 *
 * A merge stages one save for the note it wrote and one forget per source it folded. The
 * forgets must not reach the provider before the save is answered, because the answer is what
 * tells the sync whether the replacement exists at all: a refused replacement with delivered
 * source retirements leaves the provider holding nothing where the sources were.
 *
 * So an entry may name, in `awaits`, the client id it must not be delivered before, and the
 * drain reads the outbox's current state of that id at the moment it reaches the entry:
 *
 * - refused → this entry is marked `rejected` without being pushed, counted in `rejected`,
 *   and the scope's pull cursor is rewound (a rejected entry holds no key, so the provider's
 *   still-live sources come back through the next full pull);
 * - still `queued` → this entry waits: it is not pushed and not counted, and the drain carries
 *   on with the next entry;
 * - gone → the outbox no longer holds an entry under that id, so there is nothing to wait for
 *   and the entry is pushed as any other.
 *
 * `awaits` is queue bookkeeping, so it stops at the outbox: the `MemoryWriteRequest` a provider
 * receives is projected from the fields the two shapes share and carries none of it. The last
 * block pins the other half of the rule — a write stuck on bad responses is never proved by an
 * entry that waits on it, because that entry's answer says nothing about the stuck one.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  MEMORY_PUSH_MAX_BAD_RESPONSES,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemoryPushResult,
  type MemoryStore,
  type MemorySyncResult,
  NaxError,
  syncMemory,
} from "@nathapp/nax-agent";
import type { MemorySyncInput } from "#src/memory/index";
import { type DrainResult, drainOutbox, type MemoryDrainInput } from "#src/memory/sync-drain";
import {
  assertDefined,
  type MemoryProviderMock,
  type MemoryProviderScript,
  type MockLogger,
  makeLogger,
  makeMemoryProvider,
  withTempDir,
} from "#test/helpers/index";

/** The instant every injected clock reports. */
const STAMP = "2026-11-26T09:20:00.000Z";
/** The pid each sync claims as its own: never this process's, so a stale lock is taken over. */
const SYNC_PID = 5151;
/** The replacement a merge writes and the source it folds: the pair every case is about. */
const MERGED_SLUG = "budget-a";
const SOURCE_SLUG = "budget-b";
/** The client ids the two queued writes take, so `awaits` can name one before it exists on disk. */
const SAVE_ID = "client-save";
const FORGET_ID = "client-forget";
/** What a provider that took the save answers, and what it answers for a forget it carried out. */
const ANSWER_ACTIVE: MemoryPushResult = { id: "mem_remote_1", status: "active" };
const ANSWER_DELETED: MemoryPushResult = { id: "mem_doomed", status: "deleted" };
/** The rejection reason a refused replacement is recorded with. */
const REFUSAL_MESSAGE = "the replacement is not this project's to write";
/** The message a bad response carries: an answer that arrived but cannot be used. */
const BAD_MESSAGE = '[memory] koda POST memory answered a save for "budget-a" without an id';
/** The reason the drain records on a forget it never sent. */
const NOT_SENT = `not sent: the replacement it waits on (${MERGED_SLUG}) was refused`;

/** A project note of the mirror, with overrides. */
function note(slug: string, overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: `local-${slug}`,
    slug,
    type: "project",
    scope: "project",
    description: `note ${slug}`,
    source: "nax-chat",
    updatedAt: STAMP,
    status: "active",
    body: `Body of ${slug}.`,
    ...overrides,
  };
}

/** A `save` write request for `saved`, keyed by `clientId`. */
function saveRequest(saved: MemoryNote, clientId: string): Parameters<MemoryOutbox["enqueue"]>[0] {
  return { kind: "save", clientId, scope: "project", slug: saved.slug, writeMode: "direct", note: saved };
}

/** A `forget` write request, waiting on `awaits` when the test gives one. */
function forgetRequest(slug: string, clientId: string, awaits?: string): Parameters<MemoryOutbox["enqueue"]>[0] {
  return {
    kind: "forget",
    clientId,
    scope: "project",
    slug,
    writeMode: "direct",
    reason: `merged into ${MERGED_SLUG}`,
    ...(awaits === undefined ? {} : { awaits }),
  };
}

/** A provider's answer a permanent refusal is thrown as. */
function refusal(): NaxError {
  return new NaxError(REFUSAL_MESSAGE, "MEMORY_PUSH_REJECTED", { stage: "memory" });
}

/** A provider's answer a bad response is thrown as: it arrived, and it cannot be used. */
function badResponse(): NaxError {
  return new NaxError(BAD_MESSAGE, "MEMORY_KODA_BAD_RESPONSE", { stage: "memory", status: 200 });
}

/** The pieces one drain runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  /** The sync's input: this harness's pieces plus any per-test override. */
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
      // A lock nobody's pid proves live is a stale one: this run takes it over.
      isAlive: () => false,
      ...overrides,
    }),
  };
}

/** Step 3 alone, against this harness: a pull that follows it cannot mask what the drain did. */
function drain(h: Harness, overrides: Partial<MemoryDrainInput> = {}): Promise<DrainResult> {
  return drainOutbox({ store: h.store, outbox: h.outbox, provider: h.provider, logger: h.logger, ...overrides });
}

/** The slugs the provider was asked to push, as `<kind>:<slug>`, in call order. */
function pushed(h: Harness): string[] {
  return h.provider.push.mock.calls.map(([request]) => `${request.kind}:${request.slug}`);
}

/** The request the provider was asked to push at `index`, which the test asserts reached it. */
function pushedAt(h: Harness, index: number): Parameters<MemoryProviderMock["push"]>[0] {
  const call = h.provider.push.mock.calls[index];
  assertDefined(call, `the provider's push call ${index}`);
  return call[0];
}

/** The one entry the outbox holds under `clientId`. */
async function entryOf(outbox: MemoryOutbox, clientId: string): Promise<MemoryOutboxEntry> {
  const held = (await outbox.list()).find((entry) => entry.clientId === clientId);
  assertDefined(held, `the outbox entry "${clientId}"`);
  return held;
}

/**
 * The fixture the refused-replacement cases share: a queued save for the merged note and the
 * source forget that waits on it, with a provider that refuses the save for good.
 */
async function refusedReplacement(dir: string): Promise<Harness> {
  const h = harness(dir, { push: [refusal(), ANSWER_DELETED] });
  await h.store.writeNote(note(MERGED_SLUG));
  await h.outbox.enqueue(saveRequest(note(MERGED_SLUG), SAVE_ID));
  await h.outbox.enqueue(forgetRequest(SOURCE_SLUG, FORGET_ID, SAVE_ID));
  return h;
}

describe("drainOutbox: a write waiting on a refused replacement", () => {
  test("AC-6: the awaiting forget never reaches the provider", async () => {
    await withTempDir(async (dir) => {
      const h = await refusedReplacement(dir);

      await drain(h);

      expect(pushed(h)).toEqual([`save:${MERGED_SLUG}`]);
    });
  });

  test("AC-7: the awaiting forget is rejected, naming the replacement it waits on", async () => {
    await withTempDir(async (dir) => {
      const h = await refusedReplacement(dir);

      await drain(h);

      expect(await entryOf(h.outbox, FORGET_ID)).toMatchObject({ state: "rejected", reason: NOT_SENT });
      // The refusal is the record of a write that was never attempted: its own reason is kept.
      expect(await entryOf(h.outbox, FORGET_ID)).toMatchObject({ requestReason: `merged into ${MERGED_SLUG}` });
      expect(await entryOf(h.outbox, SAVE_ID)).toMatchObject({ state: "rejected", reason: REFUSAL_MESSAGE });
    });
  });

  test("AC-8: the drain counts both entries as rejected and reports no failure", async () => {
    await withTempDir(async (dir) => {
      const h = await refusedReplacement(dir);

      const result = await drain(h);

      expect(result).toEqual({ pushed: 0, rejected: 2, parked: [] });
      expect(result.failure).toBeUndefined();
    });
  });

  test("AC-22: the rejected forget rewinds its scope's pull cursor", async () => {
    await withTempDir(async (dir) => {
      const h = await refusedReplacement(dir);
      const state = await h.store.readSyncState();
      await h.store.writeSyncState({ ...state, cursor: { project: "page-7", user: "page-2" } });

      await drain(h);

      // The provider still holds both sources, and a rejected entry holds no key: only a pull
      // from the beginning brings them back into the mirror.
      const after = await h.store.readSyncState();
      expect(after.cursor).toEqual({ project: null, user: "page-2" });
      const run: MemorySyncResult = await syncMemory(h.input());
      expect(run.outcome).toBe("synced");
      expect(h.provider.pull.mock.calls[0]?.[0]).toMatchObject({ scope: "project", cursor: null });
    });
  });
});

describe("drainOutbox: a write waiting on a replacement the provider accepted", () => {
  test("AC-9 (control): the save is pushed, then the forget, and both leave the outbox", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: [ANSWER_ACTIVE, ANSWER_DELETED] });
      await h.store.writeNote(note(MERGED_SLUG));
      await h.outbox.enqueue(saveRequest(note(MERGED_SLUG), SAVE_ID));
      await h.outbox.enqueue(forgetRequest(SOURCE_SLUG, FORGET_ID, SAVE_ID));

      const result = await drain(h);

      expect(pushed(h)).toEqual([`save:${MERGED_SLUG}`, `forget:${SOURCE_SLUG}`]);
      expect(result).toEqual({ pushed: 2, rejected: 0, parked: [] });
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-21: the request the provider receives carries no awaits", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: [ANSWER_ACTIVE, ANSWER_DELETED] });
      await h.store.writeNote(note(MERGED_SLUG));
      await h.outbox.enqueue(saveRequest(note(MERGED_SLUG), SAVE_ID));
      const queued = await h.outbox.enqueue(forgetRequest(SOURCE_SLUG, FORGET_ID, SAVE_ID));
      // The entry the queue holds really does wait on the save: the fixture is the rule under test.
      expect(queued.awaits).toBe(SAVE_ID);
      expect((await entryOf(h.outbox, FORGET_ID)).awaits).toBe(SAVE_ID);

      const result = await drain(h);

      expect(pushed(h)).toEqual([`save:${MERGED_SLUG}`, `forget:${SOURCE_SLUG}`]);
      expect(result.pushed).toBe(2);
      // `awaits` is the queue's own bookkeeping, so it never becomes part of the provider's request.
      const request = pushedAt(h, 1);
      expect("awaits" in request).toBe(false);
      expect(Object.keys(request)).toEqual(["kind", "clientId", "scope", "slug", "writeMode", "reason"]);
    });
  });
});

describe("drainOutbox: what the outbox currently holds under an awaited id", () => {
  test("AC-10: an awaited entry already rejected from an earlier drain is never pushed again", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_DELETED });
      await h.outbox.enqueue(saveRequest(note(MERGED_SLUG), SAVE_ID));
      await h.outbox.enqueue(forgetRequest(SOURCE_SLUG, FORGET_ID, SAVE_ID));
      // The state an earlier run left: the save was refused for good.
      await h.outbox.markRejected(SAVE_ID, REFUSAL_MESSAGE);

      const result = await drain(h);

      expect(h.provider.push.mock.calls).toEqual([]);
      expect(result).toEqual({ pushed: 0, rejected: 1, parked: [] });
      expect(await entryOf(h.outbox, FORGET_ID)).toMatchObject({ state: "rejected", reason: NOT_SENT });
    });
  });

  test("AC-11: a dependency the outbox no longer holds leaves the entry to be pushed", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_DELETED });
      await h.outbox.enqueue(forgetRequest(SOURCE_SLUG, FORGET_ID, SAVE_ID));

      const result = await drain(h);

      expect(pushed(h)).toEqual([`forget:${SOURCE_SLUG}`]);
      expect(result).toEqual({ pushed: 1, rejected: 0, parked: [] });
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("an awaited entry still queued is waited for: not pushed, not counted, and kept for later", async () => {
    await withTempDir(async (dir) => {
      // The dependency is later in the queue than the write that waits on it, so it is still
      // queued when the drain reaches the forget: the forget waits, and the save follows it.
      const h = harness(dir, { push: [ANSWER_ACTIVE, ANSWER_DELETED] });
      await h.store.writeNote(note(MERGED_SLUG));
      await h.outbox.enqueue(forgetRequest(SOURCE_SLUG, FORGET_ID, SAVE_ID));
      await h.outbox.enqueue(saveRequest(note(MERGED_SLUG), SAVE_ID));

      const result = await drain(h);

      expect(pushed(h)).toEqual([`save:${MERGED_SLUG}`]);
      expect(result).toEqual({ pushed: 1, rejected: 0, parked: [] });
      expect(await entryOf(h.outbox, FORGET_ID)).toMatchObject({ state: "queued", awaits: SAVE_ID });
      // The save it waited on is gone now, so the next drain delivers the forget.
      expect(await drain(h)).toEqual({ pushed: 1, rejected: 0, parked: [] });
      expect(pushed(h)).toEqual([`save:${MERGED_SLUG}`, `forget:${SOURCE_SLUG}`]);
    });
  });
});

describe("drainOutbox: an awaiting write never proves a stuck one", () => {
  /**
   * The fixture the bad-response cases share: the save is one answer short of the limit and the
   * only other queued write is the forget that waits on it — so there is no write the provider
   * can be asked to answer for the stuck entry's sake. The provider would happily carry the
   * forget out, which is exactly what the rule has to prevent: a delivered retirement is not
   * evidence that the replacement it belongs to is storable.
   */
  async function stuckReplacement(dir: string): Promise<Harness> {
    const h = harness(dir, { push: [badResponse(), ANSWER_DELETED] });
    await h.store.writeNote(note(MERGED_SLUG));
    await h.outbox.enqueue(saveRequest(note(MERGED_SLUG), SAVE_ID));
    await h.outbox.enqueue(forgetRequest(SOURCE_SLUG, FORGET_ID, SAVE_ID));
    for (let count = 1; count < MEMORY_PUSH_MAX_BAD_RESPONSES; count += 1) {
      await h.outbox.recordBadResponse(SAVE_ID, BAD_MESSAGE);
    }
    return h;
  }

  test("AC-12: the awaiting forget is not pushed", async () => {
    await withTempDir(async (dir) => {
      const h = await stuckReplacement(dir);

      await drain(h);

      expect(pushed(h)).toEqual([`save:${MERGED_SLUG}`]);
      expect(await entryOf(h.outbox, FORGET_ID)).toMatchObject({ state: "queued" });
    });
  });

  test("AC-13: the stuck save stays queued rather than parked as rejected", async () => {
    await withTempDir(async (dir) => {
      const h = await stuckReplacement(dir);

      const result = await drain(h);

      const held = await entryOf(h.outbox, SAVE_ID);
      expect(held.state).toBe("queued");
      expect(held.badResponses).toBe(MEMORY_PUSH_MAX_BAD_RESPONSES);
      expect(result.parked).toEqual([]);
    });
  });

  test("AC-14: the drain reports the failure instead of ending green", async () => {
    await withTempDir(async (dir) => {
      const h = await stuckReplacement(dir);

      const result = await drain(h);

      expect(result).toMatchObject({ pushed: 0, rejected: 0, failure: BAD_MESSAGE });
      expect(result.answered).toBe(true);
    });
  });
});
