/**
 * `applyMemoryCompaction`: the refusals it makes before writing.
 *
 * Two answers can end an apply with nothing written, and both are refusals rather than
 * failures: a sync of this process owns the mirror (`MEMORY_BUSY`, the caller retries), and a
 * plan that no longer matches the mirror has to be re-proposed (`MEMORY_COMPACT_PLAN_INVALID`,
 * carrying every reason at once). Both are checked against the mirror, the queue and the
 * archive on disk rather than against a result, because "nothing was written" is exactly what
 * a result cannot show.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryStore,
  type NaxError,
  parseMemoryNote,
} from "@nathapp/nax-agent";
import {
  applyMemoryCompaction,
  claimSync,
  MEMORY_COMPACTION_ID_RE,
  type MemoryCompactionApplyInput,
  type MemoryCompactionPlan,
  type MemoryCompactionResult,
  releaseSync,
  storeLockTargets,
} from "@nathapp/nax-agent/internal";
import type { MemoryCompactionManifest } from "#src/memory/compaction-archive";
import { assertDefined, assertNaxError, makeFakeClock, makeLogger, withTempDir } from "#test/helpers/index";

/** The instant every apply in these tests stamps with. */
const STAMP = "2026-11-25T10:15:00.000Z";
/** The id a test pins through the `newId` seam, so it can name the archive directory it expects. */
const FIXED_ID = "20261125T101500Z-3fa2c1";
/** What an outbox stub throws when a test makes the first staged write fail. */
const ENQUEUE_FAILED = "the outbox is read-only";
/** The provider and model label an apply records in its manifest. */
const PROVIDER = "local";
const MODEL = "balanced";
/** The filled fraction of the index the caller measured before the model call. */
const FILL_BEFORE = 0.9;

/** One note of the mirror an apply acts on, with overrides. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget-a",
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

/** The mirror every apply test starts from: two mergeable notes and one to retire. */
function mirrorNotes(): MemoryNote[] {
  return [
    note({ id: "mem_a", slug: "replay-budget-a" }),
    note({ id: "mem_b", slug: "replay-budget-b", description: "replay budget is a ceiling, not a target" }),
    note({ id: "mem_stale", slug: "stale-story-14", description: "the retry loop changed in story 14" }),
    note({ id: "mem_kept", slug: "unrelated", description: "unrelated note" }),
  ];
}

