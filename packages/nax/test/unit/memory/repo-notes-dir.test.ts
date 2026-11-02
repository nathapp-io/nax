/**
 * repo-notes-dir.test.ts — repo-committed team notes: directory safety and limit.
 *
 * Covers US-004 AC-1..AC-10: rule 1 (the `.nax` / `.nax/memory` pair is never
 * entered through a symlink, an absent directory is silence, an unreadable one
 * is a single warn) and rule 4 (`REPO_NOTES_MAX` accepted notes, the remaining
 * candidates counted as skipped behind one aggregate warn).
 *
 * The per-file rules (rule 2 and rule 3) are asserted in `repo-notes.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, type LogCall, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import { _repoNotesDeps, REPO_NOTES_MAX, readRepoNotes } from "@/memory";

/** A valid feature-1 note file for the given slug. */
function noteText(slug: string): string {
  return [
    "---",
    `id: ${slug}`,
    `slug: ${slug}`,
    "type: project",
    "scope: project",
    `description: about ${slug}`,
    "source: human",
    "updatedAt: 2026-11-02T08:00:00Z",
    "status: active",
    "---",
    "",
    `body of ${slug}`,
    "",
  ].join("\n");
}

/** The Design's example repo note. */
const STAGING_DB_NOTE = noteText("staging-db");

