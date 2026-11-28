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
import { describe, expect, spyOn, test } from "bun:test";
import {
  createMemoryOutbox,
  MEMORY_OP_TIMEOUT_MS,
  MEMORY_PUSH_MAX_BAD_RESPONSES,
  type MemoryReplayContract,
  type MemorySyncResult,
  syncMemory,
} from "@nathapp/nax-agent";
import {
  DRAIN_ANSWER_ACTIVE,
  DRAIN_ANSWER_DELETED,
  DRAIN_BAD_MESSAGE,
  DRAIN_FORGET_ID,
  DRAIN_MERGED_SLUG,
  DRAIN_NOT_SENT,
  DRAIN_REFUSAL_MESSAGE,
  DRAIN_SAVE_ID,
  DRAIN_SOURCE_SLUG,
  type MemoryDrainHarness,
  makeFakeClock,
  makeMemoryDrainHarness,
  memoryDrainBadResponse,
  memoryDrainDrain,
  memoryDrainEntryOf,
  memoryDrainForgetRequest,
  memoryDrainNote,
  memoryDrainPushed,
  memoryDrainPushedAt,
  memoryDrainRefusal,
  memoryDrainRefusedReplacement,
  memoryDrainSaveRequest,
  waitForCondition,
  withTempDir,
} from "#test/helpers/index";

describe("drainOutbox: a write waiting on a refused replacement", () => {
  test("AC-6: the awaiting forget never reaches the provider", async () => {
    await withTempDir(async (dir) => {
      const h = await memoryDrainRefusedReplacement(dir);

      await memoryDrainDrain(h);

      expect(memoryDrainPushed(h)).toEqual([`save:${DRAIN_MERGED_SLUG}`]);
    });
  });

  test("AC-7: the awaiting forget is rejected, naming the replacement it waits on", async () => {
    await withTempDir(async (dir) => {
      const h = await memoryDrainRefusedReplacement(dir);

      await memoryDrainDrain(h);

      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({
        state: "rejected",
        reason: DRAIN_NOT_SENT,
      });
      // The refusal is the record of a write that was never attempted: its own reason is kept.
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({
        requestReason: `merged into ${DRAIN_MERGED_SLUG}`,
      });
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_SAVE_ID)).toMatchObject({
        state: "rejected",
        reason: DRAIN_REFUSAL_MESSAGE,
      });
    });
  });

  test("AC-8: the drain counts both entries as rejected and reports no failure", async () => {
    await withTempDir(async (dir) => {
      const h = await memoryDrainRefusedReplacement(dir);

      const result = await memoryDrainDrain(h);

      expect(result).toEqual({ pushed: 0, rejected: 2, parked: [] });
      expect(result.failure).toBeUndefined();
    });
  });

  test("AC-22: the rejected forget rewinds its scope's pull cursor", async () => {
    await withTempDir(async (dir) => {
      const h = await memoryDrainRefusedReplacement(dir);
      const state = await h.store.readSyncState();
      await h.store.writeSyncState({ ...state, cursor: { project: "page-7", user: "page-2" } });

      await memoryDrainDrain(h);

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
      const h = makeMemoryDrainHarness(dir, { push: [DRAIN_ANSWER_ACTIVE, DRAIN_ANSWER_DELETED] });
      await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));

      const result = await memoryDrainDrain(h);

      expect(memoryDrainPushed(h)).toEqual([`save:${DRAIN_MERGED_SLUG}`, `forget:${DRAIN_SOURCE_SLUG}`]);
      expect(result).toEqual({ pushed: 2, rejected: 0, parked: [] });
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-21: the request the provider receives carries no awaits", async () => {
    await withTempDir(async (dir) => {
      const h = makeMemoryDrainHarness(dir, { push: [DRAIN_ANSWER_ACTIVE, DRAIN_ANSWER_DELETED] });
      await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
      const queued = await h.outbox.enqueue(
        memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID),
      );
      // The entry the queue holds really does wait on the save: the fixture is the rule under test.
      expect(queued.awaits).toBe(DRAIN_SAVE_ID);
      expect((await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).awaits).toBe(DRAIN_SAVE_ID);

      const result = await memoryDrainDrain(h);

      expect(memoryDrainPushed(h)).toEqual([`save:${DRAIN_MERGED_SLUG}`, `forget:${DRAIN_SOURCE_SLUG}`]);
      expect(result.pushed).toBe(2);
      // `awaits` is the queue's own bookkeeping, so it never becomes part of the provider's request.
      const request = memoryDrainPushedAt(h, 1);
      expect("awaits" in request).toBe(false);
      expect(Object.keys(request)).toEqual(["kind", "clientId", "scope", "slug", "writeMode", "reason"]);
    });
  });
});