/** The plan every apply test narrows from: one retire and one two-source merge, both valid. */
function plan(overrides: Partial<MemoryCompactionPlan> = {}): MemoryCompactionPlan {
  return {
    retire: [{ slug: "stale-story-14", reason: "story 14 shipped and the loop changed" }],
    merge: [
      {
        from: ["replay-budget-a", "replay-budget-b"],
        into: {
          slug: "replay-budget",
          type: "project",
          description: "replay budget stays 2,048 MiB",
          body: "The replay budget stays at 2,048 MiB and is a ceiling, not a target.",
        },
      },
    ],
    ...overrides,
  };
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

/**
 * The reasons a refusal carries in `context.reasons`, which is `unknown` on the error and is
 * narrowed here — a refusal with no reasons, or with something else in that field, is a bug.
 */
function reasonsOf(error: NaxError): string[] {
  const reasons: unknown = error.context?.reasons;
  if (!Array.isArray(reasons) || !reasons.every((reason): reason is string => typeof reason === "string")) {
    throw new Error("the refusal was expected to carry its reasons in context.reasons");
  }
  return reasons;
}

/** The mirror's notes by slug, as the apply left them: what "unchanged" is compared against. */
async function notesBySlug(store: MemoryStore): Promise<Record<string, MemoryNote>> {
  const bySlug: Record<string, MemoryNote> = {};
  for (const held of await store.listNotes("project")) bySlug[held.slug] = held;
  return bySlug;
}

/** The queue as the apply left it: the requests it holds, by slug. */
async function outboxSlugs(outbox: MemoryOutbox): Promise<Record<string, string>> {
  const bySlug: Record<string, string> = {};
  for (const entry of await outbox.list()) bySlug[entry.slug] = entry.kind;
  return bySlug;
}

/** The manifest one compaction archived, decoded from the file on disk. */
async function readManifest(store: MemoryStore, id: string): Promise<MemoryCompactionManifest> {
  const text = await readFile(join(store.paths.archiveDir, id, "manifest.json"), "utf8");
  return JSON.parse(text);
}

/** A queue whose `enqueue` runs `onFirst` and then throws, on its first request only. */
function outboxFailingFirstEnqueue(inner: MemoryOutbox, onFirst: () => Promise<void>): MemoryOutbox {
  let calls = 0;
  return {
    ...inner,
    enqueue: async (request) => {
      calls += 1;
      if (calls === 1) {
        await onFirst();
        throw new Error(ENQUEUE_FAILED);
      }
      return await inner.enqueue(request);
    },
  };
}

/** Run `work` with a sync of this process claimed on the mirror, then give the claim back. */
async function withSyncInFlight<T>(store: MemoryStore, work: () => Promise<T>): Promise<T> {
  const [target] = storeLockTargets(store);
  assertDefined(target, "the mirror's first lock target");
  claimSync(target.path);
  try {
    return await work();
  } finally {
    releaseSync(target.path);
  }
}

describe("applyMemoryCompaction: a sync in flight", () => {
  test("AC-3: refuses with MEMORY_BUSY when a sync of this process owns the mirror", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      const refusal = await withSyncInFlight(h.store, () => refusalOf(h.apply()));

      expect(refusal.code).toBe("MEMORY_BUSY");
    });
  });

  test("AC-4: after the refusal the mirror's notes and the queue are unchanged", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      const notesBefore = await notesBySlug(h.store);
      const queueBefore = await outboxSlugs(h.outbox);

      await withSyncInFlight(h.store, async () => {
        await refusalOf(h.apply());
      });

      expect(await notesBySlug(h.store)).toEqual(notesBefore);
      expect(await outboxSlugs(h.outbox)).toEqual(queueBefore);
    });
  });

  test("AC-5: after the refusal no archive directory exists", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await withSyncInFlight(h.store, async () => {
        await refusalOf(h.apply());
      });

      expect(existsSync(h.store.paths.archiveDir)).toBe(false);
    });
  });
});

describe("applyMemoryCompaction: a plan the mirror no longer matches", () => {
  test("AC-6: refuses with MEMORY_COMPACT_PLAN_INVALID when a retired slug was deleted after planning", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      const built = plan();
      await h.store.deleteNote("project", "stale-story-14");

      const refusal = await refusalOf(h.apply({ plan: built }));

      expect(refusal.code).toBe("MEMORY_COMPACT_PLAN_INVALID");
    });
  });

  test("AC-7: the refusal carries every reason in its context and in its message", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      // Two faults at once: the retired slug is gone, and the merge has one source left.
      const [firstMerge] = plan().merge;
      assertDefined(firstMerge, "the plan's merge");
      const built: MemoryCompactionPlan = {
        retire: [{ slug: "stale-story-14", reason: "story 14 shipped and the loop changed" }],
        merge: [{ from: ["replay-budget-a"], into: firstMerge.into }],
      };
      await h.store.deleteNote("project", "stale-story-14");

      const refusal = await refusalOf(h.apply({ plan: built }));

      const reasons = reasonsOf(refusal);
      expect(reasons).toHaveLength(2);
      expect(reasons.some((reason) => reason.includes("stale-story-14"))).toBe(true);
      expect(reasons.some((reason) => reason.includes("replay-budget"))).toBe(true);
      for (const reason of reasons) expect(refusal.message).toContain(reason);
    });
  });

  test("AC-8: after the refusal the mirror and queue are unchanged and no archive exists", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      const queueBefore = await outboxSlugs(h.outbox);
      await h.store.deleteNote("project", "stale-story-14");
      const notesBefore = await notesBySlug(h.store);

      await refusalOf(h.apply());

      expect(await notesBySlug(h.store)).toEqual(notesBefore);
      expect(await outboxSlugs(h.outbox)).toEqual(queueBefore);
      expect(existsSync(h.store.paths.archiveDir)).toBe(false);
    });
  });

  test("AC-9: refuses with MEMORY_COMPACT_PLAN_INVALID when a merge target is reserved", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      const refusal = await refusalOf(h.apply({ reservedSlugs: new Set(["replay-budget"]) }));

      expect(refusal.code).toBe("MEMORY_COMPACT_PLAN_INVALID");
      expect(reasonsOf(refusal).some((reason) => reason.includes("replay-budget"))).toBe(true);
    });
  });
});

