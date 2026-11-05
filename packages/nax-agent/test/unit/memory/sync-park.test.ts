/**
 * Step 3 of a sync — parking an entry the provider keeps answering badly.
 *
 * A bad response is an answer the provider did get back but cannot use: a `NaxError` whose
 * code ends in `_BAD_RESPONSE`. Unlike an outage it repeats the same way every run, so the
 * outbox counts it on the entry. Below `MEMORY_PUSH_MAX_BAD_RESPONSES` the drain still stops
 * at that entry, exactly as for any transient failure: nothing overtakes it, and no pull runs.
 * At the limit the entry is parked only once the provider has shown the fault is the entry's:
 * the next queued write for a different key is pushed, and only when the provider answers it
 * (delivered or refused) is the entry parked as `rejected`, named on the result, and the drain
 * carried on. When that write fails too, the failure is provider-wide — a contract mismatch
 * such as #2791 — and nothing is parked. Timeouts, network errors and every other failure
 * never count toward the limit.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  isMemoryBadResponse,
  MEMORY_PUSH_MAX_BAD_RESPONSES,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryPushResult,
  type MemoryStore,
  type MemoryWriteRequest,
  NaxError,
  syncMemory,
} from "@nathapp/nax-agent";
import type { MemorySyncInput } from "#src/memory/index";
import {
  type MemoryProviderMock,
  type MemoryProviderScript,
  makeLogger,
  makeMemoryProvider,
  withTempDir,
} from "#test/helpers/index";

const STAMP = "2026-11-05T09:20:00.000Z";
const SYNC_PID = 5151;
const ANSWER_ACTIVE: MemoryPushResult = { id: "mem_remote_1", status: "active" };
const BAD_MESSAGE = '[memory] koda POST memory answered a save for "replay-budget" without an id';

function badResponse(): NaxError {
  return new NaxError(BAD_MESSAGE, "MEMORY_KODA_BAD_RESPONSE", { stage: "memory", status: 200 });
}

function note(slug: string): MemoryNote {
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
  };
}

function forgetRequest(slug: string, clientId: string): MemoryWriteRequest {
  return { kind: "forget", clientId, scope: "project", slug, writeMode: "direct", reason: "no longer true" };
}

function saveRequest(slug: string, clientId: string): MemoryWriteRequest {
  return { kind: "save", clientId, scope: "project", slug, writeMode: "direct", note: note(slug) };
}

interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly input: MemorySyncInput;
}

function harness(dir: string, push: MemoryProviderScript["push"]): Harness {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const provider = makeMemoryProvider({ push });
  const input: MemorySyncInput = {
    store,
    outbox,
    provider,
    logger,
    now: () => new Date(STAMP),
    pid: SYNC_PID,
    isAlive: () => false,
  };
  return { store, outbox, provider, input };
}

/** The same failure `count` times, then whatever follows. */
function repeated<T>(step: T, count: number): T[] {
  return Array.from({ length: count }, () => step);
}

describe("isMemoryBadResponse", () => {
  test("a NaxError whose code ends in _BAD_RESPONSE is a bad response", () => {
    expect(isMemoryBadResponse(badResponse())).toBe(true);
    expect(isMemoryBadResponse(new NaxError("x", "MEMORY_BAD_RESPONSE", { stage: "memory" }))).toBe(true);
  });

  test("timeouts, outages, refusals and plain errors are not", () => {
    expect(isMemoryBadResponse(new NaxError("x", "MEMORY_KODA_TIMEOUT", { stage: "memory" }))).toBe(false);
    expect(isMemoryBadResponse(new NaxError("x", "MEMORY_KODA_UNREACHABLE", { stage: "memory" }))).toBe(false);
    expect(isMemoryBadResponse(new NaxError("x", "MEMORY_KODA_HTTP", { stage: "memory" }))).toBe(false);
    expect(isMemoryBadResponse(new NaxError("x", "MEMORY_PUSH_REJECTED", { stage: "memory" }))).toBe(false);
    expect(isMemoryBadResponse(new Error("MEMORY_KODA_BAD_RESPONSE"))).toBe(false);
  });
});