describe("drainOutbox: what the outbox currently holds under an awaited id", () => {
  test("AC-10: an awaited entry already rejected from an earlier drain is never pushed again", async () => {
    await withTempDir(async (dir) => {
      const h = makeMemoryDrainHarness(dir, { push: DRAIN_ANSWER_DELETED });
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));
      // The state an earlier run left: the save was refused for good.
      await h.outbox.markRejected(DRAIN_SAVE_ID, DRAIN_REFUSAL_MESSAGE);

      const result = await memoryDrainDrain(h);

      expect(h.provider.push.mock.calls).toEqual([]);
      expect(result).toEqual({ pushed: 0, rejected: 1, parked: [] });
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({
        state: "rejected",
        reason: DRAIN_NOT_SENT,
      });
    });
  });

  test("AC-11: a dependency the outbox no longer holds leaves the entry to be pushed", async () => {
    await withTempDir(async (dir) => {
      const h = makeMemoryDrainHarness(dir, { push: DRAIN_ANSWER_DELETED });
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));

      const result = await memoryDrainDrain(h);

      expect(memoryDrainPushed(h)).toEqual([`forget:${DRAIN_SOURCE_SLUG}`]);
      expect(result).toEqual({ pushed: 1, rejected: 0, parked: [] });
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("an awaited entry still queued is waited for: not pushed, not counted, and kept for later", async () => {
    await withTempDir(async (dir) => {
      // The dependency is later in the queue than the write that waits on it, so it is still
      // queued when the drain reaches the forget: the forget waits, and the save follows it.
      const h = makeMemoryDrainHarness(dir, { push: [DRAIN_ANSWER_ACTIVE, DRAIN_ANSWER_DELETED] });
      await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));

      const result = await memoryDrainDrain(h);

      expect(memoryDrainPushed(h)).toEqual([`save:${DRAIN_MERGED_SLUG}`]);
      expect(result).toEqual({ pushed: 1, rejected: 0, parked: [] });
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({
        state: "queued",
        awaits: DRAIN_SAVE_ID,
      });
      // The save it waited on is gone now, so the next drain delivers the forget.
      expect(await memoryDrainDrain(h)).toEqual({ pushed: 1, rejected: 0, parked: [] });
      expect(memoryDrainPushed(h)).toEqual([`save:${DRAIN_MERGED_SLUG}`, `forget:${DRAIN_SOURCE_SLUG}`]);
    });
  });

  test("[B4] a replacement requeued while the drain runs stops refusing the write that waits on it", async () => {
    await withTempDir(async (dir) => {
      const h = makeMemoryDrainHarness(dir);
      h.provider.push.mockImplementation(async (request) => {
        if (request.clientId === DRAIN_SAVE_ID) throw memoryDrainRefusal();
        if (request.clientId === "client-other") {
          // `nax memory requeue` from another process: the refusal this drain remembers no longer
          // stands, so refusing the source's forget along with it would retire the source while
          // its replacement is still on its way.
          await h.outbox.requeue(DRAIN_SAVE_ID);
          return DRAIN_ANSWER_ACTIVE;
        }
        return DRAIN_ANSWER_DELETED;
      });
      await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote("budget-c"), "client-other"));
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));

      const result = await memoryDrainDrain(h);

      expect(result).toEqual({ pushed: 1, rejected: 1, parked: [] });
      // The forget waits, as it would for a replacement that was queued all along.
      expect(memoryDrainPushed(h)).toEqual([`save:${DRAIN_MERGED_SLUG}`, "save:budget-c"]);
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({
        state: "queued",
        awaits: DRAIN_SAVE_ID,
      });
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_SAVE_ID)).toMatchObject({ state: "queued" });
    });
  });

  test("[B4] a replacement a delivery removed in another process leaves nothing to wait for", async () => {
    await withTempDir(async (dir) => {
      const h = makeMemoryDrainHarness(dir);
      h.provider.push.mockImplementation(async (request) => {
        if (request.clientId === DRAIN_SAVE_ID) throw memoryDrainRefusal();
        if (request.clientId === "client-other") {
          // The outbox no longer holds the id, which is the answer a *delivered* replacement gives:
          // `settle` removes the entry it delivered, so the forget that waited on it is free to go.
          await h.outbox.remove(DRAIN_SAVE_ID);
          return DRAIN_ANSWER_ACTIVE;
        }
        return DRAIN_ANSWER_DELETED;
      });
      await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote("budget-c"), "client-other"));
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));

      const result = await memoryDrainDrain(h);

      expect(result).toEqual({ pushed: 2, rejected: 1, parked: [] });
      expect(memoryDrainPushed(h)).toEqual([
        `save:${DRAIN_MERGED_SLUG}`,
        "save:budget-c",
        `forget:${DRAIN_SOURCE_SLUG}`,
      ]);
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("M1: one drain reads the outbox once, however many entries wait on another", async () => {
    await withTempDir(async (dir) => {
      // A merge queues one save and one forget per source it folded. Every one of those forgets
      // asks the outbox the same question when the drain reaches it, so a drain of many sources
      // is where a fresh read per question shows.
      const h = makeMemoryDrainHarness(dir, {
        push: [DRAIN_ANSWER_ACTIVE, DRAIN_ANSWER_DELETED, DRAIN_ANSWER_DELETED, DRAIN_ANSWER_DELETED],
      });
      await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
      for (const slug of ["budget-c", "budget-d", "budget-e"]) {
        await h.outbox.enqueue(memoryDrainForgetRequest(slug, `client-${slug}`, DRAIN_SAVE_ID));
      }
      const list = spyOn(h.outbox, "list");
      const held = spyOn(h.outbox, "held");

      const result = await memoryDrainDrain(h);

      expect(list).toHaveBeenCalledTimes(1);
      expect(held).not.toHaveBeenCalled();
      expect(result).toMatchObject({ pushed: 4, rejected: 0, parked: [] });
      expect(await h.outbox.list()).toEqual([]);
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
  async function stuckReplacement(dir: string): Promise<MemoryDrainHarness> {
    const h = makeMemoryDrainHarness(dir, { push: [memoryDrainBadResponse(), DRAIN_ANSWER_DELETED] });
    await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
    await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
    await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));
    for (let count = 1; count < MEMORY_PUSH_MAX_BAD_RESPONSES; count += 1) {
      await h.outbox.recordBadResponse(DRAIN_SAVE_ID, DRAIN_BAD_MESSAGE);
    }
    return h;
  }

  test("AC-12: the awaiting forget is not pushed", async () => {
    await withTempDir(async (dir) => {
      const h = await stuckReplacement(dir);

      await memoryDrainDrain(h);

      expect(memoryDrainPushed(h)).toEqual([`save:${DRAIN_MERGED_SLUG}`]);
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({ state: "queued" });
    });
  });

  test("AC-13: the stuck save stays queued rather than parked as rejected", async () => {
    await withTempDir(async (dir) => {
      const h = await stuckReplacement(dir);

      const result = await memoryDrainDrain(h);

      const held = await memoryDrainEntryOf(h.outbox, DRAIN_SAVE_ID);
      expect(held.state).toBe("queued");
      expect(held.badResponses).toBe(MEMORY_PUSH_MAX_BAD_RESPONSES);
      expect(result.parked).toEqual([]);
    });
  });

  test("AC-14: the drain reports the failure instead of ending green", async () => {
    await withTempDir(async (dir) => {
      const h = await stuckReplacement(dir);

      const result = await memoryDrainDrain(h);

      expect(result).toMatchObject({ pushed: 0, rejected: 0, failure: DRAIN_BAD_MESSAGE });
      expect(result.answered).toBe(true);
    });
  });
});

