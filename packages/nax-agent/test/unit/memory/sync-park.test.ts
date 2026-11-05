/**
 * Step 3 of a sync — parking an entry the provider keeps answering badly.
 *
 * A bad response is an answer the provider did get back but cannot use: a `NaxError` whose
 * code ends in `_BAD_RESPONSE`. Unlike an outage it repeats the same way every run, so the
 * outbox counts it on the entry. Below `MEMORY_PUSH_MAX_BAD_RESPONSES` the drain still stops
 * at that entry, exactly as for any transient failure: nothing overtakes it, and no pull runs.
 * At the limit the entry is parked as `rejected`, named on the result, and the drain carries
 * on. Timeouts, network errors and every other failure never count toward the limit.
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
