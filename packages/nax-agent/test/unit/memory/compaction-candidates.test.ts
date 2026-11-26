/**
 * Compaction candidates: which notes a compaction plan may act on, and the id/source
 * constants the whole compaction surface is spelled with.
 *
 * A candidate is a note the project mirror holds, still active, of type `project` or
 * `reference`, that no queued forget is already retiring. Everything else — feedback,
 * user notes, user-scope notes, pending notes — is out of reach, and the answer is in slug
 * order so a plan built from it is deterministic.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryStore,
  serializeMemoryNote,
} from "@nathapp/nax-agent";
import * as internal from "@nathapp/nax-agent/internal";
import * as memory from "#src/memory/index";
import { makeLogger, withTempDir } from "#test/helpers/index";

const UPDATED_AT = "2026-11-02T08:11:00.000Z";

/** One note, with overrides: the shape every candidate assertion starts from. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: UPDATED_AT,
    status: "active",
    body: "The replay budget stays at 2,048 MiB.",
    ...overrides,
  };
}

/** The mirror's project directory under one temp directory. */
function projectPath(dir: string): string {
  return join(dir, "project");
}

/** One mirror holding `notes`, plus a queued forget for each slug in `forgetSlugs`. */
async function mirrorHolding(
  dir: string,
  notes: readonly MemoryNote[],
  forgetSlugs: readonly string[] = [],
): Promise<{ store: MemoryStore; outbox: MemoryOutbox }> {
  const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
  for (const held of notes) await store.writeNote(held);
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir });
  for (const slug of forgetSlugs) {
    await outbox.enqueue({ kind: "forget", scope: "project", slug, writeMode: "direct", reason: "the budget doubled" });
  }
  return { store, outbox };
}

/** The candidate slugs a mirror holding `notes` answers, in the order the caller gets them. */
async function candidateSlugs(notes: readonly MemoryNote[], forgetSlugs: readonly string[] = []): Promise<string[]> {
  return await withTempDir(async (dir) => {
    const { store, outbox } = await mirrorHolding(dir, notes, forgetSlugs);
    const candidates = await memory.memoryCompactionCandidates({ store, outbox });
    return candidates.map((candidate) => candidate.slug);
  });
}

describe("memoryCompactionCandidates", () => {
  test("AC-1: answers the active project and reference notes, sorted by slug", async () => {
    const slugs = await candidateSlugs([
      note({ slug: "zeta-note" }),
      note({ slug: "alpha-reference", type: "reference" }),
      note({ slug: "mid-note" }),
    ]);

    expect(slugs).toEqual(["alpha-reference", "mid-note", "zeta-note"]);
  });

  test("AC-2: excludes a project note of type feedback", async () => {
    const slugs = await candidateSlugs([note({ slug: "kept" }), note({ slug: "advice", type: "feedback" })]);

    expect(slugs).toEqual(["kept"]);
  });

  test("AC-3: excludes a project note of type user", async () => {
    const slugs = await candidateSlugs([note({ slug: "kept" }), note({ slug: "preference", type: "user" })]);

    expect(slugs).toEqual(["kept"]);
  });

  test("AC-4: excludes a project note with status pending", async () => {
    const slugs = await candidateSlugs([note({ slug: "kept" }), note({ slug: "half-baked", status: "pending" })]);

    expect(slugs).toEqual(["kept"]);
  });

  test("AC-5: excludes a user-scope note of type project", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({
        projectDir: projectPath(dir),
        userDir: join(dir, "user"),
        logger: makeLogger(),
      });
      await store.writeNote(note({ slug: "kept" }));
      await store.writeNote(note({ slug: "global-pref", scope: "user" }));
      // A project-directory file whose frontmatter says user scope: the store lists it, and
      // only the candidate rule keeps it out of a plan.
      await Bun.write(
        join(store.paths.notesDir, "mislabeled.md"),
        serializeMemoryNote(note({ slug: "mislabeled", scope: "user" })),
      );
      const outbox = createMemoryOutbox({ dir: store.paths.outboxDir });

      const candidates = await memory.memoryCompactionCandidates({ store, outbox });

      expect(candidates.map((candidate) => candidate.slug)).toEqual(["kept"]);
    });
  });

  test("AC-6: excludes a note whose key the outbox holds a forget for", async () => {
    const slugs = await candidateSlugs([note({ slug: "kept" }), note({ slug: "doomed" })], ["doomed"]);

    expect(slugs).toEqual(["kept"]);
  });

  test("AC-7: answers no candidates for a mirror with no project notes", async () => {
    expect(await candidateSlugs([])).toEqual([]);
  });
});

describe("compaction constants", () => {
  test("AC-8: MEMORY_COMPACTION_ID_RE matches a timestamp and six hex characters", () => {
    expect(memory.MEMORY_COMPACTION_ID_RE.test("20261125T101500Z-3fa2c1")).toBe(true);
  });

  test("AC-9: MEMORY_COMPACTION_ID_RE rejects a path that merely ends with an id", () => {
    expect(memory.MEMORY_COMPACTION_ID_RE.test("../20261125T101500Z-3fa2c1")).toBe(false);
  });

  test("AC-10: MEMORY_COMPACTION_SOURCE is the label a compacted note carries", () => {
    expect(memory.MEMORY_COMPACTION_SOURCE).toBe("nax-compact");
  });
});

describe("./internal exports", () => {
  test("AC-11: the candidates and the constants are importable from @nathapp/nax-agent/internal", () => {
    expect(internal.memoryCompactionCandidates).toBe(memory.memoryCompactionCandidates);
    expect(internal.MEMORY_COMPACTION_SOURCE).toBe("nax-compact");
    expect(internal.MEMORY_COMPACTION_ID_RE.test("20261125T101500Z-3fa2c1")).toBe(true);
  });
});
