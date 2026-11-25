/**
 * `undoMemoryCompaction`: the notes it will not overwrite, and the refusals it answers instead.
 *
 * An undo puts notes back over a mirror that has moved on, so the check is about what the
 * mirror says now rather than what the archive says happened then. Two states mean the undo
 * would destroy somebody's work: a note the compaction created whose `updatedAt` has moved
 * since, and an archived slug the mirror holds a note under again that this compaction did not
 * write. `force` is the caller saying it knows.
 *
 * Every assertion is read back from disk — the mirror, the archive, the queue, the log —
 * rather than from the returned value, because "nothing was written" is the one answer a
 * result cannot show. The fixture is a real apply (`makeCompactionHarness`), never a
 * hand-written archive: an undo reads what an apply writes, and an archive the test spelled
 * itself would let both sides drift away from the format together while every assertion
 * stayed green.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryNote, MemoryOutboxEntry, NaxError } from "@nathapp/nax-agent";
import {
  _compactionArchiveDeps,
  claimSync,
  MEMORY_COMPACTION_ID_RE,
  type MemoryCompactionPlan,
  type MemoryUndoInput,
  type MemoryUndoResult,
  releaseSync,
  storeLockTargets,
  undoMemoryCompaction,
} from "@nathapp/nax-agent/internal";
import {
  assertDefined,
  assertNaxError,
  COMPACTION_ID,
  COMPACTION_STAMP,
  compactionManifest,
  makeCompactionHarness,
  withTempDir,
} from "#test/helpers/index";

type Harness = Awaited<ReturnType<typeof makeCompactionHarness>>;

/** The archive's own filesystem seams, kept so a test that records reads gives them back. */
const archiveDeps = { ..._compactionArchiveDeps };
afterEach(() => {
  Object.assign(_compactionArchiveDeps, archiveDeps);
});

/** The slugs the standard plan archives: the notes an undo has to put back. */
const ARCHIVED_SLUGS = ["retired", "source-a", "source-b"];
/** The slug the standard plan's merge wrote, and the note an undo has to take away. */
const MERGED_SLUG = "merged";
/** The `updatedAt` a note carries once something saved it after the compaction ran. */
const LATER_STAMP = "2026-12-01T09:00:00.000Z";
/** A name that is not a compaction id at all, which the archive is never allowed to spell a path from. */
const BAD_ID = "not-a-compaction-id";
/** One traversal, spelled as an id: what a caller types when it means a file outside the archive. */
const TRAVERSAL_ID = "../outside";
/** A well-formed id no compaction has ever used: the archive has no directory and the log no line. */
const UNKNOWN_ID = "20260101T000000Z-abcdef";
/** An archive directory copied beside the real one, whose manifest still names `COMPACTION_ID`. */
const OTHER_ID = "20261126T101500Z-cccccc";

/** One undo over a harness's mirror, with the harness's clock and timers unless overridden. */
function undo(h: Harness, overrides: Partial<MemoryUndoInput> = {}): Promise<MemoryUndoResult> {
  return undoMemoryCompaction({
    store: h.store,
    outbox: h.outbox,
    logger: h.logger,
    now: h.input.now,
    timers: h.input.timers,
    ...overrides,
  });
}

/** The refusal an undo answered with; the test fails in its own words when it did not refuse. */
async function refusalOf(run: Promise<unknown>): Promise<NaxError> {
  try {
    await run;
  } catch (error) {
    assertNaxError(error, "the undo's refusal");
    return error;
  }
  throw new Error("the undo was expected to refuse and resolved instead");
}

/** One note of the mirror, which the test asserts is there before reading it. */
async function requiredNote(h: Harness, slug: string): Promise<MemoryNote> {
  const held = await h.store.readNote("project", slug);
  assertDefined(held, `the mirror's note under "${slug}"`);
  return held;
}

/** The archived original of the harness's mirror under `slug`, which the test asserts exists. */
function originalOf(h: Harness, slug: string): MemoryNote {
  const original = h.originals.find((note) => note.slug === slug);
  assertDefined(original, `the harness's original note "${slug}"`);
  return original;
}

/** Save a note over the merged slug again, as a later session editing it would. */
async function changeMergedNote(h: Harness, slug = MERGED_SLUG): Promise<void> {
  await h.store.writeNote({
    ...(await requiredNote(h, slug)),
    body: "edited after the compaction",
    updatedAt: LATER_STAMP,
  });
}

/**
 * Everything the compactions log holds, byte for byte.
 *
 * The log is append-only history: an undo that touched a line it was not asked to touch has
 * changed the record of every compaction before it, which no result would show.
 */
