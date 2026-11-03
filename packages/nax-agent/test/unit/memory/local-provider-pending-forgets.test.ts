/**
 * The local provider's pending-forget record: a `proposal` forget is the one write the
 * mirror cannot carry out, so it is queued in `pending-forgets.jsonl` instead of acted
 * on — and a `direct` forget or a save of that key takes the entry back out, because the
 * mirror is what was asked for. The response of every write is unchanged by any of it:
 * a proposal forget still answers `{ id: clientId, status: "pending" }` and still leaves
 * the note where it was.
 *
 * The harness is the one `local-provider.test.ts` uses: a real store in a temp directory
 * and request builders of its own (they are file-private there, so they are copies).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  createLocalMemoryProvider,
  createMemoryStore,
  isMemoryPushRejected,
  type MemoryNote,
  type MemoryPendingForget,
  type MemoryProvider,
  type MemoryStore,
  type MemoryWriteRequest,
  NaxError,
} from "@nathapp/nax-agent";
import { assertNaxError, makeLogger, withTempDir } from "#test/helpers/index";

/** The example note from the memory-store design, with overrides. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    body: "The replay budget stays at 2,048 MiB. Next export append is due ~11-23.",
    ...overrides,
  };
}

/** One entry the record already holds, with overrides. */
function pendingForget(overrides: Partial<MemoryPendingForget> = {}): MemoryPendingForget {
  return {
    clientId: "client-recorded",
    scope: "project",
    slug: "replay-budget",
    reason: "the budget changed",
    ...overrides,
  };
}

/** A `save` write request carrying `saved`, ready to push. */
function saveRequest(saved: MemoryNote, overrides: Partial<Omit<MemoryWriteRequest, "note">> = {}): MemoryWriteRequest {
  return {
    kind: "save",
    clientId: "client-1",
    scope: saved.scope,
    slug: saved.slug,
    writeMode: "direct",
    note: saved,
    ...overrides,
  };
}

