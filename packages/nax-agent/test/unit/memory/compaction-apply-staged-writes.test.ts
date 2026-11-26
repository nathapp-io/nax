/**
 * `applyMemoryCompaction`: the writes an apply stages, and what it records about them.
 *
 * Steps 4-8 are the half of an apply that changes the mirror, so every fact they produce is
 * read back from disk rather than taken from a result: the merged note's own fields, the
 * requests the outbox holds, the index the next session reads, the manifest and the log line.
 * The result is then checked *against* the manifest, because a caller told about a different
 * compaction than the file records is the failure that pair exists to rule out.
 *
 * The staged writes are pinned individually (a write mode, a client id, a reason), because
 * each of them is what a later sync delivers: an entry whose mode or reason drifted from what
 * a direct save or forget stages is a write a provider would receive differently from the one
 * the person confirmed.
 */
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemoryStore,
  type NaxError,
  parseMemoryNote,
  refreshMemoryIndex,
} from "@nathapp/nax-agent";
import {
  applyMemoryCompaction,
  MEMORY_COMPACTION_SOURCE,
  type MemoryCompactionApplyInput,
  type MemoryCompactionPlan,
  type MemoryCompactionResult,
} from "@nathapp/nax-agent/internal";
import type { MemoryCompactionManifest } from "#src/memory/compaction-archive";
import { assertDefined, assertNaxError, makeFakeClock, makeLogger, withTempDir } from "#test/helpers/index";

/** The instant every apply in these tests stamps with. */
const STAMP = "2026-11-25T10:15:00.000Z";
/** The id a test pins through the `newId` seam, so it can name the archive directory it expects. */
const FIXED_ID = "20261125T101500Z-3fa2c1";
/** The provider and model label an apply records in its manifest. */
const PROVIDER = "local";
const MODEL = "balanced";
/** The filled fraction of the index the caller measured before the model call. */
const FILL_BEFORE = 0.9;
/** The slug the standard fixture's merge writes, and the words it writes there. */
const MERGED_SLUG = "replay-budget";
const MERGED_DESCRIPTION = "replay budget stays 2,048 MiB";
const MERGED_BODY = "The replay budget stays at 2,048 MiB and is a ceiling, not a target.";
/** The note the standard fixture's plan retires, and the justification it carries. */
const RETIRED_SLUG = "stale-story-14";
const RETIRE_REASON = "story 14 shipped and the loop changed";
/** The two notes the standard fixture's first merge folds together, and the slug it writes. */
const SOURCE_A = "replay-budget-a";
const SOURCE_B = "replay-budget-b";
/** The second merge's pair, its target and its words: a plan applies every merge it holds. */
const SECOND_SOURCE_A = "cfg-lesson-a";
const SECOND_SOURCE_B = "cfg-lesson-b";
const SECOND_MERGED_SLUG = "cfg-lesson";
const SECOND_DESCRIPTION = "config lessons folded into one note";
const SECOND_BODY = "Every config lesson this project learned, folded into one note.";
/** The note no action names: the one that makes `notesAfter` a count, not a constant. */
const KEPT_SLUG = "unrelated";

/** One note of the mirror an apply acts on, with overrides. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: SOURCE_A,
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

/** The mirror every apply test starts from: two mergeable pairs, one to retire and one kept. */
function mirrorNotes(): MemoryNote[] {
  return [
    note({ id: "mem_a", slug: SOURCE_A }),
    note({ id: "mem_b", slug: SOURCE_B, description: "replay budget is a ceiling, not a target" }),
    note({ id: "mem_stale", slug: RETIRED_SLUG, description: "the retry loop changed in story 14" }),
    note({ id: "mem_kept", slug: KEPT_SLUG, description: "unrelated note" }),
    note({ id: "mem_cfg_a", slug: SECOND_SOURCE_A, description: "config lesson a" }),
    note({ id: "mem_cfg_b", slug: SECOND_SOURCE_B, description: "config lesson b" }),
  ];
}

/** The plan every apply test narrows from: one retire and two two-source merges, all valid. */
function plan(overrides: Partial<MemoryCompactionPlan> = {}): MemoryCompactionPlan {
  return {
    retire: [{ slug: RETIRED_SLUG, reason: RETIRE_REASON }],
    merge: [
      {
        from: [SOURCE_A, SOURCE_B],
        into: { slug: MERGED_SLUG, type: "project", description: MERGED_DESCRIPTION, body: MERGED_BODY },
      },
      {
        from: [SECOND_SOURCE_A, SECOND_SOURCE_B],
        into: { slug: SECOND_MERGED_SLUG, type: "project", description: SECOND_DESCRIPTION, body: SECOND_BODY },
      },
    ],
    ...overrides,
  };
}