async function logText(h: Harness): Promise<string> {
  return await readFile(h.store.paths.compactionsLog, "utf8");
}

/**
 * What the mirror, the queue, the log and the archive hold right now: the state a refusal may
 * not change.
 *
 * The archive is in it because a refusal that reached far enough to rewrite a manifest, or to
 * restore a note, would put an archive directory back that the pose had removed — a write no
 * note/queue comparison could see.
 */
interface DiskState {
  readonly notes: Record<string, MemoryNote>;
  readonly outbox: readonly MemoryOutboxEntry[];
  readonly log: string;
  readonly archive: readonly string[];
}

/** Read the whole observable state an undo could change, so a refusal can be checked against it. */
async function diskState(h: Harness): Promise<DiskState> {
  const notes: Record<string, MemoryNote> = {};
  for (const note of await h.store.listNotes("project")) notes[note.slug] = note;
  return {
    notes,
    outbox: await h.outbox.list(),
    log: await logText(h),
    archive: await archiveEntries(h),
  };
}

/** The archive directory's own entries, or none when the pose removed the directory. */
async function archiveEntries(h: Harness): Promise<string[]> {
  try {
    return (await readdir(h.store.paths.archiveDir)).sort();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * A plan whose two merges write two notes and retire none: two created notes, so a check that
 * names only the first change is visible as a missing slug rather than as a passing test.
 */
function twoMergePlan(): MemoryCompactionPlan {
  return {
    retire: [],
    merge: [
      {
        from: ["source-a", "source-b"],
        into: { slug: "merged-a", type: "project", description: "Combined a", body: "Combined body a" },
      },
      {
        from: ["retired", "unrelated"],
        into: { slug: "merged-b", type: "project", description: "Combined b", body: "Combined body b" },
      },
    ],
  };
}

/** The manifest file of the harness's compaction, as it sits on disk. */
function manifestPath(h: Harness): string {
  return join(h.store.paths.archiveDir, COMPACTION_ID, "manifest.json");
}

/**
 * Replace the archive module's reader with one that records the paths it is asked for, and
 * answer the reads with the module's own reader.
 *
 * `Object.assign` is what keeps this honest about the seam: the dep is Node's overloaded
 * `readFile`, and the archive only ever calls it as `readFile(path, "utf8")`, so a wrapper of
 * that one shape is the whole recording — there is no cast hiding a different contract.
 */
function recordArchiveReads(): string[] {
  const reads: string[] = [];
  const realRead = _compactionArchiveDeps.readFile;
  Object.assign(_compactionArchiveDeps, {
    readFile: async (path: string) => {
      reads.push(path);
      return await realRead(path, "utf8");
    },
  });
  return reads;
}

/** Rewrite the harness's manifest with `patch`, so a test can pose one of the crash windows. */
async function patchManifest(h: Harness, patch: Record<string, unknown>): Promise<void> {
  const manifest: Record<string, unknown> = JSON.parse(await readFile(manifestPath(h), "utf8"));
  await writeFile(manifestPath(h), `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`);
}

/** Run `work` with a sync of this process claimed on the mirror, then give the claim back. */
async function withSyncInFlight<T>(h: Harness, work: () => Promise<T>): Promise<T> {
  const [target] = storeLockTargets(h.store);
  assertDefined(target, "the mirror's first lock target");
  claimSync(target.path);
  try {
    return await work();
  } finally {
    releaseSync(target.path);
  }
}

describe("undoMemoryCompaction: force", () => {
  test("AC-5: with force it undoes a compaction whose merged note changed", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await changeMergedNote(h);
      // The same mirror refuses without it: `force` is the difference under test, not the
      // absence of a check.
      expect((await refusalOf(undo(h))).code).toBe("MEMORY_COMPACT_CHANGED");

      const result = await undo(h, { force: true });

      expect(result).toEqual({ id: COMPACTION_ID, restored: ARCHIVED_SLUGS, removed: [MERGED_SLUG] });
      expect(await h.store.readNote("project", MERGED_SLUG)).toBeNull();
      for (const slug of ARCHIVED_SLUGS) {
        expect((await requiredNote(h, slug)).body).toBe(originalOf(h, slug).body);
      }
      const [line] = (await logText(h)).trim().split("\n");
      assertDefined(line, "the compaction's log line");
      expect(JSON.parse(line)).toMatchObject({ id: COMPACTION_ID, undone: true });
    });
  });
});

