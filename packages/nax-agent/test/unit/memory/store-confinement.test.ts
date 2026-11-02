/**
 * The mirror store's path confinement, split out of `store.test.ts` by concern
 * (the store file was already at its split target): a note path, and the notes
 * directory itself, may not resolve outside the scope root; publication through
 * `writeFileAtomic` is checked for its staged-then-renamed shape and for what a
 * failed rename leaves behind.
 *
 * The last block is the check-to-use gap: each test swaps in an escaping symlink
 * from *inside* the seam the store calls after its check, which is deterministic
 * (no sleeping, no thread) and is exactly the window a plain check leaves open.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createMemoryStore, type MemoryNote, serializeMemoryNote } from "@nathapp/nax-agent";
import { _atomicWriteDeps } from "#src/internal/atomic-write";
import { _memoryStoreDeps } from "#src/memory/store";
import { assertNaxError, makeLogger, withDepsRestore, withTempDir } from "#test/helpers/index";

/** One note, with overrides: the example from the memory-store design. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    body: "The replay budget stays at 2,048 MiB. Next export append is due ~11-23.",
    ...overrides,
  };
}

/** A project directory the store has to create for itself. */
function projectPath(dir: string): string {
  return join(dir, "project");
}

/** Drop a file into the mirror by hand, creating its directory. */
async function writeFixture(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, text);
}

/** The rejection of `promise`, or `null` when it resolves. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** Both seams the store and the atomic write read: restored after every test. */
function withStoreSeams(): void {
  withDepsRestore(_memoryStoreDeps);
  withDepsRestore(_atomicWriteDeps);
}

