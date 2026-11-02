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
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, rename, rmdir, symlink, unlink } from "node:fs/promises";
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
      _atomicWriteDeps.open = async () => {
        touched.push("open");
        throw new Error("the atomic write must not be reached");
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
      const realOpen = _atomicWriteDeps.open;
      const realRename = _atomicWriteDeps.rename;
      _atomicWriteDeps.open = async (staged, flags, mode) => {
        calls.push(`open ${staged}`);
        const stage = await realOpen(staged, flags, mode);
        return {
          ...stage,
          write: async (content) => {
            calls.push(`write ${staged}`);
            await stage.write(content);
          },
        };
      };
      _atomicWriteDeps.rename = async (from, to) => {
        calls.push(`rename ${String(from)} ${String(to)}`);
        await realRename(from, to);
      };

      await store.writeNote(note());

      // The store writes to the resolved directory (a temp dir may be reached through a link).
      const final = join(realpathSync(notesDir), "replay-budget.md");
      const staged = (calls[0] ?? "").replace("open ", "");
      expect(dirname(staged)).toBe(dirname(final));
      expect(staged.endsWith(".tmp")).toBe(true);
      expect(calls).toEqual([`open ${staged}`, `write ${staged}`, `rename ${staged} ${final}`]);
      expect(existsSync(join(notesDir, "replay-budget.md"))).toBe(true);
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

  describe("a path swapped after the check", () => {
    test("readNote refuses a note replaced by an outside link inside the read", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        await store.writeNote(note({ slug: "kept-budget" }));
        const outsideFile = join(dir, "outside-note.md");
        await writeFixture(outsideFile, serializeMemoryNote(note({ slug: "kept-budget", body: "leaked body" })));
        const realOpen = _memoryStoreDeps.open;
        // The swap happens *inside* the read: everything the store checked is now a lie.
        _memoryStoreDeps.open = async (path, flags) => {
          await unlink(path);
          await symlink(outsideFile, path);
          return realOpen(path, flags);
        };

        const error = await caught(store.readNote("project", "kept-budget"));

        assertNaxError(error, "readNote of a note linked outside after the check");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
      });
    });

    test("readNote refuses a notes directory swapped for an outside link inside the read", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const notesDir = join(project, "notes");
        const aside = join(project, "notes-aside");
        const outside = join(dir, "outside");
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        await store.writeNote(note({ slug: "kept-budget" }));
        await mkdir(outside, { recursive: true });
        await writeFixture(
          join(outside, "kept-budget.md"),
          serializeMemoryNote(note({ slug: "kept-budget", body: "leaked body" })),
        );
        const realOpen = _memoryStoreDeps.open;
        // A different directory now answers for the checked path, holding a note of the same
        // name: the path still resolves "inside" nothing the store verified.
        _memoryStoreDeps.open = async (path, flags) => {
          await rename(notesDir, aside);
          await symlink(outside, notesDir);
          return realOpen(path, flags);
        };

        const error = await caught(store.readNote("project", "kept-budget"));

        assertNaxError(error, "readNote after the notes directory was swapped mid-read");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
      });
    });

    test("[B2] readNote returns no outside bytes when the parent is swapped before the stat", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const notesDir = join(project, "notes");
        const aside = join(project, "notes-aside");
        const outside = join(dir, "outside");
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        await store.writeNote(note({ slug: "kept-budget" }));
        await mkdir(outside, { recursive: true });
        await writeFixture(
          join(outside, "kept-budget.md"),
          serializeMemoryNote(note({ slug: "kept-budget", body: "leaked body" })),
        );
        const realStat = _memoryStoreDeps.stat;
        let swapped = false;
        // The one window a pre-open check cannot close: the parent becomes an outside link
        // before the identity the read will be held to is taken, so a store that trusts that
        // identity reads the outside file and both sides agree with each other.
        _memoryStoreDeps.stat = async (path) => {
          if (!swapped && path.endsWith("kept-budget.md")) {
            swapped = true;
            await rename(notesDir, aside);
            await symlink(outside, notesDir);
          }
          return realStat(path);
        };

        const error = await caught(store.readNote("project", "kept-budget"));

        expect(swapped).toBe(true);
        assertNaxError(error, "readNote after the parent was swapped before the stat");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
      });
    });

    test("listNotes reports a listing taken from a directory swapped mid-listing", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const notesDir = join(project, "notes");
        const aside = join(project, "notes-aside");
        const outside = join(dir, "outside");
        const logger = makeLogger();
        const store = createMemoryStore({ projectDir: project, logger });
        await store.writeNote(note({ slug: "kept-budget" }));
        await mkdir(outside, { recursive: true });
        await writeFixture(
          join(outside, "kept-budget.md"),
          serializeMemoryNote(note({ slug: "kept-budget", body: "leaked body" })),
        );
        const realReaddir = _memoryStoreDeps.readdir;
        // The listing is honest; the directory it named is gone by the time it returns.
        _memoryStoreDeps.readdir = async (path, options) => {
          const entries = await realReaddir(path, options);
          await rename(notesDir, aside);
          await symlink(outside, notesDir);
          return entries;
        };

        const error = await caught(store.listNotes("project"));

        // Names read from a directory that was replaced cannot be trusted to name its notes.
        assertNaxError(error, "listNotes after the notes directory was swapped mid-listing");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
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

    test("writeNote refuses a notes directory replaced while the note is staged", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const notesDir = join(project, "notes");
        const aside = join(project, "notes-aside");
        await mkdir(project, { recursive: true });
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const realOpen = _atomicWriteDeps.open;
        _atomicWriteDeps.open = async (staged, flags, mode) => {
          const stage = await realOpen(staged, flags, mode);
          return {
            ...stage,
            write: async (content) => {
              await stage.write(content);
              // The directory the note was staged in is moved aside and another takes its
              // place: no symlink is involved, so only the directory's identity gives it away.
              await rename(notesDir, aside);
              await mkdir(notesDir);
            },
          };
        };

        const error = await caught(store.writeNote(note()));

        assertNaxError(error, "writeNote after the notes directory was replaced while staging");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
        // The note is published nowhere: not in the replacement, not in the directory it was staged in.
        expect(await readdir(notesDir)).toEqual([]);
        expect(existsSync(join(aside, "replay-budget.md"))).toBe(false);
      });
    });

    test.each(["open", "publish", "cleanup"])("writeNote never reaches a replacement during %s", async (operation) => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const notesDir = join(project, "notes");
        const outside = join(dir, "outside");
        const aside = join(project, "aside");
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        await mkdir(outside);
        const swap = async () => {
          await rename(notesDir, aside);
          await symlink(outside, notesDir);
        };
        if (operation === "open") {
          const realOpen = _atomicWriteDeps.open;
          _atomicWriteDeps.open = async (path, flags, mode) => {
            await swap();
            await writeFixture(path, "foreign stage");
            return realOpen(path, flags, mode);
          };
        } else if (operation === "publish") {
          const realRename = _atomicWriteDeps.rename;
          _atomicWriteDeps.rename = async (from, to) => {
            // Make the source exist in the replacement too, so a path rename can succeed.
            await swap();
            await writeFixture(String(from), "foreign stage");
            await realRename(from, to);
          };
        } else {
          const realDiscard = _atomicWriteDeps.discard;
          _atomicWriteDeps.rename = async () => {
            throw new Error("publish refused");
          };
          // The replacement lands before the cleanup runs: the entry the caller will try to
          // remove is no longer the file it staged.
          _atomicWriteDeps.discard = async (path, created) => {
            await swap();
            await writeFixture(String(path), "foreign stage");
            await realDiscard(path, created);
          };
        }
        const error = await caught(store.writeNote(note()));
        if (operation !== "cleanup") {
          assertNaxError(error, `writeNote with a parent swapped during ${operation}`);
          expect(error.code).toBe("MEMORY_PATH_OUTSIDE");
        }
        const names = await readdir(outside);
        expect(names).toHaveLength(1);
        expect(names[0]?.endsWith(".tmp")).toBe(true);
        expect(await Bun.file(join(outside, names[0] ?? "")).text()).toBe("foreign stage");
        expect((await readdir(aside)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      });
    });

    test("writeNote takes back a note published into a directory swapped before the rename", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const notesDir = join(project, "notes");
        // The directory leaves the root, taking the staged file with it.
        const aside = join(dir, "notes-aside");
        await mkdir(project, { recursive: true });
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const realRename = _atomicWriteDeps.rename;
        // The swap lands in the one window a path-based rename cannot close: after the last
        // check, inside the publish itself.
        _atomicWriteDeps.rename = async (from, to) => {
          await rename(notesDir, aside);
          await symlink(aside, notesDir);
          await realRename(from, to);
        };

        const error = await caught(store.writeNote(note()));

        assertNaxError(error, "writeNote after the notes directory was swapped before the rename");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
        // The published note is taken back by identity: it does not survive outside the root.
        expect(await readdir(aside)).toEqual([]);
      });
    });

    test("deleteNote reports a remove raced by a directory swap", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const notesDir = join(project, "notes");
        const aside = join(project, "notes-aside");
        const outside = join(dir, "outside");
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        await store.writeNote(note());
        await mkdir(outside, { recursive: true });
        const realRm = _memoryStoreDeps.rm;
        await writeFixture(join(outside, "replay-budget.md"), "outside sentinel");
        // Swap BEFORE unlink, not after: detecting damage afterwards is insufficient.
        _memoryStoreDeps.rm = async (path, options) => {
          await rename(notesDir, aside);
          await symlink(outside, notesDir);
          await realRm(path, options);
        };

        const error = await caught(store.deleteNote("project", "replay-budget"));

        assertNaxError(error, "deleteNote raced by a directory swap");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory" } });
        expect(await Bun.file(join(outside, "replay-budget.md")).text()).toBe("outside sentinel");
      });
    });
  });
});