describe("syncMemory step 3 (parking a repeated bad response)", () => {
  test("below the limit a bad response stops the drain, keeps the entry queued and counts it", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, repeated(badResponse(), MEMORY_PUSH_MAX_BAD_RESPONSES - 1));
      await h.outbox.enqueue(forgetRequest("replay-budget", "client-f1"));
      await h.outbox.enqueue(saveRequest("export-window", "client-s1"));

      for (let run = 1; run < MEMORY_PUSH_MAX_BAD_RESPONSES; run += 1) {
        const result = await syncMemory(h.input);
        expect(result).toMatchObject({ outcome: "failed", pushed: 0, rejected: 0, error: BAD_MESSAGE });
        expect(result.parked).toBeUndefined();
        expect(await h.outbox.list()).toMatchObject([
          { clientId: "client-f1", state: "queued", badResponses: run, lastError: BAD_MESSAGE },
          { clientId: "client-s1", state: "queued" },
        ]);
      }
      // The entry behind it was never attempted, and no run pulled.
      expect(h.provider.push.mock.calls.map(([request]) => request.clientId)).toEqual(
        repeated("client-f1", MEMORY_PUSH_MAX_BAD_RESPONSES - 1),
      );
      expect(h.provider.pull).not.toHaveBeenCalled();
    });
  });

  test("at the limit the entry is parked as rejected, named on the result, and the drain continues", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, [...repeated(badResponse(), MEMORY_PUSH_MAX_BAD_RESPONSES), ANSWER_ACTIVE]);
      await h.store.writeNote(note("replay-budget"));
      await h.outbox.enqueue(forgetRequest("replay-budget", "client-f1"));
      await h.outbox.enqueue(saveRequest("export-window", "client-s1"));

      for (let run = 1; run < MEMORY_PUSH_MAX_BAD_RESPONSES; run += 1) await syncMemory(h.input);
      const result = await syncMemory(h.input);

      const reason = `parked after ${MEMORY_PUSH_MAX_BAD_RESPONSES} bad responses: ${BAD_MESSAGE}`;
      expect(result).toEqual({
        outcome: "synced",
        pushed: 1,
        rejected: 1,
        pulled: 0,
        skipped: 0,
        parked: [{ clientId: "client-f1", kind: "forget", scope: "project", slug: "replay-budget", reason }],
      });
      expect(await h.outbox.list()).toMatchObject([
        { clientId: "client-f1", state: "rejected", reason, requestReason: "no longer true" },
      ]);
      // A parked forget leaves the note where it was; the pull ran this time.
      expect(await h.store.readNote("project", "replay-budget")).toEqual(note("replay-budget"));
      expect(h.provider.pull).toHaveBeenCalled();
      // The parked entry is not pushed again.
      await syncMemory(h.input);
      expect(h.provider.push.mock.calls).toHaveLength(MEMORY_PUSH_MAX_BAD_RESPONSES + 1);
    });
  });

  test("a provider-wide bad response (#2791) never parks: the next key fails too", async () => {
    await withTempDir(async (dir) => {
      const runs = MEMORY_PUSH_MAX_BAD_RESPONSES + 2;
      // Every forget fails the same way, as when nax misread koda's lookup page.
      const h = harness(dir, repeated(badResponse(), runs * 2));
      await h.outbox.enqueue(forgetRequest("replay-budget", "client-f1"));
      await h.outbox.enqueue(forgetRequest("export-window", "client-f2"));

      for (let run = 0; run < runs; run += 1) {
        const result = await syncMemory(h.input);
        expect(result).toMatchObject({ outcome: "failed", rejected: 0, error: BAD_MESSAGE });
        expect(result.parked).toBeUndefined();
      }

      // Both stay queued; the proving write is never counted against its own entry.
      const entries = await h.outbox.list();
      expect(entries.map((entry) => entry.state)).toEqual(["queued", "queued"]);
      expect(entries[0]?.badResponses).toBe(runs);
      expect(entries[1]?.badResponses).toBeUndefined();
      expect(h.provider.pull).not.toHaveBeenCalled();
    });
  });

  test("an entry alone in the queue is never parked: nothing can prove the fault is its own", async () => {
    await withTempDir(async (dir) => {
      const runs = MEMORY_PUSH_MAX_BAD_RESPONSES + 1;
      const h = harness(dir, repeated(badResponse(), runs));
      await h.outbox.enqueue(forgetRequest("replay-budget", "client-f1"));

      for (let run = 0; run < runs; run += 1) expect((await syncMemory(h.input)).outcome).toBe("failed");

      expect(await h.outbox.list()).toMatchObject([{ clientId: "client-f1", state: "queued", badResponses: runs }]);
    });
  });

  test("the proving write skips later writes of the parked key, which then drain in order", async () => {
    await withTempDir(async (dir) => {
      const limit = MEMORY_PUSH_MAX_BAD_RESPONSES;
      const h = harness(dir, [...repeated(badResponse(), limit), ANSWER_ACTIVE, ANSWER_ACTIVE]);
      await h.outbox.enqueue(forgetRequest("replay-budget", "client-f1"));
      await h.outbox.enqueue(saveRequest("replay-budget", "client-s1"));
      await h.outbox.enqueue(saveRequest("export-window", "client-s2"));

      for (let run = 0; run < limit; run += 1) await syncMemory(h.input);

      // The proof is the first write for another key; the same-key save waits, then follows.
      const order = h.provider.push.mock.calls.map(([request]) => request.clientId);
      expect(order).toEqual([...repeated("client-f1", limit), "client-s2", "client-s1"]);
      expect(await h.outbox.list()).toMatchObject([{ clientId: "client-f1", state: "rejected" }]);
    });
  });

  test("a refusal of the proving write still proves the provider answers", async () => {
    await withTempDir(async (dir) => {
      const limit = MEMORY_PUSH_MAX_BAD_RESPONSES;
      const refusal = new NaxError("note kind not available", "MEMORY_PUSH_REJECTED", { stage: "memory" });
      const h = harness(dir, [...repeated(badResponse(), limit), refusal]);
      await h.outbox.enqueue(forgetRequest("replay-budget", "client-f1"));
      await h.outbox.enqueue(saveRequest("export-window", "client-s1"));

      for (let run = 1; run < limit; run += 1) await syncMemory(h.input);
      const result = await syncMemory(h.input);

      expect(result).toMatchObject({ outcome: "synced", pushed: 0, rejected: 2 });
      expect(result.parked?.map((entry) => entry.clientId)).toEqual(["client-f1"]);
      expect(await h.outbox.list()).toMatchObject([
        { clientId: "client-f1", state: "rejected" },
        { clientId: "client-s1", state: "rejected", reason: "note kind not available" },
      ]);
    });
  });

  test("timeouts and outages never count toward the limit", async () => {
    await withTempDir(async (dir) => {
      const outage = new NaxError("koda POST memory timed out after 4000ms", "MEMORY_KODA_TIMEOUT", {
        stage: "memory",
      });
      const runs = MEMORY_PUSH_MAX_BAD_RESPONSES + 1;
      const h = harness(dir, [...repeated(outage, runs - 1), new Error("connection reset by peer")]);
      const queued = await h.outbox.enqueue(saveRequest("export-window", "client-s1"));

      for (let run = 0; run < runs; run += 1) {
        expect((await syncMemory(h.input)).outcome).toBe("failed");
      }

      expect(await h.outbox.list()).toEqual([queued]);
    });
  });

  test("an outage between bad responses neither resets nor adds to the count", async () => {
    await withTempDir(async (dir) => {
      const outage = new Error("connection reset by peer");
      const h = harness(dir, [badResponse(), outage, badResponse()]);
      await h.outbox.enqueue(saveRequest("export-window", "client-s1"));

      for (let run = 0; run < 3; run += 1) await syncMemory(h.input);

      expect(await h.outbox.list()).toMatchObject([{ clientId: "client-s1", state: "queued", badResponses: 2 }]);
    });
  });
});