/** A provider whose saves may not be repeated: a lost answer there may hide a commit. */
const NON_REPLAYABLE_SAVES: MemoryReplayContract = { nonReplayable: ["save"] };

/**
 * US-001: a replacement whose delivery is unknown.
 *
 * An `awaits` dependency has three states, and this is the third: the replacement was dispatched
 * and never answered, so it may or may not exist on the provider. Refusing this entry along with
 * it would retire a source on a guess, and delivering it would retire the source before the
 * replacement it was folded into is known to be there — so it waits, exactly as it does for a
 * replacement still on the queue, and keeps waiting across a reopened outbox.
 */
describe("drainOutbox: a retirement waiting on a replacement whose delivery is unknown", () => {
  test("AC-3: the retirement is not sent, and still waits after the outbox is reopened", async () => {
    await withTempDir(async (dir) => {
      const h = makeMemoryDrainHarness(dir, { replay: NON_REPLAYABLE_SAVES, push: "hang" });
      await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));
      const clock = makeFakeClock();
      const running = syncMemory(h.input({ timers: clock }));
      // The probe's timer is cleared before the push: the one left armed is the operation's.
      await waitForCondition(() => h.provider.push.mock.calls.length === 1 && clock.pending() > 0, 5_000);
      await clock.advance(MEMORY_OP_TIMEOUT_MS);
      const first = await running;
      expect(first.uncertain).toHaveLength(1);
      const reopened = createMemoryOutbox({ dir: h.store.paths.outboxDir });

      const result = await memoryDrainDrain(h, { outbox: reopened });

      // The replacement may exist on the provider; that is not permission to retire its source.
      expect(memoryDrainPushed(h)).toEqual([`save:${DRAIN_MERGED_SLUG}`]);
      expect(result).toMatchObject({ pushed: 0, rejected: 0, parked: [] });
      // The run does not touch the held save, and says it is still unresolved.
      expect(result.uncertain).toMatchObject([{ clientId: DRAIN_SAVE_ID, delivery: "unknown" }]);
      expect(await memoryDrainEntryOf(reopened, DRAIN_SAVE_ID)).toMatchObject({ state: "uncertain" });
      expect(await memoryDrainEntryOf(reopened, DRAIN_FORGET_ID)).toMatchObject({
        state: "queued",
        awaits: DRAIN_SAVE_ID,
      });
      // Neither entry is destroyed: an operator can still requeue or discard the held save.
      expect(await reopened.list()).toHaveLength(2);
    });
  });
});
