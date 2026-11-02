import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createLocalMemoryProvider,
  createMemoryStore,
  isMemoryPushRejected,
  type MemoryNote,
  type MemoryProvider,
  type MemoryWriteRequest,
  NaxError,
} from "@nathapp/nax-agent";
import { _memoryStoreDeps } from "#src/memory/store";
import { assertNaxError, makeLogger, withDepsRestore, withTempDir } from "#test/helpers/index";

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

describe("createLocalMemoryProvider", () => {
  withDepsRestore(_memoryStoreDeps);

  test('AC-1: the provider id is "local" and it is always reachable', async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);

      expect(provider.id).toBe("local");
      await expect(provider.reachable()).resolves.toBe(true);
    });
  });

  test("AC-2: pull resolves an empty finished page with no nextCursor", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);

      const page = await provider.pull({ scope: "project", cursor: null, take: 10 });

      expect(page).toEqual({ notes: [], done: true });
      expect("nextCursor" in page).toBe(false);
    });
  });

  test("AC-3: a direct save writes the note active and reports it", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      // Handed over as pending: the write mode, not the note, decides the status.
      const saved = note({ status: "pending" });

      const result = await provider.push(saveRequest(saved));

      expect(result).toEqual({ id: saved.id, status: "active" });
      expect(await store.readNote("project", saved.slug)).toEqual({ ...saved, status: "active" });
    });
  });

  test("AC-4: a proposal save writes the note pending and reports it", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const saved = note();

      const result = await provider.push(saveRequest(saved, { writeMode: "proposal" }));

      expect(result).toEqual({ id: saved.id, status: "pending" });
      expect(await store.readNote("project", saved.slug)).toEqual({ ...saved, status: "pending" });
    });
  });

  test("AC-5: a save for an existing slug overwrites the stored note", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      await provider.push(saveRequest(note()));

      const updated = note({
        id: "mem_01J9X3",
        description: "replay budget is now 4,096 MiB",
        updatedAt: "2026-11-03T09:00:00.000Z",
      });
      const result = await provider.push(saveRequest(updated, { clientId: "client-2" }));

      expect(result).toEqual({ id: updated.id, status: "active" });
      const stored = await store.readNote("project", updated.slug);
      expect(stored?.description).toBe("replay budget is now 4,096 MiB");
      expect(await store.listNotes("project")).toHaveLength(1);
    });
  });

  test("AC-6: a direct forget deletes the note and reports the clientId", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      await provider.push(saveRequest(note()));
      const request = forgetRequest();

      const result = await provider.push(request);

      expect(result).toEqual({ id: request.clientId, status: "deleted" });
      expect(await store.readNote("project", request.slug)).toBeNull();
    });
  });

  test("AC-7: a proposal forget leaves the note in place and reports pending", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const saved = note();
      await provider.push(saveRequest(saved));
      const request = forgetRequest({ writeMode: "proposal" });

      const result = await provider.push(request);

      expect(result).toEqual({ id: request.clientId, status: "pending" });
      expect(await store.readNote("project", request.slug)).toEqual({ ...saved, status: "active" });
    });
  });

  test("AC-8: a save request without a note throws NaxError MEMORY_PUSH_REJECTED", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const noteless: MemoryWriteRequest = {
        kind: "save",
        clientId: "client-1",
        scope: "project",
        slug: "replay-budget",
        writeMode: "direct",
      };

      const error = await caught(provider.push(noteless));

      assertNaxError(error, "push of a save request without a note");
      expect(error).toMatchObject({ code: "MEMORY_PUSH_REJECTED", context: { stage: "memory" } });
      expect(error.message).toBe('memory save for "replay-budget" carries no note');
      expect(await store.listNotes("project")).toEqual([]);
    });
  });

  test("AC-8: a save for an invalid slug is a push rejection, not a transient failure", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const unsluggable = note({ slug: "Bad_Slug" });

      const error = await caught(provider.push(saveRequest(unsluggable)));

      assertNaxError(error, "push of a save with an invalid slug");
      expect(error).toMatchObject({
        code: "MEMORY_PUSH_REJECTED",
        context: { stage: "memory", storeCode: "MEMORY_SLUG_INVALID" },
      });
      // The reason is the store's own, and the original error is kept as the cause.
      expect(error.message).toContain("Bad_Slug");
      expect(error.context?.cause).toBeInstanceOf(NaxError);
      expect(await store.listNotes("project")).toEqual([]);
    });
  });

  test("AC-8: a save into an unavailable scope is a push rejection", async () => {
    await withTempDir(async (dir) => {
      // No userDir: nothing about retrying can make a user-scope write land here.
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const userNote = note({ scope: "user", slug: "workspace-layout" });

      const error = await caught(provider.push(saveRequest(userNote)));

      assertNaxError(error, "push of a user-scope save without a user directory");
      expect(error).toMatchObject({
        code: "MEMORY_PUSH_REJECTED",
        context: { stage: "memory", storeCode: "MEMORY_SCOPE_UNAVAILABLE" },
      });
      expect(existsSync(join(dir, "notes"))).toBe(false);
    });
  });

  test("AC-8: a forget for an invalid slug is a push rejection too", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);

      const error = await caught(provider.push(forgetRequest({ slug: "Bad_Slug" })));

      assertNaxError(error, "push of a forget with an invalid slug");
      expect(error).toMatchObject({
        code: "MEMORY_PUSH_REJECTED",
        context: { stage: "memory", storeCode: "MEMORY_SLUG_INVALID" },
      });
    });
  });

  test("AC-8: a transient store I/O failure propagates unchanged", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      const failure = Object.assign(new Error("EACCES: permission denied, mkdir"), { code: "EACCES" });
      _memoryStoreDeps.mkdir = async () => {
        throw failure;
      };

      const error = await caught(provider.push(saveRequest(note())));

      // Not a rejection: a retry may well succeed.
      expect(error).toBe(failure);
      expect(isMemoryPushRejected(error)).toBe(false);
    });
  });

  test("AC-9: the provider has no search property", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: dir, logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);

      expect(Object.keys(provider).sort()).toEqual(["id", "pull", "push", "reachable"]);
      expect("search" in provider).toBe(false);
      expect(provider.search).toBeUndefined();
    });
  });

  test("AC-10: the seam is public and any provider satisfies it through the type", async () => {
    expect(typeof createLocalMemoryProvider).toBe("function");

    // A consumer's own provider: no store, no nax internals, only the published contract.
    const calls: string[] = [];
    const scripted: MemoryProvider = {
      id: "scripted",
      pull: async (input) => {
        calls.push(`pull ${input.scope} ${String(input.cursor)} ${input.take}`);
        return { notes: [note({ status: "superseded" })], nextCursor: "c2", done: false };
      },
      push: async (request) => {
        calls.push(`push ${request.kind} ${request.clientId}`);
        return { id: request.clientId, status: "pending" };
      },
      reachable: async () => true,
    };

    expect(await scripted.reachable()).toBe(true);
    expect(await scripted.pull({ scope: "user", cursor: null, take: 5 })).toEqual({
      notes: [note({ status: "superseded" })],
      nextCursor: "c2",
      done: false,
    });
    expect(await scripted.push(forgetRequest({ writeMode: "proposal" }))).toEqual({
      id: "client-forget-1",
      status: "pending",
    });
    expect(calls).toEqual(["pull user null 5", "push forget client-forget-1"]);
  });
});
