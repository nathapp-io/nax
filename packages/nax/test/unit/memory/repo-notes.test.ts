/**
 * repo-notes.ts — repo-committed team notes, per-file rules.
 *
 * Covers US-003 AC-1..AC-18: reading the design's example note, the `repo`
 * source stamp, and every per-candidate rule — slug/filename agreement, the
 * required frontmatter shape, `scope` and `status` gating, a symlink never being
 * followed, the byte cap checked before the read, a failed read, a secret in the
 * description or body, the `.md`-only top level, and slug ordering.
 *
 * The directory-safety rules (rule 1) and the accepted-note cap (rule 4) belong
 * to US-004 and are not asserted here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import { _repoNotesDeps, REPO_NOTE_MAX_FILE_BYTES, REPO_NOTES_MAX, readRepoNotes } from "@/memory";

/** The Design's example note, verbatim. */
const STAGING_DB_NOTE = `---
id: staging-db
slug: staging-db
type: project
scope: project
description: the staging database is shared; never reset it
source: human
updatedAt: 2026-11-02T08:00:00Z
status: active
---

Ask in #infra before running migrations against staging.
`;

interface NoteFields {
  readonly slug: string;
  readonly type?: string;
  readonly scope?: string;
  readonly status?: string;
  readonly description?: string;
  readonly body?: string;
}

/** A valid feature-1 note file, with the given frontmatter values. */
function noteFile(fields: NoteFields): string {
  return [
    "---",
    `id: ${fields.slug}`,
    `slug: ${fields.slug}`,
    `type: ${fields.type ?? "project"}`,
    `scope: ${fields.scope ?? "project"}`,
    `description: ${fields.description ?? `about ${fields.slug}`}`,
    "source: human",
    "updatedAt: 2026-11-02T08:00:00Z",
    `status: ${fields.status ?? "active"}`,
    "---",
    "",
    fields.body ?? `body of ${fields.slug}`,
    "",
  ].join("\n");
}