/** Every note the standard plan takes off the mirror: the retire's slug and both pairs' sources. */
const REMOVED_SLUGS = [RETIRED_SLUG, SOURCE_A, SOURCE_B, SECOND_SOURCE_A, SECOND_SOURCE_B];

/** Every note the standard plan writes. */
const MERGED_SLUGS = [MERGED_SLUG, SECOND_MERGED_SLUG];

/** What the standard plan leaves in the mirror: the two merged notes and the note it never named. */
const SLUGS_AFTER = [SECOND_MERGED_SLUG, MERGED_SLUG, KEPT_SLUG];

/**
 * The plan whose merge keeps one of its own source slugs: the merged note *is* the note that
 * was already there, so that slug is the one source a merge must not forget.
 */
function selfMergePlan(): MemoryCompactionPlan {
  return plan({
    retire: [],
    merge: [
      {
        from: [SOURCE_A, SOURCE_B],
        into: { slug: SOURCE_A, type: "project", description: MERGED_DESCRIPTION, body: MERGED_BODY },
      },
    ],
  });
}

/** Everything one apply runs against, pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  /** The apply's input: this harness's pieces plus any per-test override. */
  apply(overrides?: Partial<MemoryCompactionApplyInput>): Promise<MemoryCompactionResult>;
}

/** A mirror holding {@link mirrorNotes}, the queue beside it, and an apply over both. */
async function harness(dir: string): Promise<Harness> {
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger: makeLogger() });
  for (const held of mirrorNotes()) await store.writeNote(held);
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const clock = makeFakeClock();
  return {
    store,
    outbox,
    apply: (overrides = {}) =>
      applyMemoryCompaction({
        store,
        outbox,
        logger: makeLogger(),
        plan: plan(),
        keepArchives: 5,
        provider: PROVIDER,
        model: MODEL,
        fillBefore: FILL_BEFORE,
        now: () => new Date(STAMP),
        timers: clock,
        ...overrides,
      }),
  };
}

/** The refusal an apply answered with; the test fails with its own words when it did not refuse. */
async function refusalOf(run: Promise<unknown>): Promise<NaxError> {
  try {
    await run;
  } catch (error) {
    assertNaxError(error, "the apply's refusal");
    return error;
  }
  throw new Error("the apply was expected to refuse and resolved instead");
}

/** One note of the mirror, which the test asserts is there before reading it. */
async function requiredNote(store: MemoryStore, slug: string): Promise<MemoryNote> {
  const held = await store.readNote("project", slug);
  assertDefined(held, `the mirror's note under "${slug}"`);
  return held;
}

/** The notes one compaction archived, decoded from the files it left in `<archiveDir>/<id>/notes`. */
async function archivedNotes(store: MemoryStore, id: string): Promise<MemoryNote[]> {
  const dir = join(store.paths.archiveDir, id, "notes");
  const decoded: MemoryNote[] = [];
  for (const name of await readdir(dir)) decoded.push(parseMemoryNote(await readFile(join(dir, name), "utf8")));
  return decoded;
}

/** The manifest one compaction left on disk. */
async function readManifest(store: MemoryStore, id: string): Promise<MemoryCompactionManifest> {
  const text = await readFile(join(store.paths.archiveDir, id, "manifest.json"), "utf8");
  return JSON.parse(text);
}

/** The outbox entries of one kind, in the sequence the queue took them. */
async function entriesOfKind(outbox: MemoryOutbox, kind: MemoryOutboxEntry["kind"]): Promise<MemoryOutboxEntry[]> {
  return (await outbox.list()).filter((entry) => entry.kind === kind);
}

/** The one queued request for `slug`; the test fails when the queue holds none or several. */
async function entryFor(
  outbox: MemoryOutbox,
  kind: MemoryOutboxEntry["kind"],
  slug: string,
): Promise<MemoryOutboxEntry> {
  const matching = (await entriesOfKind(outbox, kind)).filter((entry) => entry.slug === slug);
  expect(matching).toHaveLength(1);
  const [entry] = matching;
  assertDefined(entry, `the ${kind} entry for "${slug}"`);
  return entry;
}

/** The project index the next session reads. */
async function indexText(store: MemoryStore): Promise<string> {
  return await readFile(store.paths.index, "utf8");
}