/** A `forget` write request for a slug, ready to push. */
function forgetRequest(overrides: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest {
  return {
    kind: "forget",
    clientId: "client-forget-1",
    scope: "project",
    slug: "replay-budget",
    writeMode: "direct",
    reason: "the budget doubled",
    ...overrides,
  };
}

/** The rejection of `promise`, or `null` when it resolves. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** How often the provider consulted the record: every write path reads it, and only a change writes it. */
interface RecordCalls {
  reads: number;
  writes: number;
}

/** The store with its record read and write observed: both still reach the real store. */
function observeRecord(store: MemoryStore): RecordCalls {
  const calls: RecordCalls = { reads: 0, writes: 0 };
  const read = store.readPendingForgets.bind(store);
  const write = store.writePendingForgets.bind(store);
  store.readPendingForgets = async () => {
    calls.reads += 1;
    return read();
  };
  store.writePendingForgets = async (entries) => {
    calls.writes += 1;
    await write(entries);
  };
  return calls;
}

/** The three write paths that rewrite the record, each already at the point of writing it. */
const RECORD_WRITE_PATHS: ReadonlyArray<{ path: string; request: () => MemoryWriteRequest }> = [
  { path: "a proposal forget", request: () => forgetRequest({ writeMode: "proposal" }) },
  { path: "a direct forget", request: () => forgetRequest() },
  { path: "a save", request: () => saveRequest(note()) },
];

describe("local provider pending forgets", () => {
  test("AC-9: a proposal forget of an invalid slug is a push rejection and records nothing", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);

      const error = await caught(provider.push(forgetRequest({ writeMode: "proposal", slug: "Bad_Slug" })));

      assertNaxError(error, "push of a proposal forget with an invalid slug");
      expect(error).toMatchObject({
        code: "MEMORY_PUSH_REJECTED",
        context: { stage: "memory", storeCode: "MEMORY_SLUG_INVALID" },
      });
      // Nothing was queued, and the record file was not even created.
      expect(await store.readPendingForgets()).toEqual([]);
      expect(existsSync(store.paths.pendingForgets)).toBe(false);
    });
  });

  test('AC-10: a forget request with no reason is recorded with reason ""', async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const reasonless: MemoryWriteRequest = {
        kind: "forget",
        clientId: "client-forget-1",
        scope: "project",
        slug: "replay-budget",
        writeMode: "proposal",
      };

      await provider.push(reasonless);

      expect(await store.readPendingForgets()).toEqual([
        { clientId: "client-forget-1", scope: "project", slug: "replay-budget", reason: "" },
      ]);
    });
  });

  test("AC-11: a proposal forget is queued, reported pending and leaves the note in place", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const saved = note();
      await provider.push(saveRequest(saved));
      const request = forgetRequest({
        clientId: "client-C",
        slug: "a",
        reason: "the note is out of date",
        writeMode: "proposal",
      });

      const result = await provider.push(request);

      // The answer is the one a proposal forget has always given.
      expect(result).toEqual({ id: "client-C", status: "pending" });
      expect(await store.listNotes("project")).toEqual([saved]);
      expect(await store.readPendingForgets()).toEqual([
        { clientId: "client-C", scope: "project", slug: "a", reason: "the note is out of date" },
      ]);
    });
  });

  test("AC-12: a second proposal forget of the same key replaces the first entry", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      await provider.push(
        forgetRequest({ clientId: "client-first", slug: "a", reason: "first", writeMode: "proposal" }),
      );

      await provider.push(
        forgetRequest({ clientId: "client-second", slug: "a", reason: "second", writeMode: "proposal" }),
      );

      expect(await store.readPendingForgets()).toEqual([
        { clientId: "client-second", scope: "project", slug: "a", reason: "second" },
      ]);
    });
  });

  test("AC-13: a proposal forget keeps the other keys' entries and appends its own", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const otherKey = pendingForget({ clientId: "client-b", slug: "b" });
      await store.writePendingForgets([otherKey]);

      await provider.push(
        forgetRequest({ clientId: "client-a", slug: "a", reason: "a is stale", writeMode: "proposal" }),
      );

      expect(await store.readPendingForgets()).toEqual([
        otherKey,
        { clientId: "client-a", scope: "project", slug: "a", reason: "a is stale" },
      ]);
    });
  });

  test("AC-14: a direct forget deletes the note and drops only its own entry", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const queued = pendingForget({ slug: "a" });
      const otherKey = pendingForget({ clientId: "client-b", slug: "b" });
      await store.writePendingForgets([queued, otherKey]);

      const result = await provider.push(forgetRequest({ slug: "a" }));

      expect(result).toEqual({ id: "client-forget-1", status: "deleted" });
      expect(await store.readPendingForgets()).toEqual([otherKey]);
    });
  });

  test("AC-15: a direct save drops the entry a queued forget of that key left", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      await store.writePendingForgets([pendingForget({ slug: "a" })]);

      const result = await provider.push(saveRequest(note({ slug: "a" })));

      expect(result).toEqual({ id: "mem_01J9X2", status: "active" });
      // Saving the slug again means it is wanted, so the queued forget is called off.
      expect(await store.readPendingForgets()).toEqual([]);
    });
  });

  test("AC-16: a proposal save drops the entry a queued forget of that key left", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      await store.writePendingForgets([pendingForget({ slug: "a" })]);

      const result = await provider.push(saveRequest(note({ slug: "a" }), { writeMode: "proposal" }));

      expect(result).toEqual({ id: "mem_01J9X2", status: "pending" });
      expect(await store.readPendingForgets()).toEqual([]);
    });
  });

  test("AC-17: a save of a key the record does not hold leaves every other entry as it was", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const queued = [
        pendingForget({ clientId: "client-b", slug: "b" }),
        pendingForget({ clientId: "client-c", slug: "c", reason: "c is stale" }),
      ];
      await store.writePendingForgets(queued);
      const before = await Bun.file(store.paths.pendingForgets).text();
      const calls = observeRecord(store);
      const provider = createLocalMemoryProvider(store);

      await provider.push(saveRequest(note({ slug: "a" })));

      // The save consults the record — a save is what calls off a queued forget — and,
      // finding no entry of its own to drop, leaves the file exactly as it was. A save
      // that skipped the record, rewrote it, or wrote it back unchanged all fail here.
      expect(calls.reads).toBe(1);
      expect(calls.writes).toBe(0);
      expect(await store.readPendingForgets()).toEqual(queued);
      expect(await Bun.file(store.paths.pendingForgets).text()).toBe(before);
    });
  });

  test("AC-18: a save on a mirror with no record file leaves the file absent", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const calls = observeRecord(store);
      const provider = createLocalMemoryProvider(store);
      const saved = note({ slug: "a" });

      const result = await provider.push(saveRequest(saved));

      // The save consulted the record and found nothing of its own to call off, so it
      // wrote nothing: a key the record does not hold leaves it alone, absent stays absent.
      expect(calls.reads).toBe(1);
      expect(calls.writes).toBe(0);
      expect(result).toEqual({ id: saved.id, status: "active" });
      expect(await store.readNote("project", saved.slug)).toEqual(saved);
      expect(existsSync(store.paths.pendingForgets)).toBe(false);
    });
  });

  test('AC-19: a record write that throws "disk full" reaches the caller as it is', async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const failure = new Error("disk full");
      store.writePendingForgets = async () => {
        throw failure;
      };

      const error = await caught(provider.push(forgetRequest({ writeMode: "proposal" })));

      // An I/O failure is retryable: the write stays queued and a later sync replays it.
      expect(error).toBe(failure);
      expect(isMemoryPushRejected(error)).toBe(false);
    });
  });

  test.each(RECORD_WRITE_PATHS.map((entry) => [entry.path, entry.request] as const))(
    "AC-23: push of %s rejects with the record's I/O error unchanged",
    async (_path, request) => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
        const provider = createLocalMemoryProvider(store);
        const write = request();
        // The key's entry has to be there: a path the record does not hold never writes it.
        await store.writePendingForgets([pendingForget({ scope: write.scope, slug: write.slug })]);
        // A permission error, not a refusal: nothing about a retry can be decided here.
        const failure = Object.assign(new Error("EACCES: permission denied, renamed"), { code: "EACCES" });
        store.writePendingForgets = async () => {
          throw failure;
        };

        const error = await caught(provider.push(write));

        expect(error).toBe(failure);
        expect(isMemoryPushRejected(error)).toBe(false);
        expect(error).not.toBeInstanceOf(NaxError);
      });
    },
  );

  test("a proposal forget on a mirror with no record leaves the note where it was", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider: MemoryProvider = createLocalMemoryProvider(store);
      const saved = note({ slug: "a" });
      await provider.push(saveRequest(saved));

      const result = await provider.push(forgetRequest({ slug: "a", writeMode: "proposal" }));

      // The note survives a proposal forget whether or not the record was ever written.
      expect(result).toEqual({ id: "client-forget-1", status: "pending" });
      expect(await store.readNote("project", "a")).toEqual(saved);
    });
  });
});
