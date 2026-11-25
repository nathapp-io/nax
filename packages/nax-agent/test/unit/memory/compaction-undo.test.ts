/**
 * `undoMemoryCompaction`: the default target, the restored notes and the notes it removes.
 *
 * Every fact is read back from disk — the mirror, the archive, the outbox, `MEMORY.md`,
 * `manifest.json`, `compactions.jsonl` — rather than taken from the returned result, and the
 * result is then checked against the files, because a caller told about a different undo than
 * the disk records is the failure that pair exists to rule out.
 *
 * The fixture is a real apply (`makeCompactionHarness`), never a hand-written archive: an undo
 * reads what an apply writes, and an archive the test spelled itself would let both sides drift
 * away from the format together while every assertion stayed green.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryNote, MemoryOutbox, MemoryOutboxEntry } from "@nathapp/nax-agent";
import type { MemoryCompactionPlan } from "@nathapp/nax-agent/internal";
import { type MemoryUndoInput, type MemoryUndoResult, undoMemoryCompaction } from "@nathapp/nax-agent/internal";
import {
  assertDefined,
  assertNaxError,
  COMPACTION_ID,
  compactionManifest,
  makeCompactionHarness,
  withTempDir,
} from "#test/helpers/index";

type Harness = Awaited<ReturnType<typeof makeCompactionHarness>>;

/** The slugs the standard plan archives: the notes an undo has to put back. */
const ARCHIVED_SLUGS = ["retired", "source-a", "source-b"];
/** The slug the standard plan's merge wrote, and the only note an undo has to take away. */
const MERGED_SLUG = "merged";
/** The note neither the plan nor the undo touches. */
const KEPT_SLUG = "unrelated";
/** An archive directory named like a compaction whose manifest still names another one. */
const OTHER_ID = "20261126T101500Z-cccccc";
/** A log line written before the compaction, which the undo must leave byte for byte. */
const EARLIER_LINE =
  '{"id":"20250101T000000Z-aaaaaa","createdAt":"2025-01-01T00:00:00.000Z","retired":0,"merged":0,"notesBefore":1,"notesAfter":1,"fillBefore":0,"undone":false}';

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

/** The compactions log as its raw lines, without the trailing newline's empty element. */
async function logLines(h: Harness): Promise<string[]> {
  return (await readFile(h.store.paths.compactionsLog, "utf8")).trimEnd().split("\n");
}

/** Every log line that decodes to JSON, in file order; a junk line the test wrote is skipped. */
async function decodedLog(h: Harness): Promise<Record<string, unknown>[]> {
  const parsed: Record<string, unknown>[] = [];
  for (const line of await logLines(h)) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // A line the test itself wrote to be malformed: nothing to decode.
    }
  }
  return parsed;
}

/** The one log line naming `id`; the test fails when the log holds none. */
async function logLineFor(h: Harness, id: string): Promise<Record<string, unknown>> {
  const matching = (await decodedLog(h)).filter((line) => line.id === id);
  expect(matching).toHaveLength(1);
  const [line] = matching;
  assertDefined(line, `the log line for "${id}"`);
  return line;
}

/** One note of the mirror, which the test asserts is there before reading it. */
async function requiredNote(h: Harness, slug: string): Promise<MemoryNote> {
  const held = await h.store.readNote("project", slug);
  assertDefined(held, `the mirror's note under "${slug}"`);
  return held;
}

/** The outbox entries of one kind naming one slug. */
async function entriesFor(h: Harness, kind: MemoryOutboxEntry["kind"], slug: string): Promise<MemoryOutboxEntry[]> {
  return (await h.outbox.list()).filter((entry) => entry.kind === kind && entry.slug === slug);
}

/** The project index the next session reads. */
async function indexText(h: Harness): Promise<string> {
  return await readFile(h.store.paths.index, "utf8");
}

/** The line one note renders as in `MEMORY.md`. */
function indexLine(note: MemoryNote): string {
  return `- [${note.type}] ${note.slug} — ${note.description}`;
}

