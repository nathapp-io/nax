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
import { createMemoryOutbox, MEMORY_PUSH_MAX_BAD_RESPONSES } from "@nathapp/nax-agent";
import { _atomicWriteDeps } from "#src/internal/atomic-write";
import { _memoryStoreDeps } from "#src/memory/store";
import {
  DRAIN_ANSWER_DELETED,
  DRAIN_BAD_MESSAGE,
  DRAIN_FORGET_ID,
  DRAIN_MERGED_SLUG,
  DRAIN_REFUSAL_MESSAGE,
  DRAIN_SAVE_ID,
  DRAIN_SOURCE_SLUG,
  type MemoryDrainHarness,
  makeMemoryDrainHarness,
  memoryDrainBadResponse,
  memoryDrainDrain,
  memoryDrainEntryOf,
  memoryDrainForgetRequest,
  memoryDrainNote,
  memoryDrainPushed,
  memoryDrainSaveRequest,
  withTempDir,
} from "#test/helpers/index";

/** The reason a discard records on the retirements that waited on the write it dropped. */
const DISCARDED = `not sent: the replacement it waits on (${DRAIN_MERGED_SLUG}) was discarded`;

/**
 * B5: the replacement the operator discarded.
 *
 * `nax memory discard` drops a held write for good, so the outbox no longer holds the id the
 * merge's source retirements wait on — and the drain reads a vanished dependency as "delivered,
 * there is nothing left to wait for". That is the one reading the `awaits` link exists to prevent
 * when the delivery was never proven: the sources would be retired from the provider with nothing
 * in their place. So a discard refuses the writes that wait on it (and the writes that wait on
 * those) in the same lock that removes it, and they are `rejected` before any drain can read them.
 */