describe("undoMemoryCompaction: a note changed since the compaction", () => {
  test("AC-1: refuses when a merged note's updatedAt differs from the manifest's created entry", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      expect((await compactionManifest(h)).created).toEqual([{ slug: MERGED_SLUG, updatedAt: COMPACTION_STAMP }]);
      await changeMergedNote(h);

      const refusal = await refusalOf(undo(h));

      expect(refusal.code).toBe("MEMORY_COMPACT_CHANGED");
    });
  });

  test("AC-2: the message names each changed slug", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply({ plan: twoMergePlan() });
      await changeMergedNote(h, "merged-a");
      await changeMergedNote(h, "merged-b");

      const refusal = await refusalOf(undo(h));

      expect(refusal.message).toContain("merged-a");
      expect(refusal.message).toContain("merged-b");
      // The notes that did *not* change are not accused: the message is what a person reads
      // to decide whether to run the undo again with `force`.
      expect(refusal.message).not.toContain("source-a");
      expect(refusal.message).not.toContain("source-b");
    });
  });

  test("AC-3: after the refusal the mirror, the outbox and the log are unchanged", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await changeMergedNote(h);
      const before = await diskState(h);

      await refusalOf(undo(h));

      expect(await diskState(h)).toEqual(before);
    });
  });

  test("AC-4: refuses when the mirror holds a note under an archived slug the compaction did not create", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // The merge targets of the manifest are the two notes this compaction created; "retired"
      // is not one of them, so a note under it can only have been written afterwards.
      await h.store.writeNote({
        ...originalOf(h, "retired"),
        id: "id-written-after-the-compaction",
        body: "written after the compaction",
        updatedAt: LATER_STAMP,
      });

      const refusal = await refusalOf(undo(h));

      expect(refusal.code).toBe("MEMORY_COMPACT_CHANGED");
      expect(refusal.message).toContain("retired");
    });
  });

  test("AC-6: treats a merged note absent from the mirror as unchanged", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // A merged note somebody already deleted is nothing the undo could overwrite.
      await h.store.deleteNote("project", MERGED_SLUG);

      const result = await undo(h);

      expect(result.id).toBe(COMPACTION_ID);
      expect(result.restored).toEqual(ARCHIVED_SLUGS);
      expect(result.removed).toEqual([]);
      for (const slug of ARCHIVED_SLUGS) expect(await h.store.readNote("project", slug)).not.toBeNull();
    });
  });

  test("M1: the check reads the mirror once, not once per note", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await changeMergedNote(h);
      // Two notes to judge: the created one, whose `updatedAt` moved, and an archived slug the
      // mirror holds again. Both are answered from the same listing.
      await h.store.writeNote({ ...originalOf(h, "retired"), updatedAt: LATER_STAMP });
      const reads = { list: 0, single: 0 };
      const counted = {
        ...h.store,
        listNotes: async (scope: Parameters<Harness["store"]["listNotes"]>[0]) => {
          reads.list += 1;
          return await h.store.listNotes(scope);
        },
        readNote: async (scope: Parameters<Harness["store"]["readNote"]>[0], slug: string) => {
          reads.single += 1;
          return await h.store.readNote(scope, slug);
        },
      };

      // The refusal happens before any write, so every read it took is the check's own.
      const refusal = await refusalOf(undo(h, { store: counted }));

      expect(refusal.code).toBe("MEMORY_COMPACT_CHANGED");
      expect(refusal.context?.slugs).toEqual(["merged", "retired"]);
      expect(reads).toEqual({ list: 1, single: 0 });
    });
  });
});

