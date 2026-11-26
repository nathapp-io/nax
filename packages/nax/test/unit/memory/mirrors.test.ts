/**
 * mirrors.test.ts — the mirror inventory and the pruning rule over it.
 *
 * Covers US-020 AC-6..AC-22: one entry per directory under `memory/projects` with the
 * directory's name, the six counts a mirror's own files give (notes, outbox entries,
 * decisions, pending forgets, index bytes and the two flags), the origin and the sync state
 * read back out of the mirror, and `isPrunableMirror` holding each of the six ways a mirror
 * may still hold something.
 *
 * Every fixture is a real directory tree, because the module's whole job is to read one: a
 * count asserted against a stubbed reader would not prove anything about a mirror on disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { isPrunableMirror, listMemoryMirrors, type MemoryMirrorInfo } from "@/memory";
import { createKodaApprovals } from "@/memory/koda-approvals";
import { createMcpIdMap } from "@/memory/mcp-id-map";

/** A mirror with nothing in it: the shape `isPrunableMirror` reads, and every flag false. */
function emptyMirror(overrides: Partial<MemoryMirrorInfo> = {}): MemoryMirrorInfo {
  return {
    dir: "/mem/projects/api-01234567",
    name: "api-01234567",
    notes: 0,
    outbox: 0,
    provider: null,
    originRoot: null,
    rootExists: null,
    indexBytes: 0,
    inUse: false,
    hasArchive: false,
    decisions: 0,
    pendingForgets: 0,
    unreadable: [],
    ...overrides,
  };
}

