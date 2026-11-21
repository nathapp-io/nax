/**
 * US-002: a recorded forget that names an older revision of a note does not retire the note
 * that replaced it.
 *
 * User notes are shared by every project, but the forget record is kept per project, so the
 * one sequence a single mirror cannot see is a second project refiling the note under the same
 * slug: project B saves `user/lang` again, the note gets a new id, and project A's record still
 * asks for the note it held when the forget was written. The revision the entry carries (US-001)
 * is what tells the two apart, and this file is the approval and the index reading it:
 *
 * - `approveMemoryNote` drops a stale entry from the record and then behaves as though no forget
 *   had been recorded — an active replacement comes back untouched, a `pending` one is put in
 *   force — while an entry that still names the held note retires it, as before.
 * - `refreshMemoryIndex` does not mark a note whose recorded entry names an older revision, and
 *   leaves the record itself alone.
 *
 * Both are driven through their production entry points over real stores and the local provider:
 * the fixture is two stores over one shared user directory and separate project directories, so
 * the entry the approval consumes is the one A's provider actually wrote and the note it is
 * compared against is the one B's provider actually replaced. A predicate-only test could pass
 * with neither call site wired.
 *
 * The controls pin what must not move: an entry without a revision keeps the old behaviour, a
 * note no refile replaced is still retired, an unreadable note read still leaves the marker up,
 * and a store with no user directory still renders its project index.
 */
import { describe, expect, test } from "bun:test";
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
  type MemoryNoteStatus,
  type MemoryPendingForget,
  type MemorySaveResult,
  type MemoryScope,
  type MemoryStore,
  refreshMemoryIndex,
  saveMemoryNote,
} from "@nathapp/nax-agent";
import { assertDefined, assertNaxError, makeLogger, withTempDir } from "#test/helpers/index";

/** The scope and slug both projects work on: one user note, shared by every project. */
const SCOPE: MemoryScope = "user";
const SLUG = "lang";
/** The bodies the two saves carry: which one the approval returns is what AC-1 reads. */
const ENGLISH = "Use English";
const FRENCH = "Use French";
/** The one-line description both revisions carry. */
const DESCRIPTION = "the user's preferred language";
/** A project-scope note the control cases render instead of the shared one. */
const PROJECT_SLUG = "replay-budget";
/** The justification A's forget carries; any accepted reason will do. */
const REASON = "the language changed";
/** The label every write is stored under. */
const SOURCE = "nax-chat";
/** A's first save: the revision A's forget names. */
const HELD_AT = "2026-11-01T09:00:00.000Z";
/** B's refile: the revision the approval has to find instead. */
const REFILED_AT = "2026-11-02T10:00:00.000Z";
/** The stamp an approval writes with, never a note's own, so a rewrite is visible. */
const APPROVED_AT = "2026-11-03T11:00:00.000Z";
/** An index entry line, matched as the type and slug it lists so a line is found by key. */
const ENTRY_PREFIX = "- [";

/** One note in the mirror's own shape, for the cases that write a status directly. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_held",
    slug: SLUG,
    type: "user",
    scope: SCOPE,
    description: DESCRIPTION,
    source: SOURCE,
    updatedAt: HELD_AT,
    status: "active",
    body: ENGLISH,
    ...overrides,
  };
}

/** One record entry, written directly by the cases that pin what the field's absence means. */
function recordedForget(slug: string, overrides: Partial<Omit<MemoryPendingForget, "clientId" | "slug">> = {}) {
  return { clientId: `client-${slug}`, scope: SCOPE, slug, reason: REASON, ...overrides };
}

/** The write modes a save is made in: `proposal` is the default, because that is the case. */
type WriteMode = "direct" | "proposal";

/** One project's view of the shared mirror: its store, and the three operations over it. */
interface Project {
  readonly store: MemoryStore;
  save(body: string, at: string, writeMode?: WriteMode): Promise<MemorySaveResult>;
  forget(): Promise<MemoryForgetResult>;
  approve(overrides?: Partial<MemoryApproveInput>): Promise<MemoryNote>;
}

/**
 * One project: a store over its own directory and the shared user directory, plus the outbox
 * and the local provider its writes go through — the production operations, not their parts.
 */