describe("undoMemoryCompaction: no target to undo", () => {
  test("AC-7: refuses when no log line is left with undone false", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await undo(h);
      // One line is left, and it says the compaction it names was already undone.
      const [line] = (await logText(h)).trim().split("\n");
      assertDefined(line, "the compaction's log line");
      expect(JSON.parse(line)).toMatchObject({ id: COMPACTION_ID, undone: true });

      const refusal = await refusalOf(undo(h));

      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
    });
  });

  test("AC-8: refuses for an id that does not match MEMORY_COMPACTION_ID_RE", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      expect(MEMORY_COMPACTION_ID_RE.test(BAD_ID)).toBe(false);

      const refusal = await refusalOf(undo(h, { id: BAD_ID }));

      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
    });
  });

  test("AC-9: for an id of ../outside it reads no file outside archiveDir", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // A well-formed manifest one directory above the archive, exactly where "../outside"
      // would resolve. It is there to be read by a traversal, so the assertion below is about
      // the read rather than about a file that happened to be missing.
      const outside = join(h.store.paths.projectDir, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "manifest.json"), await readFile(manifestPath(h), "utf8"));
      const reads = recordArchiveReads();

      const refusal = await refusalOf(undo(h, { id: TRAVERSAL_ID }));

      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
      // The log is the one file an undo reads outside archiveDir by design; nothing else is.
      const outsideReads = reads.filter(
        (path) => !path.startsWith(h.store.paths.archiveDir) && path !== h.store.paths.compactionsLog,
      );
      expect(outsideReads).toEqual([]);
    });
  });

  test("AC-10: refuses for an id whose log line already has undone true", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await undo(h, { id: COMPACTION_ID });

      const refusal = await refusalOf(undo(h, { id: COMPACTION_ID }));

      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
    });
  });

  test("AC-10: the undone log line alone is enough, even with a manifest that still says applied", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await undo(h, { id: COMPACTION_ID });
      await patchManifest(h, { status: "applied" });

      const refusal = await refusalOf(undo(h, { id: COMPACTION_ID }));

      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
    });
  });

  test("AC-11: refuses when the log line exists but its archive directory was pruned", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await rm(join(h.store.paths.archiveDir, COMPACTION_ID), { recursive: true, force: true });
      // The line is still there, open, and names a compaction whose archive is gone.
      const [line] = (await logText(h)).trim().split("\n");
      assertDefined(line, "the compaction's log line");
      expect(JSON.parse(line)).toMatchObject({ id: COMPACTION_ID, undone: false });

      const refusal = await refusalOf(undo(h, { id: COMPACTION_ID }));

      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
    });
  });

  test("AC-12: refuses for a well-formed id with neither a log line nor an archive directory", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      expect(MEMORY_COMPACTION_ID_RE.test(UNKNOWN_ID)).toBe(true);

      const refusal = await refusalOf(undo(h, { id: UNKNOWN_ID }));

      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
    });
  });

  test("AC-13: refuses when the target's manifest.json is not valid JSON", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await writeFile(manifestPath(h), "{ this is not json");

      const refusal = await refusalOf(undo(h, { id: COMPACTION_ID }));

      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
    });
  });

  test("B4: refuses a compaction already undone with no log line, even with force", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // The first crash window's other half: the apply finished but its log line never landed, so
      // an undo recovers it from the manifest alone and there is no line to mark when it does.
      await rm(h.store.paths.compactionsLog, { force: true });
      await undo(h, { id: COMPACTION_ID });
      expect((await compactionManifest(h)).status).toBe("undone");
      expect(existsSync(h.store.paths.compactionsLog)).toBe(false);
      // Somebody edits a restored note after the undo.
      await h.store.writeNote({ ...(await requiredNote(h, "source-a")), body: "edited after the undo" });

      const refusal = await refusalOf(undo(h, { id: COMPACTION_ID, force: true }));

      // The terminal manifest is the record that this compaction was already reversed, and no log
      // line can say so here — so the manifest does. `force` accepts a changed note; it is not a
      // licence to write the archived originals over a mirror a later session has moved.
      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
      expect((await requiredNote(h, "source-a")).body).toBe("edited after the undo");
    });
  });

  test("B4: refuses a compaction whose undo completed as a rollback, with no log line either", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // The other crash window: the process died during the apply, so the manifest says
      // `applying`, there is no log line, and the undo recovers it as `rolled_back`.
      await patchManifest(h, { status: "applying", created: undefined, notesAfter: undefined });
      await rm(h.store.paths.compactionsLog, { force: true });
      await undo(h, { id: COMPACTION_ID });
      expect((await compactionManifest(h)).status).toBe("rolled_back");

      const refusal = await refusalOf(undo(h, { id: COMPACTION_ID, force: true }));

      expect(refusal.code).toBe("MEMORY_COMPACT_NOT_FOUND");
    });
  });

  test("B4: an undone manifest whose log line is still open is resumed, not refused", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // An undo that died between rewriting the manifest and marking the log line: the line is
      // open, so this one is unfinished work rather than a completed undo, and re-running it is
      // what clears the line every later undo would otherwise be blocked behind.
      await patchManifest(h, { status: "undone" });

      const result = await undo(h, { id: COMPACTION_ID });

      expect(result.id).toBe(COMPACTION_ID);
      const [line] = (await logText(h)).trim().split("\n");
      assertDefined(line, "the compaction's log line");
      expect(JSON.parse(line)).toMatchObject({ id: COMPACTION_ID, undone: true });
    });
  });
});