describe("applyMemoryCompaction: the merged note", () => {
  test("AC-1: the merged note carries the compaction's source, the plan's words and the input clock", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply();

      const merged = await requiredNote(h.store, MERGED_SLUG);
      expect(merged.source).toBe(MEMORY_COMPACTION_SOURCE);
      expect(merged.status).toBe("active");
      expect(merged.scope).toBe("project");
      expect(merged.description).toBe(MERGED_DESCRIPTION);
      expect(merged.body).toBe(MERGED_BODY);
      expect(merged.updatedAt).toBe(STAMP);
    });
  });

  test("AC-2: the merged note's id differs from every archived note's id", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply({ newId: () => FIXED_ID });

      const merged = await requiredNote(h.store, MERGED_SLUG);
      const archived = await archivedNotes(h.store, FIXED_ID);
      const archivedSlugs = archived.map((original) => original.slug);
      expect(archivedSlugs).toHaveLength(REMOVED_SLUGS.length);
      for (const slug of REMOVED_SLUGS) expect(archivedSlugs).toContain(slug);
      for (const original of archived) expect(original.id).not.toBe(merged.id);
    });
  });

  test("AC-3: one save entry with writeMode direct per merged note, keyed by the merged note's id", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply();

      expect(await entriesOfKind(h.outbox, "save")).toHaveLength(MERGED_SLUGS.length);
      for (const slug of MERGED_SLUGS) {
        const merged = await requiredNote(h.store, slug);
        const save = await entryFor(h.outbox, "save", slug);
        expect(save.writeMode).toBe("direct");
        expect(save.clientId).toBe(merged.id);
        expect(save.scope).toBe("project");
        expect(save.note?.id).toBe(merged.id);
      }
    });
  });
});

describe("applyMemoryCompaction: the retired notes", () => {
  test("AC-4: the mirror holds no note under a retired slug", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply();

      expect(await h.store.readNote("project", RETIRED_SLUG)).toBeNull();
      const slugs = (await h.store.listNotes("project")).map((held) => held.slug);
      expect(slugs).not.toContain(RETIRED_SLUG);
    });
  });

  test("AC-5: one forget entry with writeMode direct, carrying the retire's reason", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply();

      const forget = await entryFor(h.outbox, "forget", RETIRED_SLUG);
      expect(forget.writeMode).toBe("direct");
      expect(forget.reason).toBe(RETIRE_REASON);
      expect(forget.scope).toBe("project");
    });
  });

  test("AC-6: a merge source whose slug differs from into.slug is gone from the mirror", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply();

      for (const slug of [SOURCE_A, SOURCE_B, SECOND_SOURCE_A, SECOND_SOURCE_B]) {
        expect(await h.store.readNote("project", slug)).toBeNull();
      }
      const slugs = (await h.store.listNotes("project")).map((held) => held.slug);
      expect(slugs).toEqual(SLUGS_AFTER);
    });
  });

  test("AC-7: that merge source's forget entry says which slug it was merged into", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply();

      for (const slug of [SOURCE_A, SOURCE_B]) {
        const forget = await entryFor(h.outbox, "forget", slug);
        expect(forget.writeMode).toBe("direct");
        expect(forget.reason).toBe(`merged into ${MERGED_SLUG}`);
      }
      for (const slug of [SECOND_SOURCE_A, SECOND_SOURCE_B]) {
        const forget = await entryFor(h.outbox, "forget", slug);
        expect(forget.reason).toBe(`merged into ${SECOND_MERGED_SLUG}`);
      }
    });
  });
});

describe("applyMemoryCompaction: a merge that keeps one of its own source slugs", () => {
  test("AC-8: the mirror holds the merged note under that slug", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply({ plan: selfMergePlan() });

      const merged = await requiredNote(h.store, SOURCE_A);
      expect(merged.slug).toBe(SOURCE_A);
      expect(merged.source).toBe(MEMORY_COMPACTION_SOURCE);
      expect(merged.status).toBe("active");
      expect(merged.body).toBe(MERGED_BODY);
    });
  });

  test("AC-9: the outbox holds no forget entry for that slug, and one for the source that went", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply({ plan: selfMergePlan() });

      const forgotten = (await entriesOfKind(h.outbox, "forget")).map((entry) => entry.slug);
      expect(forgotten).not.toContain(SOURCE_A);
      expect(forgotten).toEqual([SOURCE_B]);
    });
  });
});

describe("applyMemoryCompaction: the refreshed index", () => {
  test("AC-10: the project index lists the merged note's slug", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply();

      const text = await indexText(h.store);
      expect(text).toContain(`- [project] ${MERGED_SLUG} — ${MERGED_DESCRIPTION}`);
      expect(text).toContain(`- [project] ${SECOND_MERGED_SLUG} — ${SECOND_DESCRIPTION}`);
    });
  });

  test("AC-11: the project index lists no retired slug", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      await refreshMemoryIndex(h.store);
      expect(await indexText(h.store)).toContain(RETIRED_SLUG);

      await h.apply();

      const text = await indexText(h.store);
      expect(text).not.toContain(RETIRED_SLUG);
      for (const slug of [SOURCE_A, SOURCE_B, SECOND_SOURCE_A, SECOND_SOURCE_B]) expect(text).not.toContain(slug);
    });
  });
});

