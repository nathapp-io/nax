/**
 * The store's record files, split from `store.test.ts` by concern: the
 * decisions mirror (one MemoryDecision per line, read-only here), the sync
 * state and the generated `MEMORY.md` of each scope.
 *
 * Reads go through the store's `open` seam — a no-follow descriptor confined to
 * the store directory — and writes through `_atomicWriteDeps`, so a test can
 * watch what the store actually reaches for rather than inferring it from the
 * file that ends up on disk. The last block covers the confinement itself: a
 * link at a record file must not make the store read bytes from outside it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createMemoryStore, type MemoryDecision, type MemorySyncState } from "@nathapp/nax-agent";
import { _atomicWriteDeps } from "#src/internal/atomic-write";
import { _memoryStoreDeps } from "#src/memory/store";
import { assertNaxError, makeLogger, withDepsRestore, withTempDir } from "#test/helpers/index";

/** One decision, with overrides. */
function decision(overrides: Partial<MemoryDecision> = {}): MemoryDecision {
  return {
    id: "dec_01J9X2",
    subject: "the replay budget",
    predicate: "stays at",
    object: "2,048 MiB",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    ...overrides,
  };
}

/** One sync state, with overrides. */
function syncState(overrides: Partial<MemorySyncState> = {}): MemorySyncState {
  return {
    provider: "local",
    cursor: { project: "c1", user: "u1" },
    lastPullAt: "2026-11-02T08:11:00.000Z",
    lastError: null,
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

/** The lines a JSONL file holds, blank lines dropped. */
async function jsonLines(path: string): Promise<unknown[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** Both seams the record reads and the atomic writes go through. */
function withStoreSeams(): void {
  withDepsRestore(_memoryStoreDeps);
  withDepsRestore(_atomicWriteDeps);
}

/** Record the destination of every rename the atomic write publishes through. */
function recordRenames(): string[] {
  const targets: string[] = [];
  const realRename = _atomicWriteDeps.rename;
  _atomicWriteDeps.rename = async (from, to) => {
    targets.push(String(to));
    await realRename(from, to);
  };
  return targets;
}

describe("memory store records", () => {
  withStoreSeams();

  describe("decisions", () => {
    test("AC-1: writeDecisions then readDecisions round-trips, one JSON object per line", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const first = decision();
        const second = decision({ id: "dec_02J9X3", object: "200 notes per page" });

        await store.writeDecisions([first, second]);

        expect(await store.readDecisions()).toEqual([first, second]);
        expect(await jsonLines(join(project, "decisions.jsonl"))).toEqual([first, second]);
      });
    });

    test("AC-1: an empty mirror holds no lines and reads as []", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

        await store.writeDecisions([]);

        expect(await jsonLines(join(project, "decisions.jsonl"))).toEqual([]);
        expect(await store.readDecisions()).toEqual([]);
      });
    });

    test("AC-2: a missing decisions file resolves [] and is not created", async () => {
      await withTempDir(async (dir) => {
        const project = join(dir, "never-created");
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

        expect(await store.readDecisions()).toEqual([]);
        expect(existsSync(project)).toBe(false);
      });
    });

    test("AC-3: a line that is not valid JSON is skipped with one warn, the rest are read", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const path = join(project, "decisions.jsonl");
        const first = decision();
        const second = decision({ id: "dec_02J9X3" });
        await writeFixture(path, `${JSON.stringify(first)}\nnot json at all\n${JSON.stringify(second)}\n`);
        const logger = makeLogger();
        const store = createMemoryStore({ projectDir: project, logger });

        expect(await store.readDecisions()).toEqual([first, second]);

        const warns = logger.calls.filter((call) => call.level === "warn");
        expect(warns).toHaveLength(1);
        expect(warns[0]?.stage).toBe("memory");
        expect(warns[0]?.data?.path).toBe(path);
        // The line is named so the bad entry can be found in the mirror.
        expect(warns[0]?.data?.line).toBe(2);
      });
    });

    test("AC-3: a JSON line that is not a decision is skipped with one warn", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const path = join(project, "decisions.jsonl");
        const kept = decision();
        // Valid JSON, wrong shape: reading it as a decision would hand the index a blank line.
        await writeFixture(path, `${JSON.stringify({ id: "dec_broken" })}\n${JSON.stringify(kept)}\n`);
        const logger = makeLogger();
        const store = createMemoryStore({ projectDir: project, logger });

        expect(await store.readDecisions()).toEqual([kept]);
        expect(logger.calls.filter((call) => call.level === "warn")).toHaveLength(1);
      });
    });
  });

  describe("sync state", () => {
    const DEFAULT_STATE: MemorySyncState = {
      provider: null,
      cursor: { project: null, user: null },
      lastPullAt: null,
      lastError: null,
    };

    test("AC-4: a missing sync state resolves the defaults and is not created", async () => {
      await withTempDir(async (dir) => {
        const project = join(dir, "never-created");
        const logger = makeLogger();
        const store = createMemoryStore({ projectDir: project, logger });

        expect(await store.readSyncState()).toEqual(DEFAULT_STATE);
        expect(existsSync(project)).toBe(false);
        expect(logger.calls).toEqual([]);
      });
    });

    test("AC-5: a sync state holding not json resolves the defaults with one warn", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const path = join(project, "sync.json");
        await writeFixture(path, "not json\n");
        const logger = makeLogger();
        const store = createMemoryStore({ projectDir: project, logger });

        expect(await store.readSyncState()).toEqual(DEFAULT_STATE);

        const warns = logger.calls.filter((call) => call.level === "warn");
        expect(warns).toHaveLength(1);
        expect(warns[0]?.stage).toBe("memory");
        expect(warns[0]?.data?.path).toBe(path);
      });
    });

    test("AC-5: a sync state missing a field resolves the defaults with one warn", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        // Valid JSON, but not a whole sync state: reading it as one would lose the cursor.
        await writeFixture(join(project, "sync.json"), JSON.stringify({ provider: "local" }));
        const logger = makeLogger();
        const store = createMemoryStore({ projectDir: project, logger });

        expect(await store.readSyncState()).toEqual(DEFAULT_STATE);
        expect(logger.calls.filter((call) => call.level === "warn")).toHaveLength(1);
      });
    });

    test("AC-6: writeSyncState publishes through the atomic write and reads back equal", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const renames = recordRenames();
        const state = syncState();

        await store.writeSyncState(state);

        expect(await store.readSyncState()).toEqual(state);
        expect(renames).toEqual([join(project, "sync.json")]);
      });
    });

    test("AC-6: the written sync state is the store's own state, not a rendered note", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const state = syncState({ provider: null, cursor: { project: null, user: "u2" }, lastError: "unreachable" });

        await store.writeSyncState(state);

        // One JSON object: sync reads it back through JSON.parse, not a line-based codec.
        expect(await jsonLines(join(project, "sync.json"))).toEqual([state]);
      });
    });
  });

  describe("the generated index", () => {
    test("AC-7: writeIndex('project', text) writes MEMORY.md through the atomic write", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const renames = recordRenames();

        await store.writeIndex("project", "# Memory\n");

        expect(await Bun.file(join(project, "MEMORY.md")).text()).toBe("# Memory\n");
        expect(renames).toEqual([join(project, "MEMORY.md")]);
      });
    });

    test("AC-8: writeIndex('user', text) writes the user index when userDir is set", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const user = join(dir, "user");
        const store = createMemoryStore({ projectDir: project, userDir: user, logger: makeLogger() });
        const renames = recordRenames();

        await store.writeIndex("user", "# Memory\n\n## User\n");

        expect(await Bun.file(join(user, "MEMORY.md")).text()).toBe("# Memory\n\n## User\n");
        expect(renames).toEqual([join(user, "MEMORY.md")]);
        // The project index is a separate file: a user-scope write does not touch it.
        expect(existsSync(join(project, "MEMORY.md"))).toBe(false);
      });
    });

    test("AC-8: writeIndex('user', text) without userDir is MEMORY_SCOPE_UNAVAILABLE", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        const renames = recordRenames();

        const error = await caught(store.writeIndex("user", "# Memory\n"));

        assertNaxError(error, "writeIndex of the user index without userDir");
        expect(error).toMatchObject({ code: "MEMORY_SCOPE_UNAVAILABLE", context: { stage: "memory", scope: "user" } });
        // Nothing was staged or created for a scope this store does not have.
        expect(renames).toEqual([]);
        expect(existsSync(project)).toBe(false);
      });
    });
  });

  describe("creating the parent directory", () => {
    test("AC-9: the three writes create the parent directory on demand, through the seam", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const user = join(dir, "user");
        const store = createMemoryStore({ projectDir: project, userDir: user, logger: makeLogger() });
        const made: string[] = [];
        const realMkdir = _memoryStoreDeps.mkdir;
        _memoryStoreDeps.mkdir = async (path, options) => {
          made.push(path);
          return realMkdir(path, options);
        };

        await store.writeDecisions([decision()]);
        await store.writeSyncState(syncState());
        await store.writeIndex("project", "# Memory\n");
        await store.writeIndex("user", "# Memory\n");

        expect(made).toEqual([project, project, project, user]);
        expect(existsSync(join(project, "decisions.jsonl"))).toBe(true);
        expect(existsSync(join(project, "sync.json"))).toBe(true);
        expect(existsSync(join(project, "MEMORY.md"))).toBe(true);
        expect(existsSync(join(user, "MEMORY.md"))).toBe(true);
      });
    });
  });

  describe("the package entry", () => {
    test("AC-10: a MemorySyncState typed from the package entry round-trips with per-scope cursors", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });
        // The annotation is the assertion: `MemorySyncState` must be exported from the entry.
        const state: MemorySyncState = syncState({ cursor: { project: "page-1", user: null } });

        await store.writeSyncState(state);
        const read: MemorySyncState = await store.readSyncState();

        expect(read).toEqual(state);
        expect(read.cursor).toEqual({ project: "page-1", user: null });
      });
    });
  });

  describe("a record file replaced by a link", () => {
    test("F1: readDecisions of a mirror linked outside the store is MEMORY_PATH_OUTSIDE", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const outside = join(dir, "outside-decisions.jsonl");
        // A decision the reader would happily decode: only the link's destination decides.
        await writeFixture(outside, `${JSON.stringify(decision())}\n`);
        await mkdir(project, { recursive: true });
        await symlink(outside, join(project, "decisions.jsonl"));
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

        const error = await caught(store.readDecisions());

        assertNaxError(error, "readDecisions of a mirror linked outside the store");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory", scope: "project" } });
      });
    });

    test("F1: readSyncState of a sync state linked outside the store is MEMORY_PATH_OUTSIDE", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const outside = join(dir, "outside-sync.json");
        await writeFixture(outside, `${JSON.stringify(syncState())}\n`);
        await mkdir(project, { recursive: true });
        await symlink(outside, join(project, "sync.json"));
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

        const error = await caught(store.readSyncState());

        assertNaxError(error, "readSyncState of a sync state linked outside the store");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory", scope: "project" } });
      });
    });

    test("F1: a record file swapped for an outside link inside the read is refused", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const outside = join(dir, "outside-decisions.jsonl");
        const kept = decision();
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
        await store.writeDecisions([kept]);
        await writeFixture(outside, `${JSON.stringify(decision({ id: "leaked" }))}\n`);
        const realOpen = _memoryStoreDeps.open;
        // The swap happens *inside* the read: the path the store checked now names a link.
        _memoryStoreDeps.open = async (target, flags) => {
          await unlink(target);
          await symlink(outside, target);
          return realOpen(target, flags);
        };

        const error = await caught(store.readDecisions());

        assertNaxError(error, "readDecisions of a mirror linked outside after the check");
        expect(error).toMatchObject({ code: "MEMORY_PATH_OUTSIDE", context: { stage: "memory", scope: "project" } });
      });
    });

    test("a record file linked to another file inside the store is read", async () => {
      await withTempDir(async (dir) => {
        const project = projectPath(dir);
        const kept = decision();
        const mirror = join(project, "mirror-decisions.jsonl");
        await writeFixture(mirror, `${JSON.stringify(kept)}\n`);
        await symlink(mirror, join(project, "decisions.jsonl"));
        const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

        // Confinement is about where the bytes live, not about refusing every link.
        expect(await store.readDecisions()).toEqual([kept]);
      });
    });
  });
});