function projectOf(projectDir: string, userDir: string | null): Project {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir, userDir, logger });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir });
  const provider = createLocalMemoryProvider(store);
  return {
    store,
    save: (body, at, writeMode = "proposal") =>
      saveMemoryNote({
        store,
        outbox,
        provider,
        logger,
        now: () => new Date(at),
        writeMode,
        source: SOURCE,
        write: { slug: SLUG, type: "user", scope: SCOPE, description: DESCRIPTION, body },
      }),
    forget: () =>
      forgetMemoryNote({
        store,
        outbox,
        provider,
        logger,
        scope: SCOPE,
        slug: SLUG,
        reason: REASON,
        writeMode: "proposal",
      }),
    approve: (overrides = {}) =>
      approveMemoryNote({ store, now: () => new Date(APPROVED_AT), scope: SCOPE, slug: SLUG, ...overrides }),
  };
}

/** Two projects over one shared user directory: A records the forget, B refiles the note. */
function twoProjects(dir: string): { readonly a: Project; readonly b: Project } {
  const userDir = join(dir, "user");
  return { a: projectOf(join(dir, "a"), userDir), b: projectOf(join(dir, "b"), userDir) };
}

/** The index file of one scope, read as text. */
async function indexText(store: MemoryStore, scope: "project" | "user" = "project"): Promise<string> {
  const path = scope === "user" ? store.paths.userIndex : store.paths.index;
  assertDefined(path, `index path for the "${scope}" scope`);
  return await readFile(path, "utf8");
}

/** The one index line a note renders on, found by the prefix every note line starts with. */
function lineFor(text: string, type: string, slug: string): string {
  const line = text.split("\n").find((row) => row.startsWith(`${ENTRY_PREFIX}${type}] ${slug} `));
  assertDefined(line, `index line for "${slug}"`);
  return line;
}

/** The note A saved as `body`, asserted to be in the mirror. */
async function heldNote(project: Project, body: string): Promise<MemoryNote> {
  const held = await project.store.readNote(SCOPE, SLUG);
  assertDefined(held, `the "${SLUG}" note in the mirror`);
  expect(held.body).toBe(body);
  return held;
}

