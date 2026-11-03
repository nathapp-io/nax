/**
 * US-002: an approval retires a note whose forget the mirror has recorded.
 *
 * A `proposal` forget is the one write the mirror cannot carry out, so the local provider
 * queues it in `pending-forgets.jsonl` and answers `pending`, leaving the note where it was.
 * The approval is what finally acts on it: `approveMemoryNote` reads the record inside its
 * locked section and, when the key it is asked about has an entry there, deletes the note,
 * takes that entry out of the record, regenerates the index and returns the note as it was
 * with `status: "deleted"`. A pending forget wins over a pending save, so that arm precedes
 * the activation of a `pending` note — while an absent note, or one already history, stays
 * the `MEMORY_NOTE_NOT_FOUND` refusal it always was. An approval with nothing recorded
 * behaves exactly as before: an active note comes back untouched and a pending one is put
 * in force.
 *
 * The unit cases drive the mirror and the record directly; the end-to-end cases run the
 * whole sequence over a real store and `createLocalMemoryProvider`, so the entry the
 * approval consumes is the one the provider actually wrote.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  approveMemoryNote,
  createLocalMemoryProvider,
  createMemoryOutbox,
  createMemoryStore,
  forgetMemoryNote,
  type MemoryApproveInput,
  type MemoryForgetResult,
  type MemoryNote,
  type MemoryPendingForget,
  type MemorySaveResult,
  type MemoryStore,
  saveMemoryNote,
} from "@nathapp/nax-agent";
import { assertDefined, assertNaxError, makeLogger, withTempDir } from "#test/helpers/index";

/** The instant every approval stamps with: `updatedAt` after a rewrite. */
const STAMP = "2026-11-12T11:30:00.000Z";
/** The stamp the note carried before the approval: what a retire must preserve. */
const ORIGINAL_STAMP = "2026-11-01T09:00:00.000Z";
/** The slug the recorded forget is about. */
const SLUG = "a";
/** A second slug: the key whose entry an approval has to leave alone, and whose note stays. */
const OTHER_SLUG = "b";
/** A slug the record knows about and the mirror does not hold at all. */
const GONE_SLUG = "gone";
/** The reason the end-to-end forget carries; any accepted reason will do. */
const REASON = "wrong";
/** The description both notes carry: one line, and what the index renders. */
const DESCRIPTION = "replay budget moves to 4,096 MiB";
/** What a store whose delete is broken reports. */
const DELETE_FAILURE = "delete failed";
/** An index entry line, captured as the slug it lists so a line is found by key not substring. */
const INDEX_ENTRY_RE = /^- \[[a-z]+\] ([a-z0-9-]+) /;

/** The note the mirror holds; `active` is the one a recorded forget has to retire. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_staged_1",
    slug: SLUG,
    type: "project",
    scope: "project",
    description: DESCRIPTION,
    source: "nax-chat",
    updatedAt: ORIGINAL_STAMP,
    status: "active",
    body: `${DESCRIPTION}.`,
    ...overrides,
  };
}

/** One entry the record holds for `slug`, in the shape the local provider writes. */
function pendingForget(slug: string, overrides: Partial<MemoryPendingForget> = {}): MemoryPendingForget {
  return { clientId: `client-${slug}`, scope: "project", slug, reason: REASON, ...overrides };
}

/** The pieces one approval runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  /** The approval's input: this harness's store, plus any per-test override. */
  approve(slug?: string, overrides?: Partial<MemoryApproveInput>): Promise<MemoryNote>;
}

function harness(dir: string): Harness {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  return {
    store,
    approve: (slug = SLUG, overrides = {}) =>
      approveMemoryNote({ store, now: () => new Date(STAMP), scope: "project", slug, ...overrides }),
  };
}

/** The index the store wrote, as the entries it lists: `<slug>` to the line that renders it. */
async function indexEntries(store: MemoryStore): Promise<ReadonlyMap<string, string>> {
  const text = await readFile(store.paths.index, "utf8");
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const slug = INDEX_ENTRY_RE.exec(line)?.[1];
    if (slug !== undefined) entries.set(slug, line);
  }
  return entries;
}

/** The one index line `slug` was rendered on, asserted to be there. */
async function indexLine(store: MemoryStore, slug: string): Promise<string> {
  const line = (await indexEntries(store)).get(slug);
  assertDefined(line, `index line for "${slug}"`);
  return line;
}