/**
 * The plan whose merge keeps one of its own source slugs: the merged note *is* the note that was
 * already there, so that slug is the one merged note an undo must not take away.
 */
function selfMergePlan(): MemoryCompactionPlan {
  return {
    retire: [],
    merge: [
      {
        from: ["source-a", "source-b"],
        into: { slug: "source-a", type: "project", description: "Combined", body: "Combined body" },
      },
    ],
  };
}

/** The archived original of the harness's mirror under `slug`, which the test asserts exists. */
function originalOf(h: Harness, slug: string): MemoryNote {
  const original = h.originals.find((note) => note.slug === slug);
  assertDefined(original, `the harness's original note "${slug}"`);
  return original;
}

/** The manifest file of the harness's compaction, as it sits on disk. */
function manifestPath(h: Harness): string {
  return join(h.store.paths.archiveDir, COMPACTION_ID, "manifest.json");
}

/** Rewrite the harness's manifest with `patch`, so a test can pose one of the crash windows. */
async function patchManifest(h: Harness, patch: Record<string, unknown>): Promise<void> {
  const manifest: Record<string, unknown> = JSON.parse(await readFile(manifestPath(h), "utf8"));
  await writeFile(manifestPath(h), `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`);
}

/**
 * The state an apply leaves when the process dies during steps 4-7: the archive and the mirror
 * carry the writes it made, and the manifest still says `applying` because step 7 never ran.
 */
async function poseApplying(h: Harness): Promise<void> {
  await h.apply();
  await patchManifest(h, { status: "applying", created: undefined, notesAfter: undefined });
  await rm(h.store.paths.compactionsLog, { force: true });
}

describe("undoMemoryCompaction: the default target", () => {
  test("AC-1: with no id it undoes the newest log line whose undone is false", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();

      const result = await undo(h);

      expect(result.id).toBe(COMPACTION_ID);
      expect(await h.store.readNote("project", MERGED_SLUG)).toBeNull();
      for (const slug of ARCHIVED_SLUGS) expect(await h.store.readNote("project", slug)).not.toBeNull();
    });
  });

  test("AC-2: with no id it skips a malformed log line and undoes the newest well-formed one", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // One line that is not JSON at all, and one that is JSON but not a log line: both are
      // newer than the compaction's own line, so picking either would lose the target.
      await writeFile(
        h.store.paths.compactionsLog,
        `${await readFile(h.store.paths.compactionsLog, "utf8")}{"id": "20261126T101500Z-\n{"id":"20261126T101500Z-bbbbbb"}\n`,
      );

      const result = await undo(h);

      expect(result.id).toBe(COMPACTION_ID);
      for (const slug of ARCHIVED_SLUGS) expect(await h.store.readNote("project", slug)).not.toBeNull();
    });
  });
});

describe("undoMemoryCompaction: the restored notes", () => {
  test("AC-3: the mirror holds every archived note again with its original slug, type, description and body", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();

      await undo(h);

      for (const original of h.originals.filter((note) => ARCHIVED_SLUGS.includes(note.slug))) {
        const restored = await requiredNote(h, original.slug);
        expect(restored.slug).toBe(original.slug);
        expect(restored.type).toBe(original.type);
        expect(restored.description).toBe(original.description);
        expect(restored.body).toBe(original.body);
        expect(restored.scope).toBe(original.scope);
      }
    });
  });

  test("AC-4: every restored note has status active", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();

      await undo(h);

      for (const slug of ARCHIVED_SLUGS) expect((await requiredNote(h, slug)).status).toBe("active");
      const listed = (await h.store.listNotes("project")).map((note) => note.slug);
      expect(listed).toEqual([...ARCHIVED_SLUGS, KEPT_SLUG].sort());
    });
  });

  test("AC-5: the outbox holds one save entry with writeMode direct per restored note", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();

      await undo(h);

      for (const slug of ARCHIVED_SLUGS) {
        const saves = await entriesFor(h, "save", slug);
        expect(saves).toHaveLength(1);
        const [save] = saves;
        assertDefined(save, `the save entry for "${slug}"`);
        const restored = await requiredNote(h, slug);
        expect(save.writeMode).toBe("direct");
        expect(save.scope).toBe("project");
        expect(save.clientId).toBe(restored.id);
        expect(save.note?.slug).toBe(slug);
      }
    });
  });
});