describe("approveMemoryNote and a record from before another project refiled the note", () => {
  test("AC-1: the approval returns the replacement note, in force", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();
      await b.save(FRENCH, REFILED_AT);

      const approved = await a.approve();

      // The recorded forget names the note A saved; B's refile minted a new id, so the note the
      // approval finds is a different one and is approved rather than retired.
      expect(approved.status).toBe("active");
      expect(approved.body).toBe(FRENCH);
    });
  });

  test("AC-2: the refiled note is active in the project that refiled it", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();
      await b.save(FRENCH, REFILED_AT);

      await a.approve();

      // The two stores share the user directory, so B reads the very note A put in force: an
      // approval that retired the note would leave B with nothing.
      expect(await b.store.readNote(SCOPE, SLUG)).toMatchObject({ status: "active", body: FRENCH });
    });
  });

  test("AC-3: (control) the stale entry is gone from the record the approval read", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();
      await b.save(FRENCH, REFILED_AT);

      const approved = await a.approve();

      // The entry is not merely ignored: it is taken out, so a later approval does not meet it
      // again and the index stops marking the note. Retiring the note would empty the record too,
      // so the empty record only means "the stale entry was removed" together with the approval
      // having answered the replacement: the retirement arm deletes that note and answers
      // `deleted`, which both assertions below rule out.
      expect(approved).toMatchObject({ status: "active", body: FRENCH });
      expect(await a.store.readNote(SCOPE, SLUG)).toMatchObject({ status: "active", body: FRENCH });
      expect(await a.store.readPendingForgets()).toEqual([]);
    });
  });

  test("AC-4: a direct refile leaves the approval an active note", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();
      await b.save(FRENCH, REFILED_AT, "direct");

      const approved = await a.approve();

      expect(approved.status).toBe("active");
    });
  });

  test("AC-5: that approval keeps the refiling save's updatedAt", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();
      await b.save(FRENCH, REFILED_AT, "direct");

      const approved = await a.approve();

      // An active note is returned as it stands, so its stamp still says when B wrote it rather
      // than when A approved it.
      expect(approved.updatedAt).toBe(REFILED_AT);
      expect(approved).toMatchObject({ body: FRENCH, status: "active" });
    });
  });

  test("AC-6: (control) a note another project approved keeps the recorded forget current", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "proposal");
      await a.forget();
      // B approves A's pending save: the same note, restamped — not a refile, so the id holds.
      await b.approve();

      const approved = await a.approve();

      // The revision is the id, not the stamp: project B approving the same note is not a new
      // note, so A's forget is still about the note the mirror holds and still retires it.
      expect(approved.status).toBe("deleted");
      expect(await a.store.readNote(SCOPE, SLUG)).toBeNull();
    });
  });

  test("AC-7: (control) nothing changed since the forget, so the approval still retires the note", async () => {
    await withTempDir(async (dir) => {
      const { a } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();

      const approved = await a.approve();

      expect(approved.status).toBe("deleted");
      expect(await a.store.readNote(SCOPE, SLUG)).toBeNull();
    });
  });

  test("AC-8: (control) an entry with no noteId keeps the behaviour it had: the note is retired", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      // An entry written before the field existed: it names no revision, so no refile is stale.
      await a.store.writePendingForgets([recordedForget(SLUG)]);
      await b.save(FRENCH, REFILED_AT);

      const approved = await a.approve();

      expect(approved.status).toBe("deleted");
      expect(await a.store.readNote(SCOPE, SLUG)).toBeNull();
    });
  });

  test("AC-9: a record write that throws rejects the approval and leaves the refiled note", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();
      await b.save(FRENCH, REFILED_AT);
      const failure = new Error("the record is read-only");
      const store: MemoryStore = {
        ...a.store,
        writePendingForgets: async () => {
          throw failure;
        },
      };

      const caught = await a.approve({ store }).catch((error: unknown) => error);

      // The error reaches the caller as it is — nothing about it is a refusal to report.
      expect(caught).toBe(failure);
      // And the note the approval would have approved is untouched: a record it could not
      // rewrite is not permission to delete a note that is not the one the entry names.
      const held = await heldNote(a, FRENCH);
      expect(held.status).toBe("pending");
    });
  });

  test("AC-10: the refreshed user index does not mark the refiled note", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();
      await b.save(FRENCH, REFILED_AT);

      await refreshMemoryIndex(a.store);

      // The marker is the record speaking, and the record is about a note that is gone.
      expect(lineFor(await indexText(a.store, "user"), "user", SLUG).endsWith(" (forget pending)")).toBe(false);
    });
  });

  test("AC-11: (control) the refreshed user index marks the note no refile replaced", async () => {
    await withTempDir(async (dir) => {
      const { a } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();

      await refreshMemoryIndex(a.store);

      expect(lineFor(await indexText(a.store, "user"), "user", SLUG).endsWith(" (forget pending)")).toBe(true);
    });
  });

  test("AC-12: (control) the refresh leaves the record as it found it", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      const held = await heldNote(a, ENGLISH);
      await a.forget();
      await b.save(FRENCH, REFILED_AT);
      const recorded = await a.store.readPendingForgets();
      // The entry the index has to judge: still naming the revision B replaced.
      expect(recorded).toEqual([expect.objectContaining({ scope: SCOPE, slug: SLUG, noteId: held.id })]);
      const before = await readFile(a.store.paths.pendingForgets, "utf8");

      await refreshMemoryIndex(a.store);

      // Rendering is a read of the record, never a rewrite of it: the entry is still A's to act on.
      expect(await a.store.readPendingForgets()).toEqual(recorded);
      expect(await readFile(a.store.paths.pendingForgets, "utf8")).toBe(before);
      expect(lineFor(await indexText(a.store, "user"), "user", SLUG).endsWith(" (forget pending)")).toBe(false);
    });
  });

  test("AC-13: (control) a user entry on a store with no user directory still refreshes the project index", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: join(dir, "a"), logger: makeLogger() });
      await store.writeNote(note({ scope: "project", type: "project", slug: PROJECT_SLUG, body: "4,096 MiB" }));
      await store.writePendingForgets([recordedForget(SLUG, { noteId: "mem_gone" })]);

      await refreshMemoryIndex(store);

      // A user-scope entry cannot be read on this store at all: the index is still written.
      const text = await indexText(store);
      expect(lineFor(text, "project", PROJECT_SLUG).endsWith(" (forget pending)")).toBe(false);
    });
  });

  const RETIRED: ReadonlyArray<readonly [string, MemoryNoteStatus | null]> = [
    ["no note at all", null],
    ["a superseded note", "superseded"],
    ["a rejected note", "rejected"],
    ["a deleted note", "deleted"],
  ];

  test.each(RETIRED)("AC-14: (control) %s is refused before the record is consulted", async (label, status) => {
    await withTempDir(async (dir) => {
      const project = projectOf(join(dir, "a"), join(dir, "user"));
      if (status !== null) await project.store.writeNote(note({ status }));
      await project.store.writePendingForgets([recordedForget(SLUG)]);
      let consulted = 0;
      const store: MemoryStore = {
        ...project.store,
        readPendingForgets: async () => {
          consulted += 1;
          throw new Error("the record must not be consulted");
        },
      };

      const caught = await project.approve({ store }).catch((error: unknown) => error);

      assertNaxError(caught, `an approval of ${label}`);
      expect(caught.code).toBe("MEMORY_NOTE_NOT_FOUND");
      // The refusal comes first, so the revision check that reads the record is never reached.
      expect(consulted).toBe(0);
    });
  });

  test("AC-15: (control) a record write that throws keeps the stale entry for the next approval", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      const held = await heldNote(a, ENGLISH);
      await a.forget();
      await b.save(FRENCH, REFILED_AT);
      const recorded = await a.store.readPendingForgets();
      expect(recorded).toEqual([expect.objectContaining({ scope: SCOPE, slug: SLUG, noteId: held.id })]);
      const store: MemoryStore = {
        ...a.store,
        writePendingForgets: async () => {
          throw new Error("the record is read-only");
        },
      };

      await a.approve({ store }).catch((error: unknown) => error);

      // The entry survives with the revision it carried: the next approval finds it stale again.
      expect(await a.store.readPendingForgets()).toEqual(recorded);
    });
  });

  test("AC-16: a retried approval finds that entry stale again and approves the replacement", async () => {
    await withTempDir(async (dir) => {
      const { a, b } = twoProjects(dir);
      await a.save(ENGLISH, HELD_AT, "direct");
      await a.forget();
      await b.save(FRENCH, REFILED_AT);
      const store: MemoryStore = {
        ...a.store,
        writePendingForgets: async () => {
          throw new Error("the record is read-only");
        },
      };
      await a.approve({ store }).catch((error: unknown) => error);

      // The same entry, read again against the same replacement note: still stale, so the retry
      // drops it and approves the note the mirror holds rather than retiring it.
      const approved = await a.approve();

      expect(approved.status).toBe("active");
      expect(approved.body).toBe(FRENCH);
    });
  });

  test("AC-17: (control) a note read that throws keeps the recorded entry's marker", async () => {
    await withTempDir(async (dir) => {
      const project = projectOf(join(dir, "a"), join(dir, "user"));
      await project.store.writeNote(
        note({ scope: "project", type: "project", slug: PROJECT_SLUG, description: DESCRIPTION, body: "4,096 MiB" }),
      );
      // An entry whose revision differs from the note's: stale, had the read answered at all.
      await project.store.writePendingForgets([
        recordedForget(PROJECT_SLUG, { scope: "project", noteId: "mem_other" }),
      ]);
      const store: MemoryStore = {
        ...project.store,
        readNote: async () => {
          throw new Error("the note could not be read");
        },
      };

      await refreshMemoryIndex(store);

      // An unanswerable read is not a stale revision: the marker stays up, as it did before the
      // record carried one, and the index is still written.
      expect(lineFor(await indexText(project.store), "project", PROJECT_SLUG).endsWith(" (forget pending)")).toBe(true);
    });
  });
});