describe("outbox requeue", () => {
  test("puts a rejected entry back in the queue with its own reason and no count", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir, now: () => new Date(STAMP) });
      const taken = await outbox.enqueue(forgetRequest("replay-budget", "client-f1"));
      await outbox.recordBadResponse("client-f1", "first");
      await outbox.markRejected("client-f1", "parked after 3 bad responses: first");

      expect(await outbox.requeue("client-f1")).toBe(true);

      expect(await outbox.list()).toEqual([taken]);
      expect(await outbox.heldKeys("forget")).toEqual(new Set(["project/replay-budget"]));
    });
  });

  test("leaves a queued entry alone and answers false for one it does not hold", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir, now: () => new Date(STAMP) });
      const taken = await outbox.enqueue(saveRequest("export-window", "client-s1"));

      expect(await outbox.requeue("client-s1")).toBe(false);
      expect(await outbox.requeue("client-missing")).toBe(false);
      expect(await outbox.list()).toEqual([taken]);
    });
  });
});

describe("outbox recordBadResponse", () => {
  test("counts on the entry, keeps the last error, and returns the new count", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir, now: () => new Date(STAMP) });
      await outbox.enqueue(saveRequest("export-window", "client-s1"));

      expect(await outbox.recordBadResponse("client-s1", "first")).toBe(1);
      expect(await outbox.recordBadResponse("client-s1", "second")).toBe(2);

      expect(await outbox.list()).toMatchObject([{ state: "queued", badResponses: 2, lastError: "second" }]);
    });
  });

  test("an id the outbox does not hold counts nothing", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir, now: () => new Date(STAMP) });
      expect(await outbox.recordBadResponse("client-missing", "first")).toBe(0);
      expect(await outbox.list()).toEqual([]);
    });
  });
});