describe("undoMemoryCompaction: a sync in flight", () => {
  test("AC-14: refuses with MEMORY_BUSY while a sync of this process is in flight", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();

      const refusal = await withSyncInFlight(h, () => refusalOf(undo(h)));

      expect(refusal.code).toBe("MEMORY_BUSY");
    });
  });
});

/** One refusal of this story, posed on a mirror a test has just applied a compaction to. */
interface RefusalCase {
  readonly name: string;
  readonly code: string;
  /** What the test does to the mirror before taking the snapshot the refusal may not change. */
  readonly pose: (h: Harness) => Promise<void>;
  /** The undo call that refuses, including the sync claim one of them needs around it. */
  readonly run: (h: Harness) => Promise<unknown>;
}

/** A case that needs no preparation beyond the apply every case starts from. */
async function noPose(): Promise<void> {
  // Nothing to pose: the refusal is answerable from the mirror the apply left.
}

/** Every refusal this story can answer with, each with the state the refusal may not change. */
const REFUSAL_CASES: readonly RefusalCase[] = [
  { name: "a changed merged note", code: "MEMORY_COMPACT_CHANGED", pose: changeMergedNote, run: (h) => undo(h) },
  {
    name: "a changed archived slug",
    code: "MEMORY_COMPACT_CHANGED",
    pose: async (h) => {
      await h.store.writeNote({
        ...originalOf(h, "retired"),
        id: "id-written-after-the-compaction",
        body: "written after the compaction",
        updatedAt: LATER_STAMP,
      });
    },
    run: (h) => undo(h),
  },
  {
    name: "no open log line",
    code: "MEMORY_COMPACT_NOT_FOUND",
    pose: async (h) => {
      await undo(h);
    },
    run: (h) => undo(h),
  },
  {
    name: "an id that is not a compaction id",
    code: "MEMORY_COMPACT_NOT_FOUND",
    pose: noPose,
    run: (h) => undo(h, { id: BAD_ID }),
  },
  {
    name: "a traversal id",
    code: "MEMORY_COMPACT_NOT_FOUND",
    pose: async (h) => {
      // The manifest one directory above the archive that "../outside" resolves to: a refusal
      // that read it would be a read this case cannot see, but one that acted on it would write.
      const outside = join(h.store.paths.projectDir, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "manifest.json"), await readFile(manifestPath(h), "utf8"));
    },
    run: (h) => undo(h, { id: TRAVERSAL_ID }),
  },
  {
    name: "an id whose log line is already undone",
    code: "MEMORY_COMPACT_NOT_FOUND",
    pose: async (h) => {
      await undo(h, { id: COMPACTION_ID });
    },
    run: (h) => undo(h, { id: COMPACTION_ID }),
  },
  {
    name: "a pruned archive",
    code: "MEMORY_COMPACT_NOT_FOUND",
    pose: async (h) => {
      await rm(join(h.store.paths.archiveDir, COMPACTION_ID), { recursive: true, force: true });
    },
    run: (h) => undo(h, { id: COMPACTION_ID }),
  },
  {
    name: "an archive naming another compaction",
    code: "MEMORY_COMPACT_NOT_FOUND",
    pose: async (h) => {
      // A directory the caller names that holds this compaction's notes but a manifest still
      // saying `id: <COMPACTION_ID>`: the two spellings of the target disagree.
      await cp(join(h.store.paths.archiveDir, COMPACTION_ID), join(h.store.paths.archiveDir, OTHER_ID), {
        recursive: true,
      });
    },
    run: (h) => undo(h, { id: OTHER_ID }),
  },
  {
    name: "an id with no archive",
    code: "MEMORY_COMPACT_NOT_FOUND",
    pose: noPose,
    run: (h) => undo(h, { id: UNKNOWN_ID }),
  },
  {
    name: "a manifest that is not JSON",
    code: "MEMORY_COMPACT_NOT_FOUND",
    pose: async (h) => {
      await writeFile(manifestPath(h), "{ this is not json");
    },
    run: (h) => undo(h, { id: COMPACTION_ID }),
  },
  {
    name: "a sync in flight",
    code: "MEMORY_BUSY",
    pose: noPose,
    run: (h) => withSyncInFlight(h, () => undo(h)),
  },
];

describe("undoMemoryCompaction: after any refusal", () => {
  test.each([...REFUSAL_CASES])("AC-15: after $name the mirror and the outbox are unchanged", async (refusal) => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await refusal.pose(h);
      const before = await diskState(h);

      const refused = await refusalOf(refusal.run(h));

      expect(refused.code).toBe(refusal.code);
      expect(await diskState(h)).toEqual(before);
    });
  });
});