describe("approveMemoryNote and a recorded pending forget", () => {
  test("AC-1: an active note whose forget is recorded is retired, resolving deleted", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      await h.store.writePendingForgets([pendingForget(SLUG)]);

      const approved = await h.approve();

      expect(approved.slug).toBe(SLUG);
      expect(approved.status).toBe("deleted");
    });
  });

  test("AC-2: the retired note is gone from the mirror", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      await h.store.writePendingForgets([pendingForget(SLUG)]);

      await h.approve();

      expect(await h.store.readNote("project", SLUG)).toBeNull();
      expect(existsSync(join(h.store.paths.notesDir, `${SLUG}.md`))).toBe(false);
    });
  });

  test("AC-3: the retired note carries the updatedAt it had before the approval", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());

      await h.store.writePendingForgets([pendingForget(SLUG)]);

      const approved = await h.approve();

      // A retire is not a rewrite: the note goes as it was, so its stamp still says when it
      // was written rather than when it was retired.
      expect(approved.updatedAt).toBe(ORIGINAL_STAMP);
      expect(approved).toEqual({ ...note(), status: "deleted" });
    });
  });

  test("AC-4: the approval takes the key's entry out of the record", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      await h.store.writePendingForgets([pendingForget(SLUG)]);

      await h.approve();

      expect(await h.store.readPendingForgets()).toEqual([]);
    });
  });

  test("AC-5: the approval leaves the other keys' entries in the record", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const other = pendingForget(OTHER_SLUG);
      await h.store.writeNote(note());
      await h.store.writePendingForgets([pendingForget(SLUG), other]);

      await h.approve();

      // Only what was approved goes: another key's forget is still waiting for its own.
      expect(await h.store.readPendingForgets()).toEqual([other]);
    });
  });

  test("AC-6: the refreshed index no longer lists the retired slug", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      await h.store.writeNote(note({ id: "mem_staged_2", slug: OTHER_SLUG, description: "exports land before 09:00" }));
      await h.store.writePendingForgets([pendingForget(SLUG)]);

      await h.approve();

      const entries = await indexEntries(h.store);
      // The index is regenerated from a mirror the note has left, so the other note is what
      // remains — an index refreshed before the delete would still carry the retired slug.
      expect(entries.has(SLUG)).toBe(false);
      expect(entries.has(OTHER_SLUG)).toBe(true);
    });
  });

  test("AC-7: a pending note whose forget is recorded resolves deleted", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note({ status: "pending" }));
      await h.store.writePendingForgets([pendingForget(SLUG)]);

      const approved = await h.approve();

      // A pending forget wins over a pending save: the note is retired, not approved.
      expect(approved.status).toBe("deleted");
    });
  });

  test("AC-8: a pending note is gone from the mirror after the approval", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note({ status: "pending" }));
      await h.store.writePendingForgets([pendingForget(SLUG)]);

      await h.approve();

      expect(await h.store.readNote("project", SLUG)).toBeNull();
      expect(existsSync(join(h.store.paths.notesDir, `${SLUG}.md`))).toBe(false);
    });
  });

  test("AC-9: a recorded forget for a slug the mirror does not hold is MEMORY_NOTE_NOT_FOUND", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writePendingForgets([pendingForget(GONE_SLUG)]);

      const caught = await h.approve(GONE_SLUG).catch((error: unknown) => error);

      assertNaxError(caught, "approval of a recorded slug the mirror does not hold");
      expect(caught.code).toBe("MEMORY_NOTE_NOT_FOUND");
      expect(caught.context).toMatchObject({ stage: "memory", scope: "project", slug: GONE_SLUG });
    });
  });

  test("AC-10: the refused approval leaves the record as it was", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const recorded = pendingForget(GONE_SLUG);
      await h.store.writePendingForgets([recorded]);

      await h.approve(GONE_SLUG).catch((error: unknown) => error);

      // There was nothing to retire, so the entry keeps waiting for a note that may return.
      expect(await h.store.readPendingForgets()).toEqual([recorded]);
    });
  });

  test("AC-11: a delete that throws rejects the approval with that error", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      await h.store.writePendingForgets([pendingForget(SLUG)]);
      const failure = new Error(DELETE_FAILURE);
      const store: MemoryStore = {
        ...h.store,
        deleteNote: async () => {
          throw failure;
        },
      };

      const caught = await h.approve(SLUG, { store }).catch((error: unknown) => error);

      expect(caught).toBe(failure);
    });
  });

  test("AC-12: the failed approval leaves the record holding the entry", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const recorded = pendingForget(SLUG);
      await h.store.writeNote(note());
      await h.store.writePendingForgets([recorded]);
      const store: MemoryStore = {
        ...h.store,
        deleteNote: async () => {
          throw new Error(DELETE_FAILURE);
        },
      };

      const caught = await h.approve(SLUG, { store }).catch((error: unknown) => error);

      // The delete ran and rejected: what follows is the state it left, not a stale record.
      expect(caught).toBeInstanceOf(Error);
      // The note is still there, so the forget is still outstanding: the record is only
      // rewritten once the delete that retires the note has succeeded.
      expect(await h.store.readPendingForgets()).toEqual([recorded]);
      expect(await h.store.readNote("project", SLUG)).toEqual(note());
    });
  });

  test("AC-16: an active note with nothing recorded is returned unchanged", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const active = note();
      await h.store.writeNote(active);

      const approved = await h.approve();

      // No entry for the key: the approval is the ordinary one, and it rewrites nothing.
      expect(approved).toEqual(active);
      expect(approved.updatedAt).toBe(ORIGINAL_STAMP);
      expect(await h.store.readNote("project", SLUG)).toEqual(active);
      expect(await h.store.readPendingForgets()).toEqual([]);
    });
  });
});

