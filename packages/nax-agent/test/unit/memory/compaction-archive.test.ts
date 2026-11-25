/**
 * The compaction archive: where one compaction's pre-change notes, its manifest and the
 * mirror's compaction log live.
 *
 * The archive is the safety net a compaction is confirmed against, so its layout is pinned
 * here rather than only exercised through an apply: two paths on the store, one note file per
 * slug the plan touched, the manifest that says what became of the apply, and one log line per
 * applied compaction. The paths are asserted beside the pre-existing ones so adding them can
 * never quietly move a mirror's index, notes, decisions, queue or lock.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryStore, type MemoryNote, parseMemoryNote } from "@nathapp/nax-agent";
import * as archive from "#src/memory/compaction-archive";
import { memoryStorePaths } from "#src/memory/store-paths";
import { makeLogger, withTempDir } from "#test/helpers/index";

const PROJECT_DIR = "/tmp/nax-compaction-project";
const USER_DIR = "/tmp/nax-compaction-user";
/** The id every archive test writes under: the shape a compaction id has. */
const ID = "20261125T101500Z-3fa2c1";
const CREATED_AT = "2026-11-25T10:15:00.000Z";

/** One note the mirror held before a compaction, as an archive keeps it. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "cache-layout-history",
    type: "project",
    scope: "project",
    description: "the cache layout changed twice before it settled",
    source: "nax-chat",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    body: "The cache layout changed twice before it settled on the shard key.",
    ...overrides,
  };
}

/** The manifest one compaction writes: every field, as an applied compaction leaves it. */
function manifest(overrides: Partial<archive.MemoryCompactionManifest> = {}): archive.MemoryCompactionManifest {
  return {
    id: ID,
    createdAt: CREATED_AT,
    status: "applied",
    provider: "local",
    model: "balanced",
    retired: ["checkout-page-story-notes"],
    merged: [{ from: ["cache-layout-history", "cache-eviction-invariants"], into: "cache-invariants" }],
    created: [{ slug: "cache-invariants", updatedAt: CREATED_AT }],
    notesBefore: 115,
    notesAfter: 72,
    fillBefore: 0.9,
    ...overrides,
  };
}

/** The log line one compaction appends: counts, never note bodies. */
function logLine(overrides: Partial<archive.MemoryCompactionLogLine> = {}): archive.MemoryCompactionLogLine {
  return {
    id: ID,
    createdAt: CREATED_AT,
    retired: 1,
    merged: 1,
    notesBefore: 115,
    notesAfter: 72,
    fillBefore: 0.9,
    undone: false,
    ...overrides,
  };
}

describe("memoryStorePaths: the compaction archive", () => {
  test("AC-1: a project-only store's archiveDir is <projectDir>/archive", () => {
    const paths = memoryStorePaths(PROJECT_DIR, null);

    expect(paths.archiveDir).toBe(join(PROJECT_DIR, "archive"));
  });

  test("AC-2: a project-only store's compactionsLog is <projectDir>/compactions.jsonl", () => {
    const paths = memoryStorePaths(PROJECT_DIR, null);

    expect(paths.compactionsLog).toBe(join(PROJECT_DIR, "compactions.jsonl"));
  });

  test("AC-16: adding the two paths leaves every pre-existing path value alone", () => {
    const paths = memoryStorePaths(PROJECT_DIR, USER_DIR);

    expect({
      projectDir: paths.projectDir,
      userDir: paths.userDir,
      index: paths.index,
      notesDir: paths.notesDir,
      decisions: paths.decisions,
      pendingForgets: paths.pendingForgets,
      syncState: paths.syncState,
      lock: paths.lock,
      outboxDir: paths.outboxDir,
      userIndex: paths.userIndex,
      userNotesDir: paths.userNotesDir,
    }).toEqual({
      projectDir: PROJECT_DIR,
      userDir: USER_DIR,
      index: join(PROJECT_DIR, "MEMORY.md"),
      notesDir: join(PROJECT_DIR, "notes"),
      decisions: join(PROJECT_DIR, "decisions.jsonl"),
      pendingForgets: join(PROJECT_DIR, "pending-forgets.jsonl"),
      syncState: join(PROJECT_DIR, "sync.json"),
      lock: join(PROJECT_DIR, "sync.lock"),
      outboxDir: join(PROJECT_DIR, "outbox"),
      userIndex: join(USER_DIR, "MEMORY.md"),
      userNotesDir: join(USER_DIR, "notes"),
    });
  });
});

describe("writeCompactionArchive", () => {
  test("writes one note file per archived note under <archiveDir>/<id>/notes", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: join(dir, "project"), logger: makeLogger() });

      await archive.writeCompactionArchive({
        store,
        id: ID,
        notes: [note({ slug: "cache-layout-history" }), note({ id: "mem_01J9X3", slug: "cache-eviction-invariants" })],
      });

      expect(existsSync(join(store.paths.archiveDir, ID, "notes", "cache-layout-history.md"))).toBe(true);
      expect(existsSync(join(store.paths.archiveDir, ID, "notes", "cache-eviction-invariants.md"))).toBe(true);
    });
  });

  test("each archived file parses back to the note the mirror held", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: join(dir, "project"), logger: makeLogger() });
      const held = note();

      await archive.writeCompactionArchive({ store, id: ID, notes: [held] });

      const text = await readFile(join(store.paths.archiveDir, ID, "notes", `${held.slug}.md`), "utf8");
      expect(parseMemoryNote(text)).toEqual(held);
    });
  });
});

describe("writeCompactionManifest", () => {
  test("writes <archiveDir>/<id>/manifest.json holding the manifest it was given", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: join(dir, "project"), logger: makeLogger() });
      const written = manifest();

      await archive.writeCompactionManifest({ store, manifest: written });

      const text = await readFile(join(store.paths.archiveDir, ID, "manifest.json"), "utf8");
      expect(JSON.parse(text)).toEqual(written);
    });
  });

  test("a manifest with no created or notesAfter writes neither key", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: join(dir, "project"), logger: makeLogger() });
      const { created: _created, notesAfter: _notesAfter, ...applying } = manifest({ status: "applying" });

      await archive.writeCompactionManifest({ store, manifest: applying });

      const text = await readFile(join(store.paths.archiveDir, ID, "manifest.json"), "utf8");
      const parsed: Record<string, unknown> = JSON.parse(text);
      expect(parsed).toEqual({
        id: ID,
        createdAt: CREATED_AT,
        status: "applying",
        provider: "local",
        model: "balanced",
        retired: ["checkout-page-story-notes"],
        merged: [{ from: ["cache-layout-history", "cache-eviction-invariants"], into: "cache-invariants" }],
        notesBefore: 115,
        fillBefore: 0.9,
      });
    });
  });
});

describe("appendCompactionLog", () => {
  test("appends one JSON line per compaction, leaving the earlier lines in place", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: join(dir, "project"), logger: makeLogger() });
      const first = logLine();
      const second = logLine({ id: "20261126T080000Z-0b0c0d", notesBefore: 72, notesAfter: 70 });

      await archive.appendCompactionLog({ store, line: first });
      await archive.appendCompactionLog({ store, line: second });

      const text = await readFile(store.paths.compactionsLog, "utf8");
      expect(text).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    });
  });
});