describe("applyMemoryCompaction: the manifest and the log", () => {
  test("AC-12: manifest.json is status applied", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply({ newId: () => FIXED_ID });

      const manifest = await readManifest(h.store, FIXED_ID);
      expect(manifest.status).toBe("applied");
    });
  });

  test("AC-13: the manifest's created lists the merged slug with the updatedAt it was written with", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply({ newId: () => FIXED_ID });

      const first = await requiredNote(h.store, MERGED_SLUG);
      const second = await requiredNote(h.store, SECOND_MERGED_SLUG);
      const manifest = await readManifest(h.store, FIXED_ID);
      expect(manifest.created).toMatchObject([
        { slug: MERGED_SLUG, updatedAt: first.updatedAt },
        { slug: SECOND_MERGED_SLUG, updatedAt: second.updatedAt },
      ]);
      expect(first.updatedAt).toBe(STAMP);
      expect(second.updatedAt).toBe(STAMP);
    });
  });

  test("AC-14: the manifest's notesAfter is the project-scope note count after the apply", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply({ newId: () => FIXED_ID });

      const manifest = await readManifest(h.store, FIXED_ID);
      expect(manifest.notesAfter).toBe((await h.store.listNotes("project")).length);
      expect(manifest.notesAfter).toBe(SLUGS_AFTER.length);
    });
  });

  test("AC-15: compactionsLog ends with one line carrying the plan's action counts", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      const applied = plan();

      await h.apply({ newId: () => FIXED_ID });

      const text = await readFile(h.store.paths.compactionsLog, "utf8");
      const lines = text.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      const [line] = lines;
      assertDefined(line, "the compactions log line");
      const logged: Record<string, unknown> = JSON.parse(line);
      expect(logged).toEqual({
        id: FIXED_ID,
        createdAt: STAMP,
        retired: applied.retire.length,
        merged: applied.merge.length,
        notesBefore: mirrorNotes().length,
        notesAfter: SLUGS_AFTER.length,
        fillBefore: FILL_BEFORE,
        undone: false,
      });
    });
  });
});

describe("applyMemoryCompaction: the result", () => {
  test("AC-16: the result's id, retired and merged match the manifest", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      const result = await h.apply({ newId: () => FIXED_ID });

      const manifest = await readManifest(h.store, FIXED_ID);
      expect(result.id).toBe(manifest.id);
      expect(result.retired).toEqual(manifest.retired);
      expect(result.merged).toEqual(manifest.merged);
      expect(result.retired).toEqual([RETIRED_SLUG]);
      expect(result.merged).toEqual([
        { from: [SOURCE_A, SOURCE_B], into: MERGED_SLUG },
        { from: [SECOND_SOURCE_A, SECOND_SOURCE_B], into: SECOND_MERGED_SLUG },
      ]);
    });
  });

  test("AC-17: the result's notesBefore and notesAfter equal the manifest's", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      const result = await h.apply({ newId: () => FIXED_ID });

      const manifest = await readManifest(h.store, FIXED_ID);
      const manifestNotesAfter = manifest.notesAfter;
      assertDefined(manifestNotesAfter, "the manifest's notesAfter");
      expect(result.notesBefore).toBe(manifest.notesBefore);
      expect(result.notesAfter).toBe(manifestNotesAfter);
      expect(result.notesBefore).toBe(mirrorNotes().length);
    });
  });
});

describe("applyMemoryCompaction: the package surface", () => {
  test("AC-18: applyMemoryCompaction is exported from @nathapp/nax-agent/internal", async () => {
    const entry: Record<string, unknown> = await import("@nathapp/nax-agent/internal");

    expect(typeof entry.applyMemoryCompaction).toBe("function");
    expect(entry.applyMemoryCompaction).toBe(applyMemoryCompaction);
  });
});

describe("applyMemoryCompaction: revalidation before the staged writes", () => {
  test("AC-19: a plan the mirror no longer matches refuses before a merged note or a request is staged", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      const confirmed = plan();
      const slugsBefore = (await h.store.listNotes("project")).map((held) => held.slug);
      await h.store.deleteNote("project", RETIRED_SLUG);

      const refusal = await refusalOf(h.apply({ plan: confirmed, newId: () => FIXED_ID }));

      expect(refusal.code).toBe("MEMORY_COMPACT_PLAN_INVALID");
      expect(await h.store.readNote("project", MERGED_SLUG)).toBeNull();
      expect(await h.outbox.list()).toHaveLength(0);
      const slugsAfter = (await h.store.listNotes("project")).map((held) => held.slug);
      expect(slugsAfter).toEqual(slugsBefore.filter((slug) => slug !== RETIRED_SLUG));
    });
  });
});