/** The whole sequence over a real store and the local provider: save, forget, approve. */
interface EndToEnd {
  readonly store: MemoryStore;
  save(slug: string): Promise<MemorySaveResult>;
  forget(slug: string): Promise<MemoryForgetResult>;
  approve(slug: string): Promise<MemoryNote>;
}

function endToEnd(dir: string): EndToEnd {
  const logger = makeLogger();
  const now = () => new Date(STAMP);
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now });
  const provider = createLocalMemoryProvider(store);
  return {
    store,
    save: (slug) =>
      saveMemoryNote({
        store,
        outbox,
        provider,
        logger,
        now,
        writeMode: "direct",
        source: "nax-chat",
        write: { slug, type: "project", scope: "project", description: DESCRIPTION, body: `${DESCRIPTION}.` },
      }),
    forget: (slug) =>
      forgetMemoryNote({
        store,
        outbox,
        provider,
        logger,
        now,
        scope: "project",
        slug,
        reason: REASON,
        writeMode: "proposal",
      }),
    approve: (slug) => approveMemoryNote({ store, now, scope: "project", slug }),
  };
}

describe("approveMemoryNote over the local provider's recorded forget", () => {
  test("AC-13: a direct save then a proposal forget leaves the note active", async () => {
    await withTempDir(async (dir) => {
      const e2e = endToEnd(dir);
      await e2e.save(SLUG);

      await e2e.forget(SLUG);

      // The proposal is a request: the note the save wrote is still in the mirror.
      expect(await e2e.store.readNote("project", SLUG)).toMatchObject({ status: "active" });
      expect(await e2e.store.readPendingForgets()).toEqual([expect.objectContaining({ scope: "project", slug: SLUG })]);
    });
  });

  test("AC-14: the project index line for the slug ends with (forget pending)", async () => {
    await withTempDir(async (dir) => {
      const e2e = endToEnd(dir);
      await e2e.save(SLUG);

      await e2e.forget(SLUG);

      // The marker is the record speaking: the note itself is still active.
      expect((await indexLine(e2e.store, SLUG)).endsWith(" (forget pending)")).toBe(true);
    });
  });

  test("AC-15: approving that recorded forget leaves the mirror without the note", async () => {
    await withTempDir(async (dir) => {
      const e2e = endToEnd(dir);
      await e2e.save(SLUG);
      await e2e.forget(SLUG);

      const approved = await e2e.approve(SLUG);

      expect(approved.status).toBe("deleted");
      expect(await e2e.store.readNote("project", SLUG)).toBeNull();
      // The record the provider wrote is the record the approval consumed.
      expect(await e2e.store.readPendingForgets()).toEqual([]);
    });
  });
});