describe("readRepoNotes", () => {
  let repoRoot: string;
  let logger: MockLogger;
  let originalDeps: typeof _repoNotesDeps;

  function memoryDir(): string {
    return join(repoRoot, ".nax", "memory");
  }

  /** Write one file into `.nax/memory` and return its absolute path. */
  function writeNote(name: string, content: string): string {
    const path = join(memoryDir(), name);
    writeFileSync(path, content);
    return path;
  }

  function skipWarns(): { readonly stage: string; readonly message: string; data?: Record<string, unknown> }[] {
    return logger.calls.filter((call) => call.level === "warn" && call.message === "repo note skipped");
  }

  beforeEach(() => {
    repoRoot = makeTempDir("nax-repo-notes-");
    mkdirSync(memoryDir(), { recursive: true });
    logger = makeLogger();
    originalDeps = { ..._repoNotesDeps };
  });

  afterEach(() => {
    Object.assign(_repoNotesDeps, originalDeps);
    cleanupTempDir(repoRoot);
  });

  test("returns the Design's example repo note", async () => {
    writeNote("staging-db.md", STAGING_DB_NOTE);

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes.map((note) => note.slug)).toEqual(["staging-db"]);
  });

  test("stamps an accepted note's source as repo", async () => {
    writeNote("staging-db.md", STAGING_DB_NOTE);

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes.map((note) => note.source)).toEqual(["repo"]);
  });

  test("skips a note whose frontmatter slug differs from its file name", async () => {
    writeNote("other.md", noteFile({ slug: "staging-db" }));

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("logs one warn naming the skipped file", async () => {
    writeNote("other.md", noteFile({ slug: "staging-db" }));

    await readRepoNotes({ repoRoot, logger });

    const warns = skipWarns();
    const path = warns[0]?.data?.path;
    expect(warns).toHaveLength(1);
    expect(typeof path === "string" && path.endsWith("other.md")).toBe(true);
  });

  test("skips a note file with no frontmatter", async () => {
    writeNote("bad.md", "just prose, no frontmatter at all\n");

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("counts a malformed note as skipped", async () => {
    writeNote("bad.md", "just prose, no frontmatter at all\n");

    const { skipped } = await readRepoNotes({ repoRoot, logger });

    expect(skipped).toBe(1);
  });

  test("skips a note whose scope is user", async () => {
    writeNote("machine-tip.md", noteFile({ slug: "machine-tip", scope: "user", type: "user" }));

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("skips a note whose status is not active", async () => {
    writeNote("draft.md", noteFile({ slug: "draft", status: "pending" }));

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("never follows a symlinked note", async () => {
    const target = join(repoRoot, "real-note.md");
    writeFileSync(target, noteFile({ slug: "link" }));
    symlinkSync(target, join(memoryDir(), "link.md"), "file");

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("does not follow a candidate swapped for a symlink after it was measured", async () => {
    const target = join(repoRoot, "target.md");
    writeFileSync(target, noteFile({ slug: "swapped" }));
    const candidatePath = writeNote("swapped.md", noteFile({ slug: "swapped" }));
    // The race the rule has to survive: `lstat` sees a regular file, and the
    // path becomes a symlink before the read starts. Only the candidate is
    // swapped — the directory checks stat `.nax` and `.nax/memory` too.
    _repoNotesDeps.lstat = async (candidate: string) => {
      const info = lstatSync(candidate);
      if (candidate !== candidatePath) return info;
      rmSync(candidate);
      symlinkSync(target, candidate, "file");
      return info;
    };

    const { notes, skipped } = await readRepoNotes({ repoRoot, logger });

    expect({ notes, skipped }).toEqual({ notes: [], skipped: 1 });
  });

  test("skips a file larger than the per-file cap", async () => {
    writeNote("huge.md", noteFile({ slug: "huge", body: "x".repeat(REPO_NOTE_MAX_FILE_BYTES) }));

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("does not read a file it has already measured as too large", async () => {
    writeNote("huge.md", noteFile({ slug: "huge", body: "x".repeat(REPO_NOTE_MAX_FILE_BYTES) }));
    const readPaths: string[] = [];
    _repoNotesDeps.readFile = async (path: string) => {
      readPaths.push(path);
      return "";
    };

    await readRepoNotes({ repoRoot, logger });

    expect(readPaths).toEqual([]);
  });

  test("skips a candidate whose read fails", async () => {
    writeNote("staging-db.md", STAGING_DB_NOTE);
    _repoNotesDeps.readFile = async () => {
      throw new Error("EACCES: permission denied");
    };

    const { notes, skipped } = await readRepoNotes({ repoRoot, logger });

    expect({ notes, skipped }).toEqual({ notes: [], skipped: 1 });
  });

  test("skips a note whose body carries a secret", async () => {
    writeNote("leak.md", noteFile({ slug: "leak", body: "key is AKIAABCDEFGHIJKLMNOP" }));

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("names the secret's kind in the skip reason", async () => {
    writeNote("leak.md", noteFile({ slug: "leak", body: "key is AKIAABCDEFGHIJKLMNOP" }));

    await readRepoNotes({ repoRoot, logger });

    expect(skipWarns().map((call) => call.data?.reason)).toEqual(["secret (aws)"]);
  });

  test("ignores a non-.md file and a nested note", async () => {
    writeNote("notes.txt", noteFile({ slug: "notes" }));
    mkdirSync(join(memoryDir(), "sub"), { recursive: true });
    writeFileSync(join(memoryDir(), "sub", "nested.md"), noteFile({ slug: "nested" }));

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toEqual([]);
  });

  test("does not count an ignored name or a nested note as skipped", async () => {
    writeNote("notes.txt", noteFile({ slug: "notes" }));
    mkdirSync(join(memoryDir(), "sub"), { recursive: true });
    writeFileSync(join(memoryDir(), "sub", "nested.md"), noteFile({ slug: "nested" }));

    const { skipped } = await readRepoNotes({ repoRoot, logger });

    expect(skipped).toBe(0);
  });

  test("returns accepted notes in slug order", async () => {
    writeNote("zeta.md", noteFile({ slug: "zeta" }));
    writeNote("alpha.md", noteFile({ slug: "alpha" }));
    writeNote("mid.md", noteFile({ slug: "mid" }));

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes.map((note) => note.slug)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("is exported from the memory barrel with its limits", () => {
    expect({ readRepoNotes: typeof readRepoNotes, maxBytes: REPO_NOTE_MAX_FILE_BYTES, max: REPO_NOTES_MAX }).toEqual({
      readRepoNotes: "function",
      maxBytes: 16_384,
      max: 200,
    });
  });
});
