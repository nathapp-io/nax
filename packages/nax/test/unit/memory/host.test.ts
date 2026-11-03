/**
 * host.ts — the memory host's composition and its live note reads.
 *
 * Covers US-005 AC-1..AC-18: the disabled short-circuit (before any directory is
 * resolved), `dirs` / `providerId` / `writeMode`, the mirror-plus-repo merge of
 * `notes("project")` and the shadowing rule that lets the agent's own note hide
 * the team's, `getNote`, the two `search` scopes, the once-per-host repo-note
 * warn, and the barrel export.
 *
 * The placeholders US-006 and US-007 replace (`renderIndex`, `sync`, `status`,
 * `save`, `forget`, `approve`) are not asserted here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryStore, type MemoryNote } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { memoryConfigOf } from "@/config";
import { _memoryHostDeps, createMemoryHost, type MemoryHost, memoryDirs } from "@/memory";

/** The Design's example repo note, verbatim. */
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

/** A mirror note with the given slug, and whatever else the case needs. */
function noteFor(slug: string, overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: slug,
    slug,
    type: "project",
    scope: "project",
    description: `about ${slug}`,
    source: "nax-chat",
    updatedAt: "2026-11-02T08:00:00Z",
    status: "active",
    body: `body of ${slug}`,
    ...overrides,
  };
}

