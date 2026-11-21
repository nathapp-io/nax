/**
 * US-001: a recorded forget names the note revision it was aimed at.
 *
 * A `proposal` forget is the one write the mirror cannot carry out, so it is queued in
 * `pending-forgets.jsonl` for an approval that may run in another process — and possibly after
 * another project refiled the same slug. The entry therefore has to say *which* note it was
 * about, and the note's `id` is the value that answers that: every save stages a fresh
 * `randomUUID()`, while approving the same pending note elsewhere only restamps `updatedAt`.
 * `isStaleForget` is the predicate an approval and the index read (US-002); this file pins the
 * predicate, the record line that carries the revision, and the provider that writes it.
 *
 * The revision lookup is best-effort by design: a store that has no user directory cannot answer
 * a user-scope read at all, and a forget of such a key must still be recorded exactly as it was
 * before this field existed. That is why the recording cases below cover the null and throwing
 * answers as well as the held one.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createLocalMemoryProvider,
  createMemoryStore,
  type MemoryNote,
  type MemoryPendingForget,
  type MemoryWriteRequest,
  NaxError,
} from "@nathapp/nax-agent";
import { isStaleForget } from "#src/memory/forget-revision";
import { parsePendingForgetLine } from "#src/memory/records";
import { assertDefined, makeLogger, withTempDir } from "#test/helpers/index";

/** The id of the note the mirror held when the record was written. */
const HELD_ID = "note-a";
/** The id a refile gives the same slug: a new note, not a restamped one. */
const REFILED_ID = "note-b";
/** The slug the forget cases are about. */
const SLUG = "replay-budget";
/** The reason the queued entries carry; any accepted reason will do. */
const REASON = "the budget doubled";

/** The note the mirror holds at `SLUG`, with overrides. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: HELD_ID,
    slug: SLUG,
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    body: "The replay budget stays at 2,048 MiB.",
    ...overrides,
  };
}

/** One recorded forget, with overrides: the four fields every entry has always carried. */
function entry(overrides: Partial<MemoryPendingForget> = {}): MemoryPendingForget {
  return { clientId: "client-1", scope: "project", slug: SLUG, reason: REASON, ...overrides };
}

/** A `forget` write request for `SLUG`, ready to push. */
function forgetRequest(overrides: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest {
  return {
    kind: "forget",
    clientId: "client-1",
    scope: "project",
    slug: SLUG,
    writeMode: "proposal",
    reason: REASON,
    ...overrides,
  };
}

/** One recorded forget as the line it is written as. */
function lineOf(recorded: MemoryPendingForget): string {
  return JSON.stringify(recorded);
}

/** A project directory inside the case's own temp directory. */
function projectPath(dir: string): string {
  return join(dir, "project");
}

describe("isStaleForget", () => {
  test("AC-1: a note whose id differs from the entry's noteId is stale", () => {
    expect(isStaleForget(entry({ noteId: HELD_ID }), note({ id: REFILED_ID }))).toBe(true);
  });

  test("AC-2: a note restamped but not refiled is not stale", () => {
    // Approving the same pending note elsewhere rewrites updatedAt and keeps the id.
    const restamped = note({ id: HELD_ID, updatedAt: "2026-11-12T11:30:00.000Z" });

    expect(isStaleForget(entry({ noteId: HELD_ID }), restamped)).toBe(false);
  });

  test.each([HELD_ID, REFILED_ID])("AC-3: a legacy entry with no noteId is never stale (note %s)", (id) => {
    // A recorded forget written before this field existed keeps the behaviour it had.
    expect(isStaleForget(entry(), note({ id }))).toBe(false);
  });

  test("AC-4: a null note is never stale", () => {
    // The note being gone is the approval's `MEMORY_NOTE_NOT_FOUND` refusal, not a stale record.
    expect(isStaleForget(entry({ noteId: HELD_ID }), null)).toBe(false);
    expect(isStaleForget(entry(), null)).toBe(false);
  });
});

describe("the pending-forget record line", () => {
  test("AC-5: a line carrying noteId parses with that noteId", () => {
    const recorded = entry({ noteId: HELD_ID });

    expect(parsePendingForgetLine(lineOf(recorded))).toEqual(recorded);
  });

  test("AC-6: a line without noteId parses with no noteId field", () => {
    const legacy = entry();

    const parsed = parsePendingForgetLine(lineOf(legacy));

    expect(parsed).toEqual(legacy);
    // The field is absent, not present-and-undefined: a JSON round trip of it stays a legacy line.
    expect(assertDefined(parsed, "the parsed legacy entry")).not.toHaveProperty("noteId");
  });
});

describe("the local provider's recorded forget revision", () => {
  test("AC-7: a proposal forget of a held note records that note's id", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({
        projectDir: projectPath(dir),
        userDir: dir,
        logger: makeLogger(),
      });
      const held = note({ scope: "user", id: HELD_ID });
      await store.writeNote(held);
      const provider = createLocalMemoryProvider(store);

      await provider.push(forgetRequest({ scope: "user" }));

      expect(await store.readPendingForgets()).toEqual([
        { clientId: "client-1", scope: "user", slug: SLUG, reason: REASON, noteId: HELD_ID },
      ]);
    });
  });

  test("AC-8: a proposal forget of a slug the mirror does not hold records no noteId", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);

      const result = await provider.push(forgetRequest());

      // Nothing to name: the entry keeps the shape it had before the field existed.
      expect(result).toEqual({ id: "client-1", status: "pending" });
      expect(await store.readPendingForgets()).toEqual([entry()]);
    });
  });

  test("AC-9: a user-scope forget on a store with no user directory is recorded without noteId", async () => {
    await withTempDir(async (dir) => {
      // No userDir: the revision lookup cannot answer, and that must not refuse the forget.
      const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);

      const result = await provider.push(forgetRequest({ scope: "user" }));

      expect(result).toEqual({ id: "client-1", status: "pending" });
      expect(await store.readPendingForgets()).toEqual([{ ...entry(), scope: "user" }]);
    });
  });

  test("AC-10: a re-forget of the same key after a refile rewrites the entry with the new id", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
      await store.writeNote(note({ id: HELD_ID }));
      const provider = createLocalMemoryProvider(store);
      // One request pushed twice: same client id and reason, so only the revision differs.
      const request = forgetRequest();
      await provider.push(request);

      // The other project refiled the slug: a new note with a new id, not a restamp.
      await store.writeNote(note({ id: REFILED_ID }));
      await provider.push(request);

      expect(await store.readPendingForgets()).toEqual([{ ...entry(), noteId: REFILED_ID }]);
    });
  });

  test("AC-11: a throwing revision lookup records the entry without noteId", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
      const provider = createLocalMemoryProvider(store);
      store.readNote = async () => {
        throw new NaxError('memory scope "project" is unavailable', "MEMORY_SCOPE_UNAVAILABLE", {
          stage: "memory",
          scope: "project",
        });
      };

      const result = await provider.push(forgetRequest());

      // Exactly as before the lookup existed: the forget is recorded, without a revision.
      expect(result).toEqual({ id: "client-1", status: "pending" });
      expect(await store.readPendingForgets()).toEqual([entry()]);
    });
  });
});