describe("memory store confinement", () => {
  withStoreSeams();

  test("AC-1: a traversal slug is MEMORY_SLUG_INVALID and nothing is created or written", async () => {
    await withTempDir(async (dir) => {
      const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
      const touched: string[] = [];
      _memoryStoreDeps.mkdir = async () => {
        touched.push("mkdir");
        return undefined;
      };
      _atomicWriteDeps.writeFile = async () => {
        touched.push("writeFile");
      };

      const error = await caught(store.writeNote(note({ slug: "../escape" })));

      assertNaxError(error, "writeNote with a traversal slug");
      expect(error).toMatchObject({ code: "MEMORY_SLUG_INVALID", context: { stage: "memory", slug: "../escape" } });
      expect(touched).toEqual([]);
      // The slug names a file outside the mirror; the store must not reach for it either.
      expect(existsSync(join(projectPath(dir), "escape.md"))).toBe(false);
      expect(existsSync(join(dir, "escape.md"))).toBe(false);
    });
  });

  test("AC-2: a notes directory linked outside the project is MEMORY_PATH_OUTSIDE and stays empty", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const outside = join(dir, "outside");
      await mkdir(project, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(project, "notes"));
      const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

      const error = await caught(store.writeNote(note()));

      assertNaxError(error, "writeNote with the notes directory linked outside");
      expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory", scope: "project" } });
      expect(await readdir(outside)).toEqual([]);
    });
  });

  test("AC-3: a note file linked outside the project is MEMORY_PATH_OUTSIDE on read", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const notesDir = join(project, "notes");
      const outsideFile = join(dir, "outside-note.md");
      // Valid note content: only the link's destination decides the outcome.
      await writeFixture(outsideFile, serializeMemoryNote(note()));
      await mkdir(notesDir, { recursive: true });
      await symlink(outsideFile, join(notesDir, "replay-budget.md"));
      const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

      const error = await caught(store.readNote("project", "replay-budget"));

      assertNaxError(error, "readNote of a note linked outside");
      expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory", scope: "project" } });
    });
  });

  test("AC-4: listNotes skips a note linked outside with one warn and returns the rest", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const notesDir = join(project, "notes");
      const logger = makeLogger();
      const store = createMemoryStore({ projectDir: project, logger });
      await store.writeNote(note({ slug: "kept-budget" }));
      const outsideFile = join(dir, "outside-note.md");
      await writeFixture(outsideFile, serializeMemoryNote(note({ slug: "escaped-budget" })));
      const linked = join(notesDir, "escaped-budget.md");
      await symlink(outsideFile, linked);

      const notes = await store.listNotes("project");

      expect(notes.map((entry) => entry.slug)).toEqual(["kept-budget"]);
      const warns = logger.calls.filter((call) => call.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.stage).toBe("memory");
      expect(warns[0]?.data?.path).toBe(linked);
      expect(String(warns[0]?.data?.error)).toContain("outside the memory scope root");
    });
  });

  test("deleteNote of a note linked outside is MEMORY_PATH_OUTSIDE and removes nothing", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const notesDir = join(project, "notes");
      const outsideFile = join(dir, "outside-note.md");
      await writeFixture(outsideFile, serializeMemoryNote(note()));
      await mkdir(notesDir, { recursive: true });
      await symlink(outsideFile, join(notesDir, "replay-budget.md"));
      const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

      const error = await caught(store.deleteNote("project", "replay-budget"));

      assertNaxError(error, "deleteNote of a note linked outside");
      expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
      // Neither the link nor the file it points at may be removed.
      expect(existsSync(join(notesDir, "replay-budget.md"))).toBe(true);
      expect(existsSync(outsideFile)).toBe(true);
    });
  });

  test("AC-5: writeNote stages a .tmp file in the notes directory and renames it onto the note", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const notesDir = join(project, "notes");
      const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
      const calls: string[] = [];
      const realWriteFile = _atomicWriteDeps.writeFile;
      const realRename = _atomicWriteDeps.rename;
      _atomicWriteDeps.writeFile = async (path, content, options) => {
        calls.push(`writeFile ${path}`);
        await realWriteFile(path, content, options);
      };
      _atomicWriteDeps.rename = async (from, to) => {
        calls.push(`rename ${String(from)} ${String(to)}`);
        await realRename(from, to);
      };

      await store.writeNote(note());

      const final = join(notesDir, "replay-budget.md");
      expect(calls).toHaveLength(2);
      const [stageCall, publishCall] = calls;
      const staged = (stageCall ?? "").replace("writeFile ", "");
      expect(stageCall).toBe(`writeFile ${staged}`);
      expect(dirname(staged)).toBe(notesDir);
      expect(staged.endsWith(".tmp")).toBe(true);
      expect(publishCall).toBe(`rename ${staged} ${final}`);
      expect(existsSync(final)).toBe(true);
    });
  });

  test("AC-6: a failed rename rejects writeNote and leaves no note and no .tmp file", async () => {
    await withTempDir(async (dir) => {
      const notesDir = join(projectPath(dir), "notes");
      const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
      const failure = new Error("rename failed");
      _atomicWriteDeps.rename = async () => {
        throw failure;
      };

      const error = await caught(store.writeNote(note()));

      expect(error).toBe(failure);
      expect(existsSync(notesDir)).toBe(true);
      expect(existsSync(join(notesDir, "replay-budget.md"))).toBe(false);
      expect((await readdir(notesDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("a symlink swapped in after the check", () => {
    test("readNote refuses a note replaced by an outside link between the check and the read", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        await store.writeNote(note({ slug: "kept-budget" }));
        const outsideFile = join(dir, "outside-note.md");
        await writeFixture(outsideFile, serializeMemoryNote(note({ slug: "kept-budget", body: "leaked body" })));
        const realReadFile = _memoryStoreDeps.readFile;
        // The swap happens *inside* the read: everything the store checked is now a lie.
        _memoryStoreDeps.readFile = async (path, options) => {
          await unlink(path);
          await symlink(outsideFile, path);
          return realReadFile(path, options);
        };

        const error = await caught(store.readNote("project", "kept-budget"));

        assertNaxError(error, "readNote of a note linked outside after the check");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
      });
    });

    test("listNotes skips a note swapped for an outside link mid-listing, with one warn", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const logger = makeLogger();
        const store = createMemoryStore({ projectDir: project, logger });
        await store.writeNote(note({ slug: "kept-budget" }));
        await store.writeNote(note({ slug: "swapped-budget" }));
        const outsideFile = join(dir, "outside-note.md");
        await writeFixture(outsideFile, serializeMemoryNote(note({ slug: "swapped-budget", body: "leaked body" })));
        const realReadFile = _memoryStoreDeps.readFile;
        _memoryStoreDeps.readFile = async (path, options) => {
          if (path.endsWith("swapped-budget.md")) {
            await unlink(path);
            await symlink(outsideFile, path);
          }
          return realReadFile(path, options);
        };

        const notes = await store.listNotes("project");

        expect(notes.map((entry) => entry.slug)).toEqual(["kept-budget"]);
        const warns = logger.calls.filter((call) => call.level === "warn");
        expect(warns).toHaveLength(1);
        expect(String(warns[0]?.data?.error)).toContain("outside the memory scope root");
      });
    });

    test("writeNote refuses a notes directory swapped for an outside link before the write", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const notesDir = join(project, "notes");
        const outside = join(dir, "outside");
        await mkdir(project, { recursive: true });
        await mkdir(outside, { recursive: true });
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const realMkdir = _memoryStoreDeps.mkdir;
        // Between the store's check and its write the directory becomes a link out of the root.
        _memoryStoreDeps.mkdir = async (path, options) => {
          const made = await realMkdir(path, options);
          await rmdir(notesDir);
          await symlink(outside, notesDir);
          return made;
        };

        const error = await caught(store.writeNote(note()));

        assertNaxError(error, "writeNote after the notes directory was swapped for a link");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
        expect(await readdir(outside)).toEqual([]);
      });
    });
  });
});