/** A note file with the given frontmatter slug, written as a teammate would commit it. */
function noteFile(slug: string): string {
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

describe("createMemoryHost", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _memoryHostDeps;

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-global-");
    repoRoot = makeTempDir("nax-host-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
  });

  afterEach(() => {
    _memoryHostDeps.memoryDirs = originalDeps.memoryDirs;
    _memoryHostDeps.readRepoNotes = originalDeps.readRepoNotes;
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  test("returns null when memory is disabled", async () => {
    const config = makeNaxConfig({ memory: { enabled: false } });

    const host = await createMemoryHost({ config, repoRoot, source: "nax-chat", logger });

    expect(host).toBeNull();
  });

  test("does not resolve the memory directories when memory is disabled", async () => {
    let calls = 0;
    _memoryHostDeps.memoryDirs = async () => {
      calls += 1;
      throw new Error("memoryDirs must not be called when memory is disabled");
    };

    await createMemoryHost({
      config: makeNaxConfig({ memory: { enabled: false } }),
      repoRoot,
      source: "nax-chat",
      logger,
    });

    expect(calls).toBe(0);
  });

  test("reports the directories memoryDirs resolves for the same config and repo root", async () => {
    const config = makeNaxConfig();

    const host = await createMemoryHost({ config, repoRoot, source: "nax-chat", logger });

    expect(host?.dirs).toEqual(await memoryDirs({ config, repoRoot }));
  });

  test("reports the local provider id", async () => {
    const host = await createMemoryHost({ config: makeNaxConfig(), repoRoot, source: "nax-chat", logger });

    expect(host?.providerId).toBe("local");
  });

  test("reports the configured write mode", async () => {
    const config = makeNaxConfig({ memory: { writeMode: "proposal" } });

    const host = await createMemoryHost({ config, repoRoot, source: "nax-chat", logger });

    expect(host?.writeMode).toBe(memoryConfigOf(config).writeMode);
  });

  test("is exported from the memory barrel", () => {
    expect({ createMemoryHost: typeof createMemoryHost, memoryDirs: typeof memoryDirs }).toEqual({
      createMemoryHost: "function",
      memoryDirs: "function",
    });
  });
});

describe("host note reads", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let host: MemoryHost;
  let savedGlobalEnv: string | undefined;

  /** The directory the repository's team notes are committed to. */
  function repoMemoryDir(): string {
    return join(repoRoot, ".nax", "memory");
  }

  /** Commit one repo note file under `.nax/memory`. */
  function writeRepoNote(name: string, content: string): void {
    mkdirSync(repoMemoryDir(), { recursive: true });
    writeFileSync(join(repoMemoryDir(), name), content);
  }

  /** Write one note into the mirror the host reads, through the store it composed. */
  async function writeMirrorNote(note: MemoryNote): Promise<void> {
    const store = createMemoryStore({
      projectDir: host.dirs.projectDir,
      userDir: host.dirs.userDir,
      logger,
    });
    await store.writeNote(note);
  }

  /** Every `repo note skipped` warn the host's logger has been given. */
  function skipWarns(): readonly { readonly data?: Record<string, unknown> }[] {
    return logger.calls.filter((call) => call.level === "warn" && call.message === "repo note skipped");
  }

  beforeEach(async () => {
    globalDir = makeTempDir("nax-host-read-global-");
    repoRoot = makeTempDir("nax-host-read-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    const created = await createMemoryHost({ config: makeNaxConfig(), repoRoot, source: "nax-chat", logger });
    assertDefined(created, "the memory host");
    host = created;
  });

  afterEach(() => {
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  test("returns a note the mirror holds", async () => {
    await writeMirrorNote(noteFor("mirror-note"));

    const notes = await host.notes("project");

    expect(notes.map((note) => note.slug)).toEqual(["mirror-note"]);
  });

  test("returns the repository's own staging-db note", async () => {
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);

    const notes = await host.notes("project");

    expect(notes.map((note) => note.slug)).toEqual(["staging-db"]);
  });

  test("returns one staging-db note when the mirror holds that slug too", async () => {
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);
    await writeMirrorNote(noteFor("staging-db"));

    const notes = await host.notes("project");

    expect(notes.filter((note) => note.slug === "staging-db")).toHaveLength(1);
  });

  test("lets the mirror's note shadow the repository's note of the same slug", async () => {
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);
    await writeMirrorNote(noteFor("staging-db"));

    const notes = await host.notes("project");

    expect(notes.map((note) => note.source)).toEqual(["nax-chat"]);
  });

  test("merges mirror and repo notes in slug order", async () => {
    writeRepoNote("a-note.md", noteFile("a-note"));
    await writeMirrorNote(noteFor("b-note"));

    const notes = await host.notes("project");

    expect(notes.map((note) => note.slug)).toEqual(["a-note", "b-note"]);
  });

  test("returns no repo note in the user scope", async () => {
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);
    await writeMirrorNote(noteFor("staging-creds", { scope: "user", type: "user" }));

    const notes = await host.notes("user");

    expect({
      slugs: notes.map((note) => note.slug),
      repoSourced: notes.filter((note) => note.source === "repo"),
    }).toEqual({ slugs: ["staging-creds"], repoSourced: [] });
  });

  test("finds the repository's note by slug", async () => {
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);

    const note = await host.getNote("project", "staging-db");

    expect(note?.source).toBe("repo");
  });

  test("returns null for a slug no scope holds", async () => {
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);

    expect(await host.getNote("project", "absent")).toBeNull();
  });

  test("searches the repository's note by keyword", async () => {
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);

    const hits = await host.search({ text: "staging", limit: 10 });

    expect(hits.map((hit) => hit.slug)).toEqual(["staging-db"]);
  });

  test("searches the user mirror as well as the project one", async () => {
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);
    await writeMirrorNote(
      noteFor("staging-creds", { scope: "user", type: "user", description: "the staging password lives in vault" }),
    );

    const hits = await host.search({ text: "staging", limit: 10 });

    expect(hits.some((hit) => hit.slug === "staging-creds" && hit.scope === "user")).toBe(true);
  });

  test("confines a scoped search to that scope", async () => {
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);
    await writeMirrorNote(
      noteFor("staging-creds", { scope: "user", type: "user", description: "the staging password lives in vault" }),
    );

    const hits = await host.search({ text: "staging", scope: "user", limit: 10 });

    expect(hits.map((hit) => hit.scope)).toEqual(["user"]);
  });

  test("warns once for an invalid repo note across repeated reads", async () => {
    writeRepoNote("bad.md", "no frontmatter here\n");

    await host.notes("project");
    await host.notes("project");

    expect(skipWarns()).toHaveLength(1);
  });
});