describe("applyMemoryCompaction: the pre-change archive", () => {
  /** The archive's notes directory of one compaction, as a caller reaches it. */
  function archivedNotesDir(store: MemoryStore, id: string): string {
    return join(store.paths.archiveDir, id, "notes");
  }

  test("AC-10: archives one file per retired slug, under <archiveDir>/<id>/notes", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      const built: MemoryCompactionPlan = {
        retire: [
          { slug: "stale-story-14", reason: "story 14 shipped and the loop changed" },
          { slug: "unrelated", reason: "nothing refers to it any more" },
        ],
        merge: plan().merge,
      };

      await h.apply({ plan: built, newId: () => FIXED_ID });

      for (const slug of ["stale-story-14", "unrelated"]) {
        expect(existsSync(join(archivedNotesDir(h.store, FIXED_ID), `${slug}.md`))).toBe(true);
      }
    });
  });

  test("AC-11: archives one file per merge-source slug, under <archiveDir>/<id>/notes", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      await h.apply({ newId: () => FIXED_ID });

      expect(existsSync(join(archivedNotesDir(h.store, FIXED_ID), "replay-budget-a.md"))).toBe(true);
      expect(existsSync(join(archivedNotesDir(h.store, FIXED_ID), "replay-budget-b.md"))).toBe(true);
    });
  });

  test("AC-12: each archived file parses back to the note the mirror held before the apply", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      const before = await notesBySlug(h.store);

      await h.apply({ newId: () => FIXED_ID });

      for (const slug of ["stale-story-14", "replay-budget-a", "replay-budget-b"]) {
        const text = await readFile(join(archivedNotesDir(h.store, FIXED_ID), `${slug}.md`), "utf8");
        expect(parseMemoryNote(text)).toEqual(before[slug]);
      }
    });
  });

  test("AC-13: at the first enqueue failure the manifest still says applying, with no created", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);
      const seen: { manifest?: MemoryCompactionManifest } = {};
      const outbox = outboxFailingFirstEnqueue(h.outbox, async () => {
        seen.manifest = await readManifest(h.store, FIXED_ID);
      });

      await h.apply({ outbox, newId: () => FIXED_ID }).then(
        () => {
          throw new Error("the apply was expected to fail at the first enqueue and resolved instead");
        },
        () => undefined,
      );

      const manifest = seen.manifest;
      assertDefined(manifest, "the manifest captured at the first enqueue");
      expect(manifest.id).toBe(FIXED_ID);
      expect(manifest.createdAt).toBe(STAMP);
      expect(manifest.status).toBe("applying");
      expect(manifest.retired).toEqual(["stale-story-14"]);
      expect(manifest.merged).toEqual([{ from: ["replay-budget-a", "replay-budget-b"], into: "replay-budget" }]);
      expect(manifest.provider).toBe(PROVIDER);
      expect(manifest.model).toBe(MODEL);
      expect(manifest.notesBefore).toBe(mirrorNotes().length);
      expect(manifest.fillBefore).toBe(FILL_BEFORE);
      expect("created" in manifest).toBe(false);
      expect("notesAfter" in manifest).toBe(false);
    });
  });
});

describe("applyMemoryCompaction: the compaction id", () => {
  test("AC-14: with no newId the id matches MEMORY_COMPACTION_ID_RE", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      const result = await h.apply();

      expect(MEMORY_COMPACTION_ID_RE.test(result.id)).toBe(true);
      expect(await readdir(h.store.paths.archiveDir)).toEqual([result.id]);
    });
  });

  test("AC-15: the archive directory is named by the id newId returns", async () => {
    await withTempDir(async (dir) => {
      const h = await harness(dir);

      const result = await h.apply({ newId: () => FIXED_ID });

      expect(result.id).toBe(FIXED_ID);
      expect(await readdir(h.store.paths.archiveDir)).toEqual([FIXED_ID]);
    });
  });
});