describe("undoMemoryCompaction: the notes the compaction created", () => {
  test("AC-6: a merged note whose slug is not an archived original is absent from the mirror", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      expect(await h.store.readNote("project", MERGED_SLUG)).not.toBeNull();

      await undo(h);

      expect(await h.store.readNote("project", MERGED_SLUG)).toBeNull();
      const listed = (await h.store.listNotes("project")).map((note) => note.slug);
      expect(listed).not.toContain(MERGED_SLUG);
    });
  });

  test("AC-7: that removed merged note has a forget entry with reason undo compaction <id>", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();

      await undo(h);

      const forgets = await entriesFor(h, "forget", MERGED_SLUG);
      expect(forgets).toHaveLength(1);
      const [forget] = forgets;
      assertDefined(forget, "the forget entry for the removed merged note");
      expect(forget.writeMode).toBe("direct");
      expect(forget.scope).toBe("project");
      expect(forget.reason).toBe(`undo compaction ${COMPACTION_ID}`);
    });
  });

  test("AC-8: a merged note whose slug is an archived original leaves that original under the slug", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply({ plan: selfMergePlan() });
      expect((await requiredNote(h, "source-a")).description).toBe("Combined");

      await undo(h);

      const restored = await requiredNote(h, "source-a");
      expect(restored.slug).toBe("source-a");
      expect(restored.description).toBe("Original source-a");
      expect(restored.body).toBe("Body of source-a");
      expect(restored.status).toBe("active");
    });
  });

  test("AC-9: it enqueues no forget for a merged note whose slug is an archived original", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply({ plan: selfMergePlan() });

      await undo(h);

      expect(await entriesFor(h, "forget", "source-a")).toHaveLength(0);
    });
  });
});

// ─── the forget a merged note's removal owes the provider (B2) ───────────────
//
// Deleting the merged note and queuing its forget are two steps, and only one of their orders
// converges. Deleted-then-queued leaves a mirror with no note and a provider that still holds it
// when the queue fails: the re-run finds nothing to delete, skips the step, and never queues the
// forget — so the note the apply wrote comes back on the next pull, or the apply's own still-queued
// save resurrects it. The queue comes first now, and an absent note is still bookkeeping.

describe("undoMemoryCompaction: the removal's delivery bookkeeping", () => {
  test("B2: a merged note already gone still gets its forget queued", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // The state a delete-then-queue undo leaves when the queue step failed: no note, no request.
      await h.store.deleteNote("project", MERGED_SLUG);
      expect(await entriesFor(h, "forget", MERGED_SLUG)).toHaveLength(0);

      const result = await undo(h);

      // Nothing was removed by this run — but the provider is still told the note is gone.
      expect(result.removed).toEqual([]);
      const forgets = await entriesFor(h, "forget", MERGED_SLUG);
      expect(forgets).toHaveLength(1);
      expect(forgets[0]?.reason).toBe(`undo compaction ${COMPACTION_ID}`);
    });
  });

  test("B2: a forget already queued for that note is not queued a second time", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // An earlier run queued the forget and then died before deleting the note.
      await h.outbox.enqueue({
        kind: "forget",
        scope: "project",
        slug: MERGED_SLUG,
        writeMode: "direct",
        reason: `undo compaction ${COMPACTION_ID}`,
      });

      const result = await undo(h);

      expect(result.removed).toEqual([MERGED_SLUG]);
      expect(await h.store.readNote("project", MERGED_SLUG)).toBeNull();
      // One request, not two: the re-run recognizes the intent an interrupted run recorded.
      expect(await entriesFor(h, "forget", MERGED_SLUG)).toHaveLength(1);
    });
  });

  test("B2: a queue that refuses the forget leaves the note in place, and the re-run converges", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // The queue holds its saves and refuses the forget: the one failure the old order could not
      // recover from, because the note had already been deleted when it happened.
      const refusing = {
        ...h.outbox,
        enqueue: async (request: Parameters<MemoryOutbox["enqueue"]>[0]) =>
          request.kind === "forget"
            ? await Promise.reject(new Error("outbox is full"))
            : await h.outbox.enqueue(request),
      };

      const outcome = await undo(h, { outbox: refusing }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBeInstanceOf(Error);
      // Nothing was deleted before its request existed, so the re-run has a note to remove.
      expect(await h.store.readNote("project", MERGED_SLUG)).not.toBeNull();
      expect(await entriesFor(h, "forget", MERGED_SLUG)).toHaveLength(0);

      // The notes an interrupted undo restored are in the mirror again, so the re-run is the
      // `--force` retry the spec describes.
      const redo = await undo(h, { force: true });

      expect(redo.removed).toEqual([MERGED_SLUG]);
      expect(await h.store.readNote("project", MERGED_SLUG)).toBeNull();
      expect(await entriesFor(h, "forget", MERGED_SLUG)).toHaveLength(1);
      expect((await compactionManifest(h)).status).toBe("undone");
    });
  });
});

