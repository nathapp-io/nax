/**
 * host-index.test.ts — the memory host's index, sync and status.
 *
 * Covers US-006 AC-1..AC-16: `renderIndex` as the rendered facts a session starts
 * with (both scopes, the repo note, the `(forget pending)` marker and the byte
 * cap), `sync` as the composition of feature 1's `syncMemory` — including the
 * result it resolves rather than rejects — and `status` as the counts and stamps
 * the CLI and the `/memory` command report.
 *
 * The index and status reads go through the composed store and outbox on disk, so
 * the notes, the queue and `sync.json` are written exactly as the surfaces that
 * own them write them; only `syncMemory` itself is stubbed, because its own
 * behaviour is feature 1's and is tested there.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryStore,
  type MemorySyncResult,
} from "@nathapp/nax-agent";
import { cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { _memoryHostDeps, createMemoryHost, type MemoryHost } from "@/memory";

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

/** The byte cap AC-3 and AC-4 pin: the schema's floor, small enough to omit notes. */
const SMALL_INDEX_BYTES = 512;

/** How many project notes AC-3 fills the mirror with. */
const MANY_NOTES = 60;

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

/** The stored sync result AC-16 hands back: the outcome a never-throws contract reports. */
const LOCKED_RESULT: MemorySyncResult = { outcome: "locked", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

describe("host index, sync and status", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let host: MemoryHost;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _memoryHostDeps;

  /** The directory the repository's team notes are committed to. */
  function repoMemoryDir(): string {
    return join(repoRoot, ".nax", "memory");
  }

  /** Commit one repo note file under `.nax/memory`. */
  function writeRepoNote(name: string, content: string): void {
    mkdirSync(repoMemoryDir(), { recursive: true });
    writeFileSync(join(repoMemoryDir(), name), content);
  }

  /** The mirror the host reads, built from the directories it resolved. */
  function mirror(): MemoryStore {
    return createMemoryStore({ projectDir: host.dirs.projectDir, userDir: host.dirs.userDir, logger });
  }

  /** The outbox the host reads, at the path the store gives it. */
  function outbox(): MemoryOutbox {
    return createMemoryOutbox({ dir: mirror().paths.outboxDir });
  }

  /** Write one note into the mirror the host reads. */
  async function writeMirrorNote(note: MemoryNote): Promise<void> {
    await mirror().writeNote(note);
  }

  /** Queue one forget, the way a surface that already took the write queues it. */
  async function queueForget(scope: "project" | "user", slug: string): Promise<void> {
    await outbox().enqueue({ kind: "forget", scope, slug, writeMode: "direct", reason: "stale" });
  }

  /** Open the host under test, with whatever config the case needs. */
  async function openHost(config = makeNaxConfig()): Promise<void> {
    host = (await createMemoryHost({ config, repoRoot, source: "nax-chat", logger })) as MemoryHost;
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-index-global-");
    repoRoot = makeTempDir("nax-host-index-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
  });

  afterEach(() => {
    _memoryHostDeps.syncMemory = originalDeps.syncMemory;
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  test("renders the repository's staging-db note as a project line", async () => {
    await openHost();
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);

    const index = await host.renderIndex();

    expect(index.text).toContain("- [project] staging-db — the staging database is shared; never reset it");
  });

  test("renders a saved user note in a User section", async () => {
    await openHost();
    await writeMirrorNote(noteFor("staging-creds", { scope: "user", type: "user" }));

    const index = await host.renderIndex();

    expect({ userSection: index.text.includes("## User"), slug: index.text.includes("staging-creds") }).toEqual({
      userSection: true,
      slug: true,
    });
  });

  test("omits notes when the index is over its byte cap", async () => {
    await openHost(makeNaxConfig({ memory: { indexBytes: SMALL_INDEX_BYTES } }));
    for (let index = 1; index <= MANY_NOTES; index += 1) {
      await writeMirrorNote(noteFor(`note-${String(index).padStart(2, "0")}`));
    }

    const index = await host.renderIndex();

    expect(index.omitted).toBeGreaterThan(0);
  });

  test("cuts the rendered text to the byte cap", async () => {
    await openHost(makeNaxConfig({ memory: { indexBytes: SMALL_INDEX_BYTES } }));
    for (let index = 1; index <= MANY_NOTES; index += 1) {
      await writeMirrorNote(noteFor(`note-${String(index).padStart(2, "0")}`));
    }

    const index = await host.renderIndex();

    expect(Buffer.byteLength(index.text, "utf8")).toBeLessThanOrEqual(SMALL_INDEX_BYTES);
  });

  test("marks a note with a queued forget as forget pending", async () => {
    await openHost();
    await writeMirrorNote(noteFor("old-fact"));
    await queueForget("project", "old-fact");

    const index = await host.renderIndex();
    const line = index.text.split("\n").find((entry) => entry.includes("old-fact"));

    expect(line?.endsWith("(forget pending)")).toBe(true);
  });

  test("syncs through the composed syncMemory exactly once", async () => {
    await openHost();
    let calls = 0;
    _memoryHostDeps.syncMemory = async () => {
      calls += 1;
      return LOCKED_RESULT;
    };

    await host.sync();

    expect(calls).toBe(1);
  });

  test("hands syncMemory the local provider", async () => {
    await openHost();
    const providers: string[] = [];
    _memoryHostDeps.syncMemory = async (input) => {
      providers.push(input.provider.id);
      return LOCKED_RESULT;
    };

    await host.sync();

    expect(providers).toEqual(["local"]);
  });

  test("returns the result syncMemory resolved", async () => {
    await openHost();
    const stubbed: MemorySyncResult = { outcome: "synced", pushed: 1, rejected: 0, pulled: 2, skipped: 3 };
    _memoryHostDeps.syncMemory = async () => stubbed;

    expect(await host.sync()).toEqual(stubbed);
  });

  test("counts the mirror's notes of each scope and the unshadowed repo notes", async () => {
    await openHost();
    await writeMirrorNote(noteFor("first"));
    await writeMirrorNote(noteFor("second"));
    await writeMirrorNote(noteFor("creds", { scope: "user", type: "user" }));
    writeRepoNote("staging-db.md", STAGING_DB_NOTE);

    const status = await host.status();

    expect(status.notes).toEqual({ project: 2, user: 1, repo: 1 });
  });

  test("counts the queued outbox entries", async () => {
    await openHost();
    await queueForget("project", "old-fact");
    const rejected = await outbox().enqueue({ kind: "forget", scope: "project", slug: "gone", writeMode: "direct" });
    await outbox().markRejected(rejected.clientId, "no such note");

    const status = await host.status();

    expect(status.queued).toBe(1);
  });

  test("counts the rejected outbox entries", async () => {
    await openHost();
    await queueForget("project", "old-fact");
    const rejected = await outbox().enqueue({ kind: "forget", scope: "project", slug: "gone", writeMode: "direct" });
    await outbox().markRejected(rejected.clientId, "no such note");

    const status = await host.status();

    expect(status.rejected).toBe(1);
  });

  test("reports how many repo notes were skipped", async () => {
    await openHost();
    writeRepoNote("bad.md", "no frontmatter here\n");

    const status = await host.status();

    expect(status.repoSkipped).toBe(1);
  });

  test("reports no last pull on a fresh mirror", async () => {
    await openHost();

    const status = await host.status();

    expect(status.lastPullAt).toBeNull();
  });

  test("reports the local provider", async () => {
    await openHost();

    const status = await host.status();

    expect(status.provider).toBe("local");
  });

  test("reports itself enabled", async () => {
    await openHost();

    const status = await host.status();

    expect(status.enabled).toBe(true);
  });

  test("resolves a locked sync result instead of rejecting", async () => {
    await openHost();
    _memoryHostDeps.syncMemory = async () => LOCKED_RESULT;

    await expect(host.sync()).resolves.toEqual(LOCKED_RESULT);
  });
});