/** An EACCES rejection shaped the way `node:fs/promises` rejects one. */
function eaccesError(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, '${path}'`), { code: "EACCES" });
}

/** `note-000`, `note-001`, … — names whose code-unit order is their numeric order. */
function paddedSlug(index: number): string {
  return `note-${String(index).padStart(3, "0")}`;
}

describe("readRepoNotes directory safety", () => {
  let repoRoot: string;
  let logger: MockLogger;
  let originalDeps: typeof _repoNotesDeps;

  function naxDir(): string {
    return join(repoRoot, ".nax");
  }

  function notesDir(): string {
    return join(repoRoot, ".nax", "memory");
  }

  /** Create `<repoRoot>/.nax/memory` and write the given notes into it. */
  function writeNotes(entries: readonly { readonly slug: string; readonly text?: string }[]): void {
    mkdirSync(notesDir(), { recursive: true });
    for (const entry of entries) {
      writeFileSync(join(notesDir(), `${entry.slug}.md`), entry.text ?? noteText(entry.slug));
    }
  }

  /** Write `count` valid notes named note-000 … note-<count-1>. */
  function writeManyNotes(count: number): void {
    writeNotes(Array.from({ length: count }, (_, index) => ({ slug: paddedSlug(index) })));
  }

  function warnsFor(message: string): LogCall[] {
    return logger.calls.filter((call) => call.level === "warn" && call.message === message);
  }

  /** Every warn the read produced, whatever its message. */
  function warns(): LogCall[] {
    return logger.calls.filter((call) => call.level === "warn");
  }

  beforeEach(() => {
    repoRoot = makeTempDir("nax-repo-notes-dir-");
    logger = makeLogger();
    originalDeps = { ..._repoNotesDeps };
  });

  afterEach(() => {
    Object.assign(_repoNotesDeps, originalDeps);
    cleanupTempDir(repoRoot);
  });

  test("returns no notes when the repository has no .nax directory", async () => {
    const result = await readRepoNotes({ repoRoot, logger });

    expect(result).toEqual({ notes: [], skipped: 0 });
  });

  test("returns no notes when .nax holds no memory directory", async () => {
    mkdirSync(naxDir(), { recursive: true });

    const result = await readRepoNotes({ repoRoot, logger });

    expect(result).toEqual({ notes: [], skipped: 0 });
  });

  test("logs nothing for an absent notes directory", async () => {
    await readRepoNotes({ repoRoot, logger });

    expect(logger.calls).toEqual([]);
  });

  test("does not enter .nax/memory when it is a symlink", async () => {
    const realDir = join(repoRoot, "team-notes");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "staging-db.md"), STAGING_DB_NOTE);
    mkdirSync(naxDir(), { recursive: true });
    symlinkSync(realDir, notesDir(), "dir");

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("logs one symlink warn naming the .nax/memory directory", async () => {
    const realDir = join(repoRoot, "team-notes");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "staging-db.md"), STAGING_DB_NOTE);
    mkdirSync(naxDir(), { recursive: true });
    symlinkSync(realDir, notesDir(), "dir");

    await readRepoNotes({ repoRoot, logger });

    const symlinkWarns = warnsFor("repo notes directory is a symlink");
    expect(symlinkWarns.map((call) => call.data?.path)).toEqual([notesDir()]);
  });

  test("does not enter .nax itself when it is a symlink", async () => {
    const realDir = join(repoRoot, "linked-nax");
    mkdirSync(join(realDir, "memory"), { recursive: true });
    writeFileSync(join(realDir, "memory", "staging-db.md"), STAGING_DB_NOTE);
    symlinkSync(realDir, naxDir(), "dir");

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("logs one symlink warn naming .nax itself", async () => {
    const realDir = join(repoRoot, "linked-nax");
    mkdirSync(join(realDir, "memory"), { recursive: true });
    writeFileSync(join(realDir, "memory", "staging-db.md"), STAGING_DB_NOTE);
    symlinkSync(realDir, naxDir(), "dir");

    await readRepoNotes({ repoRoot, logger });

    expect(warnsFor("repo notes directory is a symlink").map((call) => call.data?.path)).toEqual([naxDir()]);
  });

  test("lists no candidate when a symlinked directory is refused", async () => {
    const realDir = join(repoRoot, "team-notes");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "staging-db.md"), STAGING_DB_NOTE);
    mkdirSync(naxDir(), { recursive: true });
    symlinkSync(realDir, notesDir(), "dir");
    const listed: string[] = [];
    _repoNotesDeps.readdir = async (path: string) => {
      listed.push(path);
      return [];
    };

    await readRepoNotes({ repoRoot, logger });

    expect(listed).toEqual([]);
  });

  test("returns no notes when listing the directory is denied", async () => {
    writeNotes([{ slug: "staging-db", text: STAGING_DB_NOTE }]);
    _repoNotesDeps.readdir = async (path: string) => {
      throw eaccesError(path);
    };

    const result = await readRepoNotes({ repoRoot, logger });

    expect(result).toEqual({ notes: [], skipped: 0 });
  });

  test("logs one unreadable warn when listing the directory is denied", async () => {
    writeNotes([{ slug: "staging-db", text: STAGING_DB_NOTE }]);
    _repoNotesDeps.readdir = async (path: string) => {
      throw eaccesError(path);
    };

    await readRepoNotes({ repoRoot, logger });

    const [warn] = warnsFor("repo notes unreadable");
    expect({ warns: warns().length, path: warn?.data?.path, error: typeof warn?.data?.error }).toEqual({
      warns: 1,
      path: notesDir(),
      error: "string",
    });
  });

  test("returns no notes when the notes directory cannot be inspected", async () => {
    writeNotes([{ slug: "staging-db", text: STAGING_DB_NOTE }]);
    _repoNotesDeps.lstat = async (path: string) => {
      if (path !== notesDir()) return lstatSync(path);
      throw eaccesError(path);
    };

    const result = await readRepoNotes({ repoRoot, logger });

    expect(result).toEqual({ notes: [], skipped: 0 });
  });

  test("logs one unreadable warn naming a directory that cannot be inspected", async () => {
    writeNotes([{ slug: "staging-db", text: STAGING_DB_NOTE }]);
    _repoNotesDeps.lstat = async (path: string) => {
      if (path !== notesDir()) return lstatSync(path);
      throw eaccesError(path);
    };

    await readRepoNotes({ repoRoot, logger });

    expect(warnsFor("repo notes unreadable").map((call) => call.data?.path)).toEqual([notesDir()]);
  });

  test("stops accepting notes at REPO_NOTES_MAX", async () => {
    writeManyNotes(REPO_NOTES_MAX + 2);

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toHaveLength(REPO_NOTES_MAX);
  });

  test("keeps the first REPO_NOTES_MAX notes in file-name order", async () => {
    writeManyNotes(REPO_NOTES_MAX + 2);

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes[notes.length - 1]?.slug).toBe(paddedSlug(REPO_NOTES_MAX - 1));
  });

  test("counts the notes beyond the cap as skipped", async () => {
    writeManyNotes(REPO_NOTES_MAX + 2);

    const { skipped } = await readRepoNotes({ repoRoot, logger });

    expect(skipped).toBe(2);
  });

  test("logs one over-limit warn carrying the skipped count", async () => {
    writeManyNotes(REPO_NOTES_MAX + 2);

    await readRepoNotes({ repoRoot, logger });

    expect(warnsFor("repo notes over limit").map((call) => call.data?.skipped)).toEqual([2]);
  });

  test("does not read the notes beyond the cap", async () => {
    writeManyNotes(REPO_NOTES_MAX + 2);
    const readPaths: string[] = [];
    _repoNotesDeps.readFile = async (path: string) => {
      readPaths.push(path);
      return noteText(path.slice(path.lastIndexOf("/") + 1, -".md".length));
    };

    await readRepoNotes({ repoRoot, logger });

    expect(readPaths).toHaveLength(REPO_NOTES_MAX);
  });

  test("logs no over-limit warn at exactly REPO_NOTES_MAX notes", async () => {
    writeManyNotes(REPO_NOTES_MAX);

    const { notes, skipped } = await readRepoNotes({ repoRoot, logger });

    expect({
      notes: notes.length,
      skipped,
      overLimit: warnsFor("repo notes over limit").length,
    }).toEqual({ notes: REPO_NOTES_MAX, skipped: 0, overLimit: 0 });
  });
});