describe("undoMemoryCompaction: the log", () => {
  test("AC-10: the target's log line has undone true", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      expect(await logLineFor(h, COMPACTION_ID)).toMatchObject({ undone: false });

      await undo(h);

      expect(await logLineFor(h, COMPACTION_ID)).toMatchObject({ undone: true });
    });
  });

  test("AC-11: every other log line is unchanged", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await writeFile(h.store.paths.compactionsLog, `${EARLIER_LINE}\n`);
      await h.apply();
      const before = await logLines(h);
      expect(before).toHaveLength(2);

      await undo(h);

      const after = await logLines(h);
      expect(after).toHaveLength(2);
      expect(after[0]).toBe(EARLIER_LINE);
      expect(after[1]).not.toBe(before[1]);
      expect(await logLineFor(h, COMPACTION_ID)).toMatchObject({ undone: true });
    });
  });
});

describe("undoMemoryCompaction: the manifest", () => {
  test("AC-12: after an undo of an applied compaction its manifest has status undone", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      expect((await compactionManifest(h)).status).toBe("applied");

      await undo(h);

      expect((await compactionManifest(h)).status).toBe("undone");
    });
  });
});

describe("undoMemoryCompaction: the refreshed index", () => {
  test("AC-13: the project MEMORY.md lists the restored notes", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      const before = await indexText(h);
      for (const slug of ARCHIVED_SLUGS) expect(before).not.toContain(slug);

      await undo(h);

      const after = await indexText(h);
      for (const original of h.originals.filter((note) => ARCHIVED_SLUGS.includes(note.slug))) {
        expect(after).toContain(indexLine(original));
      }
    });
  });

  test("AC-14: the project MEMORY.md does not list the removed merged note", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      expect(await indexText(h)).toContain(`- [project] ${MERGED_SLUG} — Combined`);

      await undo(h);

      expect(await indexText(h)).not.toContain(`- [project] ${MERGED_SLUG} —`);
    });
  });
});

describe("undoMemoryCompaction: the result", () => {
  test("AC-15: it resolves to the id, the restored slugs and the removed slugs", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();

      const result = await undo(h);

      expect(result).toEqual({ id: COMPACTION_ID, restored: ARCHIVED_SLUGS, removed: [MERGED_SLUG] });
    });
  });
});

