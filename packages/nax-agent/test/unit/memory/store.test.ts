import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as pub from "@nathapp/nax-agent";
import { createMemoryStore, type MemoryNote, type MemoryStore, serializeMemoryNote } from "@nathapp/nax-agent";
import * as internal from "@nathapp/nax-agent/internal";
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

describe("memory store", () => {
  withDepsRestore(_memoryStoreDeps);

  describe("paths", () => {
    test("AC-1: the index, notes, lock and outbox sit under projectDir", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store: MemoryStore = createMemoryStore({ projectDir: project, logger: makeLogger() });

        expect({
          index: store.paths.index,
          notesDir: store.paths.notesDir,
          lock: store.paths.lock,
          outboxDir: store.paths.outboxDir,
        }).toEqual({
          index: join(project, "MEMORY.md"),
          notesDir: join(project, "notes"),
          lock: join(project, "sync.lock"),
          outboxDir: join(project, "outbox"),
        });
        // The two remaining project files the rest of the feature reaches through these paths.
        expect(store.paths.projectDir).toBe(project);
        expect(store.paths.decisions).toBe(join(project, "decisions.jsonl"));
        expect(store.paths.syncState).toBe(join(project, "sync.json"));
      });
    });

    test("AC-2: no userDir means no user paths; a userDir points at its index and notes", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const user = join(dir, "user");

        const anonymous = createMemoryStore({ projectDir: project, logger: makeLogger() });
        expect({
          userDir: anonymous.paths.userDir,
          userIndex: anonymous.paths.userIndex,
          userNotesDir: anonymous.paths.userNotesDir,
        }).toEqual({ userDir: null, userIndex: null, userNotesDir: null });

        const scoped = createMemoryStore({ projectDir: project, userDir: user, logger: makeLogger() });
        expect(scoped.paths.userDir).toBe(user);
        expect(scoped.paths.userIndex).toBe(join(user, "MEMORY.md"));
        expect(scoped.paths.userNotesDir).toBe(join(user, "notes"));
      });
    });
  });

  describe("writeNote and readNote", () => {
    test("AC-3: a project note written and read back is structurally equal", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
        const written = note();

        await store.writeNote(written);

        expect(await store.readNote("project", written.slug)).toEqual(written);
      });
    });

    test("AC-4: the file holds exactly serializeMemoryNote's text, and notes/ is created on demand", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const notesDir = join(project, "notes");
        expect(existsSync(notesDir)).toBe(false);

        const written = note();
        await store.writeNote(written);

        expect(existsSync(notesDir)).toBe(true);
        expect(await Bun.file(join(notesDir, `${written.slug}.md`)).text()).toBe(serializeMemoryNote(written));
      });
    });

    test("AC-4: the notes directory is created through the injected seam", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const realMkdir = _memoryStoreDeps.mkdir;
        const seen: string[] = [];
        _memoryStoreDeps.mkdir = async (path, options) => {
          seen.push(path);
          return realMkdir(path, options);
        };

        await store.writeNote(note());

        expect(seen).toEqual([join(project, "notes")]);
        expect(existsSync(join(project, "notes", "replay-budget.md"))).toBe(true);
      });
    });

    test("AC-5: a user note is stored under userDir and read back from there", async () => {
      await withTempDir(async (dir) => {
        const user = join(dir, "user");
        const store = createMemoryStore({ projectDir: projectPath(dir), userDir: user, logger: makeLogger() });
        const written = note({ scope: "user", slug: "workspace-layout" });

        await store.writeNote(written);

        expect(await Bun.file(join(user, "notes", "workspace-layout.md")).text()).toBe(serializeMemoryNote(written));
        expect(await store.readNote("user", "workspace-layout")).toEqual(written);
      });
    });

    test("AC-6: a user write on a store without userDir is MEMORY_SCOPE_UNAVAILABLE", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

        const error = await caught(store.writeNote(note({ scope: "user" })));
        assertNaxError(error, "writeNote of a user note without userDir");
        expect(error).toMatchObject({ code: "MEMORY_SCOPE_UNAVAILABLE", context: { stage: "memory", scope: "user" } });

        // The same rule guards every other user-scope entry point.
        await expect(store.readNote("user", "replay-budget")).rejects.toMatchObject({
          code: "MEMORY_SCOPE_UNAVAILABLE",
        });
        await expect(store.listNotes("user")).rejects.toMatchObject({ code: "MEMORY_SCOPE_UNAVAILABLE" });
        await expect(store.deleteNote("user", "replay-budget")).rejects.toMatchObject({
          code: "MEMORY_SCOPE_UNAVAILABLE",
        });
        expect(existsSync(project)).toBe(false);
      });
    });

    test("AC-8: reading a note whose frontmatter does not parse is MEMORY_NOTE_INVALID", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        await writeFixture(join(project, "notes", "half-written.md"), "this file never got its frontmatter\n");

        const error = await caught(store.readNote("project", "half-written"));

        assertNaxError(error, "readNote of a malformed note");
        expect(error).toMatchObject({ code: "MEMORY_NOTE_INVALID", context: { stage: "memory" } });
      });
    });
  });

  describe("a projectDir that does not exist", () => {
    test("AC-7: readNote resolves null, listNotes resolves [] and deleteNote resolves", async () => {
      await withTempDir(async (dir) => {
        const project = join(dir, "never-created");
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

        expect(await store.readNote("project", "replay-budget")).toBeNull();
        expect(await store.listNotes("project")).toEqual([]);
        await expect(store.deleteNote("project", "replay-budget")).resolves.toBeUndefined();
        expect(existsSync(project)).toBe(false);
      });
    });
  });

  describe("listNotes", () => {
    test("AC-9: returns the parseable notes sorted by slug and warns once for the malformed file", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const logger = makeLogger();
        const store = createMemoryStore({ projectDir: project, logger });
        for (const slug of ["mike-budget", "alpha-budget", "zulu-budget"]) {
          await store.writeNote(note({ slug }));
        }
        const malformed = join(project, "notes", "broken-budget.md");
        await writeFixture(malformed, "no frontmatter here\n");

        const notes = await store.listNotes("project");

        expect(notes.map((entry) => entry.slug)).toEqual(["alpha-budget", "mike-budget", "zulu-budget"]);
        const warns = logger.calls.filter((call) => call.level === "warn");
        expect(warns).toHaveLength(1);
        expect(warns[0]?.stage).toBe("memory");
        expect(warns[0]?.data?.path).toBe(malformed);
        expect(String(warns[0]?.data?.error)).toContain("frontmatter");
      });
    });

    test("AC-10: ignores a staged temp file and MEMORY.md in the notes directory", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const logger = makeLogger();
        const store = createMemoryStore({ projectDir: project, logger });
        const notesDir = join(project, "notes");
        await store.writeNote(note());

        // Both files hold a note that would parse: only their names exclude them.
        const text = serializeMemoryNote(note({ slug: "staged-budget" }));
        await writeFixture(join(notesDir, "staged-budget.md.abc.tmp"), text);
        await writeFixture(join(notesDir, "MEMORY.md"), text);

        expect((await store.listNotes("project")).map((entry) => entry.slug)).toEqual(["replay-budget"]);
        // Neither file was read, so neither could be reported as unreadable.
        expect(logger.calls).toEqual([]);
      });
    });
  });

  describe("deleteNote", () => {
    test("AC-11: removes the note file, and an absent slug resolves", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        await store.writeNote(note());
        const path = join(project, "notes", "replay-budget.md");
        expect(existsSync(path)).toBe(true);

        await store.deleteNote("project", "replay-budget");
        expect(existsSync(path)).toBe(false);

        await expect(store.deleteNote("project", "never-written")).resolves.toBeUndefined();
      });
    });
  });

  describe("slug validation", () => {
    test("rejects a slug that is not a slug before touching the filesystem", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
        let touched = 0;
        _memoryStoreDeps.readFile = async () => {
          touched += 1;
          throw new Error("readFile must not be reached");
        };
        _memoryStoreDeps.readdir = async () => {
          touched += 1;
          throw new Error("readdir must not be reached");
        };
        _memoryStoreDeps.rm = async () => {
          touched += 1;
        };
        _memoryStoreDeps.mkdir = async () => {
          touched += 1;
          return undefined;
        };

        for (const slug of ["../escape", "Bad_Slug", ""]) {
          for (const error of [
            await caught(store.readNote("project", slug)),
            await caught(store.writeNote(note({ slug }))),
            await caught(store.deleteNote("project", slug)),
          ]) {
            assertNaxError(error, `a call with slug ${JSON.stringify(slug)}`);
            expect(error).toMatchObject({ code: "MEMORY_SLUG_INVALID", context: { stage: "memory" } });
          }
        }
        expect(touched).toBe(0);
      });
    });
  });

  describe("the package entry's store surface", () => {
    test("AC-12: the package entry exports createMemoryStore", () => {
      expect(pub.createMemoryStore).toBe(createMemoryStore);
      expect(pub.createMemoryStore).toBeFunction();
    });

    test("AC-12: /internal hands out the very seam object the store module reads", () => {
      expect(internal._memoryStoreDeps).toBe(_memoryStoreDeps);
    });
  });
});