describe("listMemoryMirrors", () => {
  let projectsDir: string;
  let tempDirs: string[];

  /** A directory for a case's scratch data, cleaned up with the rest. */
  function scratchDir(prefix: string): string {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  /** One mirror directory under `projectsDir`, created and named as the store names it. */
  function mirrorDir(name = "api-01234567"): string {
    const dir = join(projectsDir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Write one note file into a mirror. */
  function writeNote(dir: string, slug: string): void {
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "notes", `${slug}.md`), "---\nslug: x\n---\n");
  }

  /** Write the mirror's `MEMORY.md`, filling it to exactly `bytes` UTF-8 bytes. */
  function writeIndex(dir: string, bytes: number): void {
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n".padEnd(bytes, "x"));
  }

  /** Write one outbox entry file, named as the outbox names it. */
  function writeOutboxEntry(dir: string, seq: number, clientId: string): void {
    mkdirSync(join(dir, "outbox"), { recursive: true });
    writeFileSync(join(dir, "outbox", `${String(seq).padStart(8, "0")}-${clientId}.json`), "{}\n");
  }

  /** Write one JSON line file into a mirror. */
  function writeLines(dir: string, name: string, lines: readonly string[]): void {
    writeFileSync(join(dir, name), lines.map((line) => `${line}\n`).join(""));
  }

  /** The `provider` a mirror's `sync.json` records. */
  function writeSyncState(dir: string, provider: string): void {
    const state = { provider, cursor: { project: null, user: null }, lastPullAt: null, lastError: null };
    writeFileSync(join(dir, "sync.json"), `${JSON.stringify(state)}\n`);
  }

  /** The origin a mirror records, pointing at `root`. */
  function writeOrigin(dir: string, root: string): void {
    writeFileSync(join(dir, "origin.json"), `${JSON.stringify({ root, name: "api" }, null, 2)}\n`);
  }

  /** Every entry, by directory name, for the cases that assert on all of them at once. */
  async function inventory(): Promise<readonly MemoryMirrorInfo[]> {
    return await listMemoryMirrors(projectsDir);
  }

  /** The one mirror the case built, read back. */
  async function onlyMirror(name = "api-01234567"): Promise<MemoryMirrorInfo> {
    const mirrors = await inventory();
    const found = mirrors.find((mirror) => mirror.name === name);
    if (found === undefined) throw new Error(`no mirror named ${name} in the inventory`);
    return found;
  }

  beforeEach(() => {
    tempDirs = [];
    projectsDir = scratchDir("nax-mirrors-projects-");
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
  });

  test("a mirror holding only a hidden MCP id cannot be pruned", async () => {
    const dirs = { root: projectsDir, projectDir: mirrorDir(), userDir: join(projectsDir, "user") };
    const ids = createMcpIdMap({ dirs, server: "mcp" });
    await ids.add("project", "forgotten", ["remote"]);
    await ids.hide("project", "forgotten");
    expect(isPrunableMirror(await onlyMirror())).toBe(false);
  });

  test("a user-scope Koda approval protects the project mirror", async () => {
    await createKodaApprovals({ dir: mirrorDir(), logger: makeLogger() }).record({
      scope: "user",
      approvalId: "waiting",
      slug: "proposal",
      clientId: "proposed",
    });
    expect(isPrunableMirror(await onlyMirror())).toBe(false);
  });

  test("AC-6 returns one entry per directory, named after the directory", async () => {
    mirrorDir("api-01234567");
    mirrorDir("billing-89abcdef");
    writeFileSync(join(projectsDir, "stray.txt"), "not a mirror\n");

    const mirrors = await inventory();

    expect(mirrors.map((mirror) => ({ dir: basename(mirror.dir), name: mirror.name }))).toEqual([
      { dir: "api-01234567", name: "api-01234567" },
      { dir: "billing-89abcdef", name: "billing-89abcdef" },
    ]);
  });

  test("AC-6 returns nothing for a projects directory that does not exist", async () => {
    cleanupTempDir(projectsDir);

    expect(await inventory()).toEqual([]);
  });

  test("AC-7 counts the notes/*.md files", async () => {
    const dir = mirrorDir();
    writeNote(dir, "alpha");
    writeNote(dir, "beta");
    writeFileSync(join(dir, "notes", "not-a-note.txt"), "ignored\n");

    expect((await onlyMirror()).notes).toBe(2);
  });

  test("AC-7 counts no note for a mirror holding no notes directory", async () => {
    mirrorDir();

    expect((await onlyMirror()).notes).toBe(0);
  });

  test("AC-8 counts the outbox entry files and not a half-written stage", async () => {
    const dir = mirrorDir();
    writeOutboxEntry(dir, 1, "c_one");
    writeOutboxEntry(dir, 2, "c_two");
    writeFileSync(join(dir, "outbox", "00000003-c_three.json.tmp"), "{}\n");

    expect((await onlyMirror()).outbox).toBe(2);
  });

  test("AC-9 reads the provider the mirror's sync.json records", async () => {
    writeSyncState(mirrorDir(), "koda:rs-stock");

    expect((await onlyMirror()).provider).toBe("koda:rs-stock");
  });

  test("AC-9 reports a null provider for a mirror with no sync.json", async () => {
    mirrorDir();

    expect((await onlyMirror()).provider).toBeNull();
  });

  test("AC-9 reports a null provider for a sync.json this listing cannot read", async () => {
    const dir = mirrorDir();
    writeFileSync(join(dir, "sync.json"), "not json\n");

    expect((await onlyMirror()).provider).toBeNull();
  });

  test("AC-10 reads the origin root and finds it still on disk", async () => {
    const checkout = scratchDir("nax-mirrors-checkout-");
    writeOrigin(mirrorDir(), checkout);

    expect(await onlyMirror()).toMatchObject({ originRoot: checkout, rootExists: true });
  });

  test("AC-10 reads the origin root and reports it gone", async () => {
    const checkout = join(scratchDir("nax-mirrors-checkout-"), "deleted-checkout");
    writeOrigin(mirrorDir(), checkout);

    expect(await onlyMirror()).toMatchObject({ originRoot: checkout, rootExists: false });
  });

  test("AC-11 reports both the origin root and its existence as null with no origin.json", async () => {
    mirrorDir();

    expect(await onlyMirror()).toMatchObject({ originRoot: null, rootExists: null });
  });

  test("AC-11 reports both as null when origin.json records no root", async () => {
    const dir = mirrorDir();
    writeFileSync(join(dir, "origin.json"), `${JSON.stringify({ name: "api" })}\n`);

    expect(await onlyMirror()).toMatchObject({ originRoot: null, rootExists: null });
  });

  test("AC-12 reports the byte size of the mirror's MEMORY.md", async () => {
    writeIndex(mirrorDir(), 512);

    expect((await onlyMirror()).indexBytes).toBe(512);
  });

  test("AC-12 reports 0 bytes for a mirror with no MEMORY.md", async () => {
    mirrorDir();

    expect((await onlyMirror()).indexBytes).toBe(0);
  });

  test("AC-13 reports a mirror whose sync.lock exists as in use", async () => {
    const dir = mirrorDir();
    writeFileSync(join(dir, "sync.lock"), "");

    expect((await onlyMirror()).inUse).toBe(true);
  });

  test("AC-13 reports a mirror with no sync.lock as not in use", async () => {
    mirrorDir();

    expect((await onlyMirror()).inUse).toBe(false);
  });

  test("AC-14 reports an archive directory as the mirror having an archive", async () => {
    const dir = mirrorDir();
    mkdirSync(join(dir, "archive"), { recursive: true });
    mkdirSync(join(dir, "archive", "20261125T101500Z-3fa2c1"), { recursive: true });

    expect((await onlyMirror()).hasArchive).toBe(true);
  });

  test("AC-14 reports no archive for a mirror without an archive directory", async () => {
    mirrorDir();

    expect((await onlyMirror()).hasArchive).toBe(false);
  });

  test("AC-15 counts the decisions and pending-forget lines the mirror holds", async () => {
    const dir = mirrorDir();
    writeLines(dir, "decisions.jsonl", ['{"id":"d1"}', '{"id":"d2"}']);
    writeLines(dir, "pending-forgets.jsonl", ['{"clientId":"c_one"}']);

    expect(await onlyMirror()).toMatchObject({ decisions: 2, pendingForgets: 1 });
  });

  test("AC-15 counts nothing for a mirror with neither record file", async () => {
    mirrorDir();

    expect(await onlyMirror()).toMatchObject({ decisions: 0, pendingForgets: 0 });
  });

  test("F1 reports a mirror it read whole as holding nothing unreadable", async () => {
    mirrorDir();

    const mirror = await onlyMirror();

    expect({ unreadable: mirror.unreadable, prunable: isPrunableMirror(mirror) }).toEqual({
      unreadable: [],
      prunable: true,
    });
  });

  test.each(["notes", "outbox"])("F1 reports a mirror whose %s directory cannot be listed", async (name) => {
    // A self-referential link fails the listing with ELOOP as any user, which no permission
    // bit can be relied on to do: the point is a directory that is *there* and unlistable.
    const dir = mirrorDir();
    symlinkSync(join(dir, name), join(dir, name));

    const mirror = await onlyMirror();

    expect({ unreadable: mirror.unreadable, prunable: isPrunableMirror(mirror) }).toEqual({
      unreadable: [join(dir, name)],
      prunable: false,
    });
  });

  test.each(["decisions.jsonl", "sync.json", "MEMORY.md"])(
    "F1 reports a mirror whose %s cannot be read",
    async (name) => {
      const dir = mirrorDir();
      symlinkSync(join(dir, name), join(dir, name));

      const mirror = await onlyMirror();

      expect({ unreadable: mirror.unreadable, prunable: isPrunableMirror(mirror) }).toEqual({
        unreadable: [join(dir, name)],
        prunable: false,
      });
    },
  );

  test("F1 reports a mirror whose sync.lock is a link as in use", async () => {
    const dir = mirrorDir();
    symlinkSync(join(dir, "absent-target"), join(dir, "sync.lock"));

    const mirror = await onlyMirror();

    expect({ unreadable: mirror.unreadable, inUse: mirror.inUse, prunable: isPrunableMirror(mirror) }).toEqual({
      unreadable: [],
      inUse: true,
      prunable: false,
    });
  });

  // ─── an outbox entry this read cannot count (US-021 D-5) ───────────────────
  //
  // The outbox is counted by entry type, and an entry that is not a plain file is a write this
  // read cannot see. Skipping such an entry would report an outbox of 0 and let `--prune` delete a
  // mirror that still holds an undelivered write, so every one of them joins `unreadable`.

  /** One outbox entry path inside a mirror, whether or not anything usable sits there. */
  function outboxEntry(dir: string, seq = 1): string {
    return join(dir, "outbox", `${String(seq).padStart(8, "0")}-c_one.json`);
  }

  test("D-5 marks a dangling link at an outbox entry name, so the mirror is not prunable", async () => {
    const dir = mirrorDir();
    mkdirSync(join(dir, "outbox"), { recursive: true });
    const entry = outboxEntry(dir);
    symlinkSync(join(dir, "absent-target"), entry);

    const mirror = await onlyMirror();

    expect({ outbox: mirror.outbox, unreadable: mirror.unreadable, prunable: isPrunableMirror(mirror) }).toEqual({
      outbox: 0,
      unreadable: [entry],
      prunable: false,
    });
  });

  test("D-5 marks a link to a readable file too: no symlink is followed", async () => {
    const dir = mirrorDir();
    mkdirSync(join(dir, "outbox"), { recursive: true });
    const target = join(dir, "target.json");
    writeFileSync(target, "{}\n");
    const entry = outboxEntry(dir);
    symlinkSync(target, entry);

    const mirror = await onlyMirror();

    expect({ outbox: mirror.outbox, unreadable: mirror.unreadable }).toEqual({ outbox: 0, unreadable: [entry] });
  });

  test("D-5 marks a directory named like an outbox entry", async () => {
    const dir = mirrorDir();
    const entry = outboxEntry(dir);
    mkdirSync(entry, { recursive: true });

    const mirror = await onlyMirror();

    expect({ outbox: mirror.outbox, unreadable: mirror.unreadable, prunable: isPrunableMirror(mirror) }).toEqual({
      outbox: 0,
      unreadable: [entry],
      prunable: false,
    });
  });

  test("D-5 keeps the regular counts and the .json.tmp exclusion beside an uncountable entry", async () => {
    const dir = mirrorDir();
    writeOutboxEntry(dir, 1, "c_one");
    writeOutboxEntry(dir, 2, "c_two");
    writeFileSync(join(dir, "outbox", "00000003-c_three.json.tmp"), "{}\n");
    const entry = outboxEntry(dir, 4);
    symlinkSync(join(dir, "absent-target"), entry);

    const mirror = await onlyMirror();

    expect({ outbox: mirror.outbox, unreadable: mirror.unreadable, prunable: isPrunableMirror(mirror) }).toEqual({
      outbox: 2,
      unreadable: [entry],
      prunable: false,
    });
  });

  test("D-5 leaves a half-written stage file out of both the count and the unreadable paths", async () => {
    const dir = mirrorDir();
    mkdirSync(join(dir, "outbox"), { recursive: true });
    const stage = join(dir, "outbox", "00000001-c_one.json.tmp");
    symlinkSync(join(dir, "absent-target"), stage);

    const mirror = await onlyMirror();

    expect({ outbox: mirror.outbox, unreadable: mirror.unreadable, prunable: isPrunableMirror(mirror) }).toEqual({
      outbox: 0,
      unreadable: [],
      prunable: true,
    });
  });
});

describe("isPrunableMirror", () => {
  test.each([
    ["a root that still exists", true],
    ["a root that is gone", false],
    ["no origin at all", null],
  ])("AC-16 accepts an empty mirror with %s", (_label, rootExists) => {
    expect(isPrunableMirror(emptyMirror({ rootExists }))).toBe(true);
  });

  test("AC-17 refuses a mirror holding a note", () => {
    expect(isPrunableMirror(emptyMirror({ notes: 1 }))).toBe(false);
  });

  test("AC-18 refuses a mirror holding an outbox entry", () => {
    expect(isPrunableMirror(emptyMirror({ outbox: 1 }))).toBe(false);
  });

  test("AC-19 refuses a mirror holding a compaction archive", () => {
    expect(isPrunableMirror(emptyMirror({ hasArchive: true }))).toBe(false);
  });

  test("AC-20 refuses a mirror holding a decision", () => {
    expect(isPrunableMirror(emptyMirror({ decisions: 1 }))).toBe(false);
  });

  test("AC-21 refuses a mirror holding a pending forget", () => {
    expect(isPrunableMirror(emptyMirror({ pendingForgets: 1 }))).toBe(false);
  });

  test("AC-22 refuses a mirror whose sync.lock exists", () => {
    expect(isPrunableMirror(emptyMirror({ inUse: true }))).toBe(false);
  });
});