describe("undoMemoryCompaction: recovering a crash window", () => {
  test("AC-16: for an applying manifest with no log line it writes every archived note back", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await poseApplying(h);
      expect(existsSync(h.store.paths.compactionsLog)).toBe(false);
      for (const slug of ARCHIVED_SLUGS) expect(await h.store.readNote("project", slug)).toBeNull();

      await undo(h, { id: COMPACTION_ID });

      for (const slug of ARCHIVED_SLUGS) {
        const original = originalOf(h, slug);
        const restored = await requiredNote(h, slug);
        expect(restored.type).toBe(original.type);
        expect(restored.description).toBe(original.description);
        expect(restored.body).toBe(original.body);
        expect(restored.status).toBe("active");
      }
    });
  });

  test("AC-17: for an applying manifest it deletes each merge target that is not an archived original", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await poseApplying(h);
      expect(await h.store.readNote("project", MERGED_SLUG)).not.toBeNull();

      const result = await undo(h, { id: COMPACTION_ID });

      expect(await h.store.readNote("project", MERGED_SLUG)).toBeNull();
      expect(result.removed).toEqual([MERGED_SLUG]);
      const listed = (await h.store.listNotes("project")).map((note) => note.slug);
      expect(listed).not.toContain(MERGED_SLUG);
    });
  });

  test("AC-18: for an applying manifest the manifest ends with status rolled_back", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await poseApplying(h);

      await undo(h, { id: COMPACTION_ID });

      expect((await compactionManifest(h)).status).toBe("rolled_back");
      // The apply never reached its last step, so there is no line this undo could have marked.
      expect(existsSync(h.store.paths.compactionsLog)).toBe(false);
    });
  });

  test("AC-19: for an applying manifest it does not refuse with MEMORY_COMPACT_CHANGED", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await poseApplying(h);
      // The process died after a partial undo: an archived original is back in the mirror with
      // content a changed-note check would read as changed since the compaction.
      await h.store.writeNote({ ...originalOf(h, "source-a"), body: "written back before the crash" });

      const outcome: { result: MemoryUndoResult | null; error: unknown } = await undo(h, {
        id: COMPACTION_ID,
      }).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: null, error }),
      );

      expect(outcome.error).toBeUndefined();
      assertDefined(outcome.result, "the undo result of an applying manifest");
      expect(outcome.result.id).toBe(COMPACTION_ID);
      expect((await requiredNote(h, "source-a")).body).toBe(originalOf(h, "source-a").body);
    });
  });
});

describe("undoMemoryCompaction: an applied compaction with no log line", () => {
  test("AC-20: it undoes it as an applied compaction", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      await rm(h.store.paths.compactionsLog, { force: true });

      const result = await undo(h, { id: COMPACTION_ID });

      expect(result).toEqual({ id: COMPACTION_ID, restored: ARCHIVED_SLUGS, removed: [MERGED_SLUG] });
      for (const slug of ARCHIVED_SLUGS) expect(await h.store.readNote("project", slug)).not.toBeNull();
      expect(await h.store.readNote("project", MERGED_SLUG)).toBeNull();
      expect((await compactionManifest(h)).status).toBe("undone");
    });
  });
});

describe("undoMemoryCompaction: the target's archive", () => {
  test("F1: an archive whose manifest names another compaction is no target, and nothing is written", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      // A directory the caller names that holds this compaction's notes but a manifest still
      // saying `id: <COMPACTION_ID>`: the two spellings of the target disagree, so reading the
      // notes from one of them and acting on the manifest of the other is not a compaction.
      await cp(join(h.store.paths.archiveDir, COMPACTION_ID), join(h.store.paths.archiveDir, OTHER_ID), {
        recursive: true,
      });
      const mirrorBefore = await h.store.listNotes("project");

      const outcome: { result: MemoryUndoResult | null; error: unknown } = await undo(h, {
        id: OTHER_ID,
      }).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: null, error }),
      );

      expect(outcome.result).toBeNull();
      assertNaxError(outcome.error, "the undo's refusal");
      expect(outcome.error.code).toBe("MEMORY_COMPACT_NOT_FOUND");
      expect(await h.store.listNotes("project")).toEqual(mirrorBefore);
      expect(await logLineFor(h, COMPACTION_ID)).toMatchObject({ undone: false });
      expect((await compactionManifest(h)).status).toBe("applied");
    });
  });
});

describe("undoMemoryCompaction: the package surface", () => {
  test("AC-21: it is importable from @nathapp/nax-agent/internal", async () => {
    const entry: Record<string, unknown> = await import("@nathapp/nax-agent/internal");

    expect(typeof entry.undoMemoryCompaction).toBe("function");
    expect(entry.undoMemoryCompaction).toBe(undoMemoryCompaction);
  });
});