describe("drainOutbox: a retirement waiting on a discarded replacement", () => {
  /** The pair a merge stages: the replacement whose delivery is unknown, and the source's retire. */
  async function heldReplacement(dir: string): Promise<MemoryDrainHarness> {
    const h = makeMemoryDrainHarness(dir, { push: DRAIN_ANSWER_DELETED });
    await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
    await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
    await h.outbox.markUncertain(DRAIN_SAVE_ID, "delivery unknown: socket closed; not retried");
    await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));
    return h;
  }

  test("[B5] the discard refuses the retirement that waits on it, naming the replacement", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);

      const outcome = await h.outbox.discardUndelivered(DRAIN_SAVE_ID);

      expect(outcome.discarded).toBe(true);
      expect(outcome.refused.map((entry) => entry.clientId)).toEqual([DRAIN_FORGET_ID]);
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({
        state: "rejected",
        reason: DISCARDED,
      });
      // The forget's own justification is the queue's, and the refusal does not lose it.
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({
        requestReason: `merged into ${DRAIN_MERGED_SLUG}`,
      });
      expect(await h.outbox.held(DRAIN_SAVE_ID)).toBeUndefined();
    });
  });

  test("[B5] the next drain does not send the retirement, so the source stays on the provider", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      await h.outbox.discardUndelivered(DRAIN_SAVE_ID);

      const result = await memoryDrainDrain(h);

      expect(memoryDrainPushed(h)).toEqual([]);
      expect(result).toEqual({ pushed: 0, rejected: 0, parked: [] });
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({ state: "rejected" });
    });
  });

  test("a failed concurrent discard cannot hide a same-key hold from the snapshot", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      const original = await h.outbox.held(DRAIN_SAVE_ID);
      expect(original).toMatchObject({ state: "uncertain", note: memoryDrainNote(DRAIN_MERGED_SLUG) });
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_MERGED_SLUG, "client-ordinary"));
      const readdir = _memoryStoreDeps.readdir;
      const rename = _atomicWriteDeps.rename;
      const fault = new Error("refusal write failed");
      let first = true;
      let discard: Promise<unknown> | undefined;
      _atomicWriteDeps.rename = async (from, to) => {
        if (String(to).endsWith(`-${DRAIN_FORGET_ID}.json`)) throw fault;
        return rename(from, to);
      };
      _memoryStoreDeps.readdir = async (path, options) => {
        const names = await readdir(path, options);
        if (path === h.store.paths.outboxDir && first) {
          first = false;
          discard = h.outbox.discardUndelivered(DRAIN_SAVE_ID).catch((error) => expect(error).toBe(fault));
          if (!names.some((entry) => entry.name === ".outbox.lock")) await discard;
        }
        return names;
      };
      try {
        expect(await memoryDrainDrain(h)).toMatchObject({ pushed: 0 });
        await discard;
        expect(memoryDrainPushed(h)).toEqual([]);
      } finally {
        _memoryStoreDeps.readdir = readdir;
        _atomicWriteDeps.rename = rename;
      }
      const reopened = createMemoryOutbox({ dir: h.store.paths.outboxDir });
      expect(await reopened.held(DRAIN_SAVE_ID)).toEqual(original);
    });
  });

  test("an unreadable replacement cannot release its readable waiter", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      const open = _memoryStoreDeps.open;
      const fault = Object.assign(new Error("replacement unreadable"), { code: "EIO" });
      _memoryStoreDeps.open = async (path, flags) => {
        if (path.endsWith(`-${DRAIN_SAVE_ID}.json`)) throw fault;
        return open(path, flags);
      };
      try {
        await expect(memoryDrainDrain(h)).rejects.toThrow();
        expect(memoryDrainPushed(h)).toEqual([]);
      } finally {
        _memoryStoreDeps.open = open;
      }
    });
  });

  test("a discarded retirement cannot prove a bad-response head", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      const head = "client-head";
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote("head"), head));
      for (let count = 1; count < MEMORY_PUSH_MAX_BAD_RESPONSES; count += 1) {
        await h.outbox.recordBadResponse(head, DRAIN_BAD_MESSAGE);
      }
      const headEntry = await memoryDrainEntryOf(h.outbox, head);
      const waiter = await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID);
      h.provider.push.mockImplementation(async (request) => {
        if (request.clientId !== head) return DRAIN_ANSWER_DELETED;
        await h.outbox.discardUndelivered(DRAIN_SAVE_ID);
        throw memoryDrainBadResponse();
      });
      const result = await memoryDrainDrain(h, {
        outbox: { ...h.outbox, list: async () => [headEntry, waiter] },
      });
      expect(memoryDrainPushed(h)).toEqual(["save:head"]);
      expect(result).toMatchObject({ pushed: 0, parked: [] });
      expect(await h.outbox.held(head)).toMatchObject({ state: "queued" });
    });
  });

  test("a retirement read error aborts discard and the next drain still waits", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      const open = _memoryStoreDeps.open;
      const fault = Object.assign(new Error("retirement unreadable"), { code: "EIO" });
      _memoryStoreDeps.open = async (path, flags) => {
        if (path.endsWith(`-${DRAIN_FORGET_ID}.json`)) throw fault;
        return open(path, flags);
      };
      try {
        await expect(h.outbox.discardUndelivered(DRAIN_SAVE_ID)).rejects.toBe(fault);
      } finally {
        _memoryStoreDeps.open = open;
      }
      await memoryDrainDrain(h);
      expect(memoryDrainPushed(h)).toEqual([]);
      expect(await h.outbox.held(DRAIN_SAVE_ID)).toMatchObject({ state: "uncertain" });
      expect(await h.outbox.held(DRAIN_FORGET_ID)).toMatchObject({ state: "queued" });
    });
  });

  test("a claim read failure leaves the retirement untouched", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      const open = _memoryStoreDeps.open;
      _memoryStoreDeps.open = async (path, flags) => {
        if (path.endsWith(".claim")) throw new Error("claim unreadable");
        return open(path, flags);
      };
      try {
        expect(await h.outbox.discardUndelivered(DRAIN_SAVE_ID)).toEqual({ discarded: false, refused: [] });
      } finally {
        _memoryStoreDeps.open = open;
      }
      expect(await h.outbox.held(DRAIN_SAVE_ID)).toMatchObject({ state: "uncertain" });
      expect(await h.outbox.held(DRAIN_FORGET_ID)).toMatchObject({ state: "queued" });
    });
  });

  test("a discard after the drain's listing cancels the listed retirement", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      await h.outbox.markRejected(DRAIN_SAVE_ID, DRAIN_REFUSAL_MESSAGE);
      await memoryDrainDrain(h, {
        outbox: {
          ...h.outbox,
          list: async () => {
            const snapshot = await h.outbox.list();
            expect(await h.outbox.discardUndelivered(DRAIN_SAVE_ID)).toMatchObject({
              discarded: true,
              refused: [{ clientId: DRAIN_FORGET_ID }],
            });
            return snapshot;
          },
        },
      });
      expect(memoryDrainPushed(h)).toEqual([]);
      expect(await h.outbox.held(DRAIN_FORGET_ID)).toMatchObject({ state: "rejected", reason: DISCARDED });
    });
  });

  test("retrying discard completes a partially refused chain", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      const last = "client-chained";
      await h.outbox.enqueue(memoryDrainForgetRequest("budget-c", last, DRAIN_FORGET_ID));
      const rename = _atomicWriteDeps.rename;
      const fault = new Error("second refusal failed");
      _atomicWriteDeps.rename = async (from, to) => {
        if (String(to).endsWith(`-${last}.json`)) throw fault;
        return rename(from, to);
      };
      try {
        await expect(h.outbox.discardUndelivered(DRAIN_SAVE_ID)).rejects.toBe(fault);
      } finally {
        _atomicWriteDeps.rename = rename;
      }
      expect(await h.outbox.held(DRAIN_FORGET_ID)).toMatchObject({ state: "rejected" });
      expect(await h.outbox.held(last)).toMatchObject({ state: "queued" });
      expect(await h.outbox.discardUndelivered(DRAIN_SAVE_ID)).toMatchObject({
        discarded: true,
        refused: [{ clientId: DRAIN_FORGET_ID }, { clientId: last }],
      });
      expect(await h.outbox.held(last)).toMatchObject({ state: "rejected" });
      expect(await h.outbox.held(DRAIN_SAVE_ID)).toBeUndefined();
    });
  });

  test("a partial discard does not release retirements after the outbox is reopened", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      const second = "client-second";
      await h.outbox.enqueue(memoryDrainForgetRequest("budget-c", second, DRAIN_SAVE_ID));
      const rename = _atomicWriteDeps.rename;
      const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      _atomicWriteDeps.rename = async (from, to) => {
        if (String(to).endsWith(`-${second}.json`)) throw full;
        await rename(from, to);
      };
      try {
        await expect(h.outbox.discardUndelivered(DRAIN_SAVE_ID)).rejects.toBe(full);
      } finally {
        _atomicWriteDeps.rename = rename;
      }

      const reopened = createMemoryOutbox({ dir: h.store.paths.outboxDir });
      await memoryDrainDrain(h, { outbox: reopened });

      expect(memoryDrainPushed(h)).toEqual([]);
      expect(await reopened.held(DRAIN_SAVE_ID)).toMatchObject({ state: "uncertain" });
      expect(await reopened.held(DRAIN_FORGET_ID)).toMatchObject({ state: "rejected" });
      expect(await reopened.held(second)).toMatchObject({ state: "queued", awaits: DRAIN_SAVE_ID });
    });
  });

  test("[B5] a retirement waiting on a refused retirement is refused too", async () => {
    await withTempDir(async (dir) => {
      const h = await heldReplacement(dir);
      // A second-order wait: the queue chains, and the id a discard drops may be an entry that
      // waits on another. Releasing the chain one step down would undo the rule above.
      await h.outbox.enqueue(memoryDrainForgetRequest("budget-c", "client-chained", DRAIN_FORGET_ID));

      const outcome = await h.outbox.discardUndelivered(DRAIN_SAVE_ID);

      expect(outcome.refused.map((entry) => entry.clientId)).toEqual([DRAIN_FORGET_ID, "client-chained"]);
      expect(await memoryDrainEntryOf(h.outbox, "client-chained")).toMatchObject({ state: "rejected" });
      expect(memoryDrainPushed(h)).toEqual([]);
    });
  });

  test("[B5] a discard of a refused replacement refuses its retirements as well", async () => {
    await withTempDir(async (dir) => {
      const h = makeMemoryDrainHarness(dir, { push: DRAIN_ANSWER_DELETED });
      await h.store.writeNote(memoryDrainNote(DRAIN_MERGED_SLUG));
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
      await h.outbox.markRejected(DRAIN_SAVE_ID, DRAIN_REFUSAL_MESSAGE);
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));

      await h.outbox.discardUndelivered(DRAIN_SAVE_ID);
      const result = await memoryDrainDrain(h);

      // A refused replacement's retirement is normally refused by the drain itself; removing the
      // refusal it reads is the same loss, so the discard refuses it instead.
      expect(result.pushed).toBe(0);
      expect(memoryDrainPushed(h)).toEqual([]);
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({
        state: "rejected",
        reason: DISCARDED,
      });
    });
  });

  test("[B5] a queued write is never dropped, and nothing is refused for it", async () => {
    await withTempDir(async (dir) => {
      const h = makeMemoryDrainHarness(dir, { push: DRAIN_ANSWER_DELETED });
      await h.outbox.enqueue(memoryDrainSaveRequest(memoryDrainNote(DRAIN_MERGED_SLUG), DRAIN_SAVE_ID));
      await h.outbox.enqueue(memoryDrainForgetRequest(DRAIN_SOURCE_SLUG, DRAIN_FORGET_ID, DRAIN_SAVE_ID));

      expect(await h.outbox.discardUndelivered(DRAIN_SAVE_ID)).toEqual({ discarded: false, refused: [] });

      expect(await memoryDrainEntryOf(h.outbox, DRAIN_FORGET_ID)).toMatchObject({
        state: "queued",
        awaits: DRAIN_SAVE_ID,
      });
      expect(await memoryDrainEntryOf(h.outbox, DRAIN_SAVE_ID)).toMatchObject({ state: "queued" });
    });
  });
});
